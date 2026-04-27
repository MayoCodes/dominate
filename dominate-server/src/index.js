// ── ROUTER WORKER ──
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    const match = url.pathname.match(/^\/room\/([a-zA-Z0-9_-]+)$/);
    if (!match) return new Response('Not found', { status: 404 });

    const roomId = match[1];
    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);
    return stub.fetch(request);
  }
};

// ── DURABLE OBJECT ──
// No tick loop — purely event-driven.
// Clients run the troop formula locally (100ms ticks, deterministic).
// Server only acts when territory ownership changes.
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    this.players   = new Map(); // playerId → { ws, name, isHost, color, lastTroops, lastSync, workerRatio }
    this.hostId    = null;
    this.gamePhase = 'placement'; // 'placement' | 'game' | 'ended'

    // Authoritative territory ownership: countryId → playerId
    this.territories = {};

    // Active attacks: attackId → { attackerId, territory, troops, startedAt, defenderId }
    this.attacks  = new Map();
    this._atkCtr  = 0;

    this.settings = { map: 'world', maxPlayers: 32 };
  }

  // ── Troop formula — MUST match client exactly ──────────────────────────────
  static troopGain(current, max) {
    if (current >= max) return 0;
    return (10 + Math.pow(current, 0.73) / 4) * (1 - current / max);
  }
  static maxTroops(terrCount) {
    return Math.max(1000, terrCount * 100);
  }

  // Estimate a player's current troops by fast-forwarding the formula
  // from their last sync point. Used for loose anti-cheat on attacks.
  _estimateTroops(playerId) {
    const p = this.players.get(playerId);
    if (!p) return 0;
    const terrCount = Object.values(this.territories).filter(o => o === playerId).length;
    const max       = GameRoom.maxTroops(terrCount);
    const ticks     = Math.min((Date.now() - p.lastSync) / 100, 600); // cap 60s
    let troops = p.lastTroops ?? 50;
    for (let i = 0; i < ticks; i++) {
      troops = Math.min(troops + GameRoom.troopGain(troops, max), max);
    }
    return troops;
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const playerId = crypto.randomUUID();
    const isFirst  = this.players.size === 0;
    if (isFirst) this.hostId = playerId;

    server.accept();
    this.players.set(playerId, {
      ws: server, name: 'Unknown', isHost: isFirst,
      color: '#7EC8E3', lastTroops: 50, lastSync: Date.now(), workerRatio: 0.2,
    });

    server.addEventListener('message', evt => {
      try { this.handle(playerId, JSON.parse(evt.data)); }
      catch (e) { console.error(e); }
    });
    server.addEventListener('close', () => this.onLeave(playerId));

    return new Response(null, { status: 101, webSocket: client });
  }

  onLeave(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    const name = p.name;

    for (const [tid, owner] of Object.entries(this.territories)) {
      if (owner === playerId) delete this.territories[tid];
    }
    for (const [aid, atk] of this.attacks) {
      if (atk.attackerId === playerId) this.attacks.delete(aid);
    }

    this.players.delete(playerId);

    if (playerId === this.hostId && this.players.size > 0) {
      const newHost = this.players.keys().next().value;
      this.hostId = newHost;
      this.players.get(newHost).isHost = true;
      this.broadcast({ type: 'hostTransfer', newHostId: newHost });
    }

    this.broadcast({ type: 'playerLeft', id: playerId, name });
  }

  // ── Message handler ───────────────────────────────────────────────────────
  handle(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return;

    switch (msg.type) {

      // ── JOIN ──────────────────────────────────────────────────────────────
      case 'join': {
        player.name  = msg.username || 'Unknown';
        player.color = msg.color    || '#7EC8E3';
        if (msg.settings) {
          this.settings.map        = msg.settings.map        ?? this.settings.map;
          this.settings.maxPlayers = msg.settings.maxPlayers ?? this.settings.maxPlayers;
        }

        // Send full room state to this player
        player.ws.send(JSON.stringify({
          type: 'welcome',
          id: playerId,
          isHost: player.isHost,
          phase: this.gamePhase,
          territories: this.territories,
          players: this._playerList(),
        }));

        this.broadcastExcept(playerId, {
          type: 'playerJoined',
          player: { id: playerId, name: player.name, color: player.color, isHost: player.isHost },
        });
        break;
      }

      // ── PLACE DOT ────────────────────────────────────────────────────────
      case 'place_dot': {
        const { geo, countryId, seedTiles } = msg;   // ← add seedTiles here
        if (countryId !== undefined) {
          const prev = this.territories[countryId];
          if (!prev) {
            this.territories[countryId] = playerId;
          }
        }
        player.lastTroops = 50;
        player.lastSync   = Date.now();

        this.broadcast({ type: 'dot_placed', playerId, geo, countryId: countryId ?? null, seedTiles: seedTiles ?? [] });
        // ↑ forward seedTiles so receiving clients don't need to re-seed from geo
        break;
      }

      // ── TROOP SYNC ────────────────────────────────────────────────────────
      // Clients send this every ~5 seconds so the server can estimate troops
      // for attack validation without running its own loop.
      case 'troop_sync': {
        player.lastTroops    = Math.max(0, msg.troops   ?? player.lastTroops);
        player.lastSync      = Date.now();
        player.workerRatio   = msg.workerRatio ?? player.workerRatio;
        break;
      }

      // ── ATTACK ───────────────────────────────────────────────────────────
      case 'attack': {
        if (this.gamePhase !== 'game') break;

        const territory     = +msg.territory;
        const committedTroops = Math.max(1, Math.floor(msg.troops ?? 0));

        // Already theirs?
        if (this.territories[territory] === playerId) break;

        // Loose anti-cheat: committed troops can't exceed server estimate + buffer
        const estimate = this._estimateTroops(playerId);
        if (committedTroops > estimate * 1.05 + 500) {
          console.warn(`[suspicious] ${player.name}: committed ${committedTroops}, estimated ${Math.floor(estimate)}`);
          break;
        }

        const attackId  = ++this._atkCtr;
        const defenderId = this.territories[territory] || null;

        this.attacks.set(attackId, {
          attackId, attackerId: playerId,
          territory, troops: committedTroops,
          defenderId, startedAt: Date.now(),
        });

        // Debit from server record
        player.lastTroops = Math.max(0, (player.lastTroops ?? 0) - committedTroops);
        player.lastSync   = Date.now();

        this.broadcast({
          type: 'attack_start',
          attackId, attackerId: playerId,
          territory, troops: committedTroops, defenderId,
        });
        break;
      }

      // ── ATTACK RESOLVED ───────────────────────────────────────────────────
      // Client simulates the combat tick-by-tick and reports when the territory
      // flips. Server validates a minimum plausible time has elapsed, then
      // records the capture and broadcasts to all.
      case 'attack_resolved': {
        const atk = this.attacks.get(msg.attackId);
        if (!atk || atk.attackerId !== playerId) break;

        const elapsed = Date.now() - atk.startedAt;
        if (elapsed < 200) break; // reject suspiciously instant captures

        const { territory } = atk;
        const prev = this.territories[territory];
        this.territories[territory] = playerId;
        this.attacks.delete(msg.attackId);

        this.broadcast({
          type: 'territory_captured',
          territory, attackerId: playerId,
          defenderId: prev || null, attackId: msg.attackId,
        });

        // Win check: 80% of all currently-owned tiles
        this._checkWin(playerId, player.name);
        break;
      }

      // ── RETREAT ──────────────────────────────────────────────────────────
      case 'retreat': {
        const atk = this.attacks.get(msg.attackId);
        if (!atk || atk.attackerId !== playerId) break;

        const returned = Math.floor(atk.troops * 0.75); // 25% lost
        player.lastTroops = (player.lastTroops ?? 0) + returned;
        player.lastSync   = Date.now();
        this.attacks.delete(msg.attackId);

        this.broadcast({ type: 'attack_end', attackId: msg.attackId, retreated: true });
        player.ws.send(JSON.stringify({ type: 'retreat_result', returned, attackId: msg.attackId }));
        break;
      }

      // ── ENCLOSURE ────────────────────────────────────────────────────────
      // Client detects a fully-surrounded territory and reports it.
      // Server grants it (instant, no troop cost) and broadcasts.
      case 'claim_enclosure': {
        if (this.gamePhase !== 'game') break;
        const granted = [];

        for (const rawTid of (msg.territories ?? [])) {
          const tid = +rawTid;
          if (this.territories[tid] === playerId) continue; // already ours
          this.territories[tid] = playerId;
          granted.push(tid);
        }

        if (granted.length > 0) {
          this.broadcast({ type: 'enclosure_claimed', playerId, territories: granted });
          this._checkWin(playerId, player.name);
        }
        break;
      }

      // ── PHASE CHANGE ─────────────────────────────────────────────────────
      case 'phase_change': {
        if (playerId !== this.hostId) break;
        if (msg.phase === 'game' && this.gamePhase === 'placement') {
          this.gamePhase = 'game';
          this.broadcast({ type: 'phase_change', phase: 'game' });
        }
        break;
      }

      // ── WORKER RATIO (no server logic, just stored for estimation) ────────
      case 'set_worker_ratio':
        player.workerRatio = Math.min(1, Math.max(0, msg.ratio ?? 0.2));
        break;

      case 'ping':
        player.ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        break;

      case 'leave':
        player.ws.close(1000, 'left');
        break;

      default:
        // Relay (chat, emotes, etc.)
        this.broadcastExcept(playerId, { ...msg, from: playerId });
    }
  }

  _checkWin(playerId, playerName) {
    if (this.gamePhase !== 'game') return;
    const total  = Object.keys(this.territories).length;
    if (total < 10) return; // not enough territory claimed yet to declare a winner
    const myCount = Object.values(this.territories).filter(o => o === playerId).length;
    if (myCount / total >= 0.80) {
      this.gamePhase = 'ended';
      this.broadcast({ type: 'game_over', winnerId: playerId, winnerName: playerName });
    }
  }

  _playerList() {
    return [...this.players.entries()].map(([id, p]) => ({
      id, name: p.name, isHost: p.isHost, color: p.color,
    }));
  }

  broadcast(data) {
    const json = JSON.stringify(data);
    for (const [id, p] of this.players) {
      try { p.ws.send(json); }
      catch { this.players.delete(id); }
    }
  }

  broadcastExcept(excludeId, data) {
    const json = JSON.stringify(data);
    for (const [id, p] of this.players) {
      if (id === excludeId) continue;
      try { p.ws.send(json); }
      catch { this.players.delete(id); }
    }
  }
}