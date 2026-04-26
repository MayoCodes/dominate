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
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.players = new Map(); // id -> { ws, name, isHost }
    this.hostId = null;
    this.state = { map: 'world', turn: 0, territories: {}, bots: 0, maxPlayers: 32 };
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const playerId = crypto.randomUUID();

    const isFirstPlayer = this.players.size === 0;
    if (isFirstPlayer) this.hostId = playerId;

    server.accept();
    this.players.set(playerId, { ws: server, name: 'Unknown', isHost: isFirstPlayer });

    server.addEventListener('message', evt => {
      try { this.handleMessage(playerId, JSON.parse(evt.data)); }
      catch(e) { console.error(e); }
    });

    server.addEventListener('close', () => {
      const p = this.players.get(playerId);
      const name = p?.name;
      this.players.delete(playerId);

      // Transfer host if needed
      if (playerId === this.hostId && this.players.size > 0) {
        const newHostId = this.players.keys().next().value;
        this.hostId = newHostId;
        this.players.get(newHostId).isHost = true;
        this.broadcast({ type: 'hostTransfer', newHostId });
      }

      this.broadcast({ type: 'playerLeft', id: playerId, name });
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  handleMessage(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return;

    switch (msg.type) {

      case 'join':
        // Lobby sends: { type:'join', username, isHost, settings:{ map, maxPlayers, bots } }
        player.name = msg.username || 'Unknown';
        if (msg.settings) {
          this.state.map        = msg.settings.map        ?? this.state.map;
          this.state.bots       = msg.settings.bots       ?? this.state.bots;
          this.state.maxPlayers = msg.settings.maxPlayers ?? this.state.maxPlayers;
        }

        // welcome — sent only to this player
        player.ws.send(JSON.stringify({
          type:   'welcome',
          id:     playerId,
          isHost: player.isHost,
        }));

        // full player list to everyone
        this.broadcast({
          type:    'playerList',
          players: this.getPlayerList(),
        });

        // notify others this player joined
        this.broadcastExcept(playerId, {
          type:   'playerJoined',
          player: { id: playerId, name: player.name, isHost: player.isHost },
        });
        break;

      case 'start':
        if (playerId !== this.hostId) return;
        this.broadcast({
          type:     'gameStart',
          settings: this.state,
          players:  this.getPlayerList(),
        });
        break;

      case 'ping':
        player.ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
        break;

      case 'leave':
        player.ws.close(1000, 'left');
        break;

      case 'claim_territory':
        this.state.territories[msg.territory] = playerId;
        this.broadcast({ type: 'territory_claimed', territory: msg.territory, playerId });
        break;

      case 'end_turn':
        this.state.turn++;
        this.broadcast({ type: 'turn_change', turn: this.state.turn, playerId });
        break;

      default:
        this.broadcast({ ...msg, from: playerId });
    }
  }

  getPlayerList() {
    return [...this.players.entries()].map(([id, p]) => ({
      id,
      name:   p.name,
      isHost: p.isHost,
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