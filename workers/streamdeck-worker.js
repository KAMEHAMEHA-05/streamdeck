export class PartyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.stateData = {
      timestamp: 0,
      paused: true
    };
  }

  async fetch(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    this.sessions.push(server);

    server.addEventListener("message", (msg) => {
      const data = JSON.parse(msg.data);
      Object.assign(this.stateData, data);

      for (const s of this.sessions) {
        if (s !== server) {
          s.send(JSON.stringify(this.stateData));
        }
      }
    });

    server.addEventListener("close", () => {
      this.sessions = this.sessions.filter((x) => x !== server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/party/")) {
      const id = url.pathname.split("/")[2];
      const stub = env.PARTY.get(env.PARTY.idFromName(id));
      return stub.fetch(request);
    }

    return new Response("StreamDeck Worker Active");
  }
};
