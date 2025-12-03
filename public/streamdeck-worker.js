// workers/streamdeck-worker.js

// ------------------------------
// Durable Object for playback sync
// ------------------------------
export class PartyDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.stateData = {
      mainUrl: "",
      subUrl: "",
      timestamp: 0,
      paused: true,
      queue: []
    };
    this.initialized = false;
  }

  async init() {
    const saved = await this.state.storage.get("state");
    if (saved) Object.assign(this.stateData, saved);
  }

  async persist() {
    await this.state.storage.put("state", this.stateData);
  }

  broadcast(except) {
    const msg = JSON.stringify(this.stateData);
    for (const s of this.sessions) {
      if (s !== except) s.send(msg);
    }
  }

  async fetch(request) {
    if (!this.initialized) {
      this.initialized = true;
      await this.init();
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.sessions.push(server);

    server.addEventListener("message", async evt => {
      const data = JSON.parse(evt.data);
      Object.assign(this.stateData, data);
      await this.persist();
      this.broadcast(server);
    });

    server.addEventListener("close", () => {
      this.sessions = this.sessions.filter(s => s !== server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ------------------------------
// Utilities
// ------------------------------
async function enforceQuota(bucket, maxBytes) {
  let total = 0;
  const items = [];

  for await (const obj of bucket.list()) {
    items.push(obj);
    total += obj.size;
  }

  if (total <= maxBytes) return;

  items.sort((a, b) => a.uploaded - b.uploaded);

  for (const obj of items) {
    if (total <= maxBytes) break;
    await bucket.delete(obj.key);
    total -= obj.size;
  }
}

// Extract file ID from Google Drive link
function extractFileId(url) {
  const m = url.match(/\/d\/([^/]+)/);
  if (m) return m[1];
  return null;
}

// Extract folder ID from drive link
function extractFolderId(url) {
  const m = url.match(/\/folders\/([^/]+)/);
  if (m) return m[1];
  return null;
}

// ------------------------------
// Download from Google Drive using API key from KV
// ------------------------------
async function downloadFromGoogleDrive(apiKey, link) {
  const fileId = extractFileId(link);
  const folderId = extractFolderId(link);

  if (fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    return [{ name: `${fileId}`, url }];
  }

  if (folderId) {
    const listUrl =
      `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&key=${apiKey}&fields=files(id,name)`;

    const res = await fetch(listUrl);
    const json = await res.json();

    return json.files.map(f => ({
      name: f.name,
      url: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${apiKey}`
    }));
  }

  throw new Error("Unrecognized Google Drive link");
}

// ------------------------------
// Main Worker
// ------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // DO route
    if (url.pathname.startsWith("/party/")) {
      const id = url.pathname.split("/")[2];
      const stub = env.PARTY.get(env.PARTY.idFromName(id));
      return stub.fetch(req);
    }

    // KV read
    if (url.pathname.startsWith("/kv/") && req.method === "GET") {
      const key = url.pathname.split("/")[2];
      const val = await env.KV.get(key);
      return new Response(val || "");
    }

    // KV write
    if (url.pathname.startsWith("/kv/") && req.method === "POST") {
      const key = url.pathname.split("/")[2];
      const body = await req.text();
      await env.KV.put(key, body);
      return new Response("OK");
    }

    // Upload from remote storage
    if (url.pathname === "/upload" && req.method === "POST") {
      const body = await req.json();
      const { storage_type, link } = body;

      if (!storage_type || !link)
        return new Response("Missing storage_type or link", { status: 400 });

      const apiKey = await env.KV.get(storage_type);
      if (!apiKey)
        return new Response("Unknown storage type", { status: 400 });

      let files;

      if (storage_type === "GoogleDrive") {
        files = await downloadFromGoogleDrive(apiKey, link);
      } else {
        return new Response("Unsupported storage type", { status: 400 });
      }

      const maxBytes = 10 * 1024 * 1024 * 1024;
      const out = [];

      for (const f of files) {
        const dataRes = await fetch(f.url);
        const dataBuf = await dataRes.arrayBuffer();

        await enforceQuota(env.MEDIA, maxBytes);

        await env.MEDIA.put(f.name, dataBuf);

        out.push({
          name: f.name,
          url: `https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${f.name}`
        });
      }

      return new Response(JSON.stringify({ files: out }));
    }

    return new Response("Worker active");
  }
};
