// workers/streamdeck-worker.js

// ------------------------------
// Durable Object for playback sync
// ------------------------------

const encoder = new TextEncoder()

function b64(x) {
  return btoa(x).replace(/=+$/, "")
}

function unb64(x) {
  return atob(x)
}

async function signJWT(payload, env, ttl) {
  const header = { alg: "HS256", typ: "JWT" }
  const now = Math.floor(Date.now() / 1000)

  payload.iat = now
  payload.exp = now + ttl

  const base =
    b64(JSON.stringify(header)) + "." +
    b64(JSON.stringify(payload))

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )

  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(base))
  return base + "." + b64(String.fromCharCode(...new Uint8Array(sig)))
}

async function verifyJWT(token, env) {
  const [h, p, s] = token.split(".")
  const base = h + "." + p

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )

  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(unb64(s), c => c.charCodeAt(0)),
    encoder.encode(base)
  )

  if (!ok) throw "bad signature"

  const payload = JSON.parse(unb64(p))
  if (payload.exp < Date.now()/1000) throw "expired"

  return payload
}


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
      if (s !== except) {
        try {
          s.send(msg);
        } catch (err) {
          console.error("Broadcast error:", err);
        }
      }
    }
  }

  async fetch(request) {
    if (!this.initialized) {
      this.initialized = true;
      await this.init();
    }

    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.sessions.push(server);

    // Send current state immediately to new connection
    try {
      server.send(JSON.stringify(this.stateData));
    } catch (err) {
      console.error("Error sending initial state:", err);
    }

    server.addEventListener("message", async evt => {
      try {
        const data = JSON.parse(evt.data);
        Object.assign(this.stateData, data);
        await this.persist();
        this.broadcast(server);
      } catch (err) {
        console.error("Message error:", err);
      }
    });

    server.addEventListener("close", () => {
      this.sessions = this.sessions.filter(s => s !== server);
    });

    server.addEventListener("error", err => {
      console.error("WebSocket error:", err);
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ------------------------------
// Constants
// ------------------------------
const MAX_BUCKET_SIZE = 10 * 1024 * 1024 * 1024; // 10GB
const MAX_FILE_SIZE = 10 * 1024 * 1024 * 1024; // 2GB per file (reasonable for streaming)

// ------------------------------
// Utilities
// ------------------------------

async function requireRole(req, env, role) {
  const auth = req.headers.get("Authorization")
  if (!auth || !auth.startsWith("Bearer ")) throw "missing token"

  const jwt = auth.slice(7)
  const user = await verifyJWT(jwt, env)

  if (user.role !== role) throw "forbidden"
  return user
}

async function enforceQuota(bucket, maxBytes, additionalSize = 0) {
  let total = additionalSize;
  const items = [];
  let cursor;

  // Paginate through bucket list
  do {
    const listed = await bucket.list({ limit: 1000, cursor });
    for (const obj of listed.objects) {
      items.push(obj);
      total += obj.size;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  if (total <= maxBytes) {
    return { success: true, deletedCount: 0, freedSpace: 0 };
  }

  // Sort by upload time (oldest first)
  items.sort((a, b) => a.uploaded.getTime() - b.uploaded.getTime());

  let deletedCount = 0;
  let freedSpace = 0;

  for (const obj of items) {
    if (total <= maxBytes) break;
    await bucket.delete(obj.key);
    total -= obj.size;
    freedSpace += obj.size;
    deletedCount++;
  }

  return { success: true, deletedCount, freedSpace };
}

function extractFileId(url) {
  const patterns = [
    /\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /^([a-zA-Z0-9_-]{25,})$/ // Direct file ID
  ];
  
  for (const pattern of patterns) {
    const m = url.match(pattern);
    if (m) return m[1];
  }
  return null;
}

function extractFolderId(url) {
  const patterns = [
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/
  ];
  
  for (const pattern of patterns) {
    const m = url.match(pattern);
    if (m) return m[1];
  }
  return null;
}

async function fetchWithRetry(url, retries = 3, headers = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers });
      
      if (res.ok) return res;
      
      // Rate limited - exponential backoff
      if (res.status === 429) {
        const delay = Math.pow(2, i) * 1000;
        console.log(`Rate limited, waiting ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      
      // Other errors
      const errorText = await res.text();
      throw new Error(`HTTP ${res.status}: ${errorText}`);
      
    } catch (err) {
      if (i === retries - 1) throw err;
      
      const delay = Math.pow(2, i) * 1000;
      console.log(`Request failed, retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  
  throw new Error("Max retries exceeded");
}

// ------------------------------
// Download from Google Drive (no API key needed for public links)
// ------------------------------
async function downloadFromGoogleDrive(link, apiKey = null) {
  const fileId = extractFileId(link);
  const folderId = extractFolderId(link);

  if (fileId) {
    // For public files, we can use direct download without API key
    let downloadUrl;
    let metaUrl;
    
    if (apiKey) {
      // With API key - get metadata first
      metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,size,mimeType&key=${apiKey}`;
      downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`;
    } else {
      // Without API key - direct download for public files
      downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    }
    
    // Try to get metadata if we have API key
    let name = `file_${fileId}`;
    let size = 0;
    let mimeType = "application/octet-stream";
    
    if (apiKey && metaUrl) {
      try {
        const metaRes = await fetchWithRetry(metaUrl);
        if (metaRes.ok) {
          const meta = await metaRes.json();
          name = meta.name || name;
          size = parseInt(meta.size, 10) || 0;
          mimeType = meta.mimeType || mimeType;
          
          // Validate file size if we know it
          if (size > MAX_FILE_SIZE) {
            throw new Error(
              `File too large: ${(size / 1024 / 1024).toFixed(2)}MB ` +
              `(max ${MAX_FILE_SIZE / 1024 / 1024}MB)`
            );
          }
        }
      } catch (err) {
        console.log("Could not fetch metadata, will try direct download:", err.message);
      }
    }

    return [{
      name,
      url: downloadUrl,
      size,
      mimeType
    }];
  }

  if (folderId) {
    if (!apiKey) {
      throw new Error("Google Drive API key required for folder downloads. Set it via POST /kv/GoogleDrive");
    }
    
    const listUrl = 
      `https://www.googleapis.com/drive/v3/files?` +
      `q='${folderId}'+in+parents+and+trashed=false&` +
      `key=${apiKey}&` +
      `fields=files(id,name,size,mimeType)&` +
      `pageSize=1000`;
    
    const res = await fetchWithRetry(listUrl);
    const json = await res.json();
    
    if (!json.files || json.files.length === 0) {
      throw new Error("No files found in folder or folder is not shared properly");
    }

    // Filter and map files
    const files = json.files
      .filter(f => {
        const size = parseInt(f.size, 10);
        return size > 0 && size <= MAX_FILE_SIZE;
      })
      .map(f => ({
        name: f.name,
        url: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media&key=${apiKey}`,
        size: parseInt(f.size, 10),
        mimeType: f.mimeType
      }));

    if (files.length === 0) {
      throw new Error("No valid files found in folder (all too large or empty)");
    }

    return files;
  }

  throw new Error("Invalid Google Drive link. Use file or folder share links.");
}

// ------------------------------
// CORS headers
// ------------------------------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

// ------------------------------
// Main Worker
// ------------------------------
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { 
        status: 204,
        headers: corsHeaders 
      });
    }

    try {

      if (url.pathname === "/login" && req.method === "POST") {
        const { access_key } = await req.json()

        if (access_key !== env.ACCESS_KEY) {
          return new Response("Unauthorized", { status: 401 })
        }

        const token = await signJWT(
          { role: "admin", perms: ["all"] },
          env,
          1800
        )

        return new Response(JSON.stringify({ token }), {
          headers: { "Content-Type": "application/json" }
        })
      }
      // ==========================================
      // Durable Object Route (WebSocket sync)
      // ==========================================

      if (url.pathname.startsWith("/party/")) {
        const roomId = url.pathname.split("/")[2];
        if (!roomId) {
          return new Response(
            JSON.stringify({ error: "Missing room ID" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        const stub = env.PARTY.get(env.PARTY.idFromName(roomId));
        return stub.fetch(req);
      }

      // ==========================================
      // KV Read
      // ==========================================
      if (url.pathname.startsWith("/kv/") && req.method === "GET") {
        const key = url.pathname.slice(4); // Remove "/kv/"
        try {
          await requireRole(req, env, "admin")
        } catch {
          return new Response("Unauthorized", { status: 401 })
        }

      //   const body = await req.json();
      //   const { access_key } = body;
      
      //   if (access_key != await env.KV.get("access_key")){
      //     return new Response(
      //       JSON.stringify({ error: "Access key is incorrect" }),
      //       { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      //     );
      //   }else{
        
      //     if (!key) {
      //       return new Response(
      //         JSON.stringify({ error: "Missing key" }),
      //         { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      //       );
      //     }
          
      //     const val = await env.KV.get(key);
          
      //     return new Response(val || "", { 
      //       headers: { ...corsHeaders, "Content-Type": "text/plain" }
      //     });
      //   }
      // }

      if (!key) {
        return new Response(
          JSON.stringify({ error: "Missing key" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      const val = await env.KV.get(key);
      
      return new Response(val || "", { 
        headers: { ...corsHeaders, "Content-Type": "text/plain" }
      });

    }

      // ==========================================
      // KV Write
      // ==========================================
      if (url.pathname.startsWith("/kv/") && req.method === "POST") {
        const key = url.pathname.slice(4);
        try {
          await requireRole(req, env, "admin")
        } catch {
          return new Response("Unauthorized", { status: 401 })
        }
        const body = await req.json();
        const { value } = body;

        // if (access_key != await env.KV.get("access_key")){
        //   return new Response(
        //     JSON.stringify({ error: "Access key is incorrect" }),
        //     { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }else{

        //   if (!key) {
        //     return new Response(
        //       JSON.stringify({ error: "Missing key" }),
        //       { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //     );
        //   }
          
        //   await env.KV.put(key, value);
          
        //   return new Response(
        //     JSON.stringify({ success: true, key }),
        //     { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }

        if (!key) {
          return new Response(
            JSON.stringify({ error: "Missing key" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        await env.KV.put(key, value);
        
        return new Response(
          JSON.stringify({ success: true, key }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
        
      }

      // ==========================================
      // KV Delete
      // ==========================================
      if (url.pathname.startsWith("/kv/") && req.method === "DELETE") {
        const key = url.pathname.slice(4);
        try {
          await requireRole(req, env, "admin")
        } catch {
          return new Response("Unauthorized", { status: 401 })
        }
        // const body = await req.json();
        // const { access_key } = body;
        
        // if (access_key != await env.KV.get("access_key")){
        //   return new Response(
        //     JSON.stringify({ error: "Access key is incorrect" }),
        //     { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }else{
        //   if (!key) {
        //     return new Response(
        //       JSON.stringify({ error: "Missing key" }),
        //       { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //     );
        //   }
          
        //   await env.KV.delete(key);
          
        //   return new Response(
        //     JSON.stringify({ success: true, key }),
        //     { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }

        if (!key) {
          return new Response(
            JSON.stringify({ error: "Missing key" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        await env.KV.delete(key);
        
        return new Response(
          JSON.stringify({ success: true, key }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      }

      // ==========================================
      // Upload from Google Drive
      // ==========================================
      if (url.pathname === "/upload" && req.method === "POST") {
        try {
          await requireRole(req, env, "admin")
        } catch {
          return new Response("Unauthorized", { status: 401 })
        }
        const body = await req.json();
        const { storage_type, link } = body;

        // if (access_key != await env.KV.get("access_key")){
        //   return new Response(
        //     JSON.stringify({ error: "Access key is incorrect" }),
        //     { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }else{

        //   if (!storage_type || !link) {
        //     return new Response(
        //       JSON.stringify({ error: "Missing storage_type or link" }),
        //       { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //     );
        //   }

        //   // Get API key from KV (optional for single file downloads)
        //   const apiKey = await env.KV.get(storage_type);

        //   // Get R2 public URL from KV
        //   const publicUrl = await env.KV.get("R2_PUBLIC_URL");
        //   if (!publicUrl) {
        //     return new Response(
        //       JSON.stringify({ 
        //         error: "R2_PUBLIC_URL not configured",
        //         hint: "This should be set during provisioning"
        //       }),
        //       { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //     );
        //   }

        //   let files;

        //   // Only Google Drive supported for now
        //   if (storage_type === "GoogleDrive") {
        //     files = await downloadFromGoogleDrive(link, apiKey);
        //   } else {
        //     return new Response(
        //       JSON.stringify({ error: `Unsupported storage type: ${storage_type}` }),
        //       { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //     );
        //   }

        //   // Calculate total size
        //   const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

        //   // Check and enforce quota BEFORE downloading
        //   const quotaResult = await enforceQuota(env.MEDIA, MAX_BUCKET_SIZE, totalSize);

        //   const uploaded = [];
        //   const errors = [];

        //   // Download and upload each file
        //   for (const f of files) {
        //     try {
        //       console.log(`Downloading ${f.name} (${(f.size / 1024 / 1024).toFixed(2)}MB)...`);
              
        //       // Stream download from Google Drive
        //       const dataRes = await fetchWithRetry(f.url);
              
        //       if (!dataRes.ok) {
        //         errors.push({ 
        //           name: f.name, 
        //           error: `Download failed: ${dataRes.status} ${dataRes.statusText}` 
        //         });
        //         continue;
        //       }

        //       // Stream upload to R2 (no memory buffering!)
        //       await env.MEDIA.put(f.name, dataRes.body, {
        //         httpMetadata: {
        //           contentType: f.mimeType || "application/octet-stream"
        //         }
        //       });

        //       console.log(`✓ Uploaded ${f.name}`);

        //       uploaded.push({
        //         name: f.name,
        //         url: `${publicUrl}/${encodeURIComponent(f.name)}`,
        //         size: f.size,
        //         mimeType: f.mimeType
        //       });

        //     } catch (err) {
        //       console.error(`Error uploading ${f.name}:`, err);
        //       errors.push({ 
        //         name: f.name, 
        //         error: err.message 
        //       });
        //     }
        //   }

        //   return new Response(
        //     JSON.stringify({
        //       success: true,
        //       files: uploaded,
        //       errors: errors.length > 0 ? errors : undefined,
        //       quota: {
        //         deletedFiles: quotaResult.deletedCount,
        //         freedSpaceMB: (quotaResult.freedSpace / 1024 / 1024).toFixed(2),
        //         uploadedSizeMB: (totalSize / 1024 / 1024).toFixed(2)
        //       }
        //     }),
        //     { 
        //       status: 200,
        //       headers: { ...corsHeaders, "Content-Type": "application/json" }
        //     }
        //   );
        // }

        if (!storage_type || !link) {
          return new Response(
            JSON.stringify({ error: "Missing storage_type or link" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Get API key from KV (optional for single file downloads)
        const apiKey = await env.KV.get(storage_type);

        // Get R2 public URL from KV
        const publicUrl = await env.KV.get("R2_PUBLIC_URL");
        if (!publicUrl) {
          return new Response(
            JSON.stringify({ 
              error: "R2_PUBLIC_URL not configured",
              hint: "This should be set during provisioning"
            }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        let files;

        // Only Google Drive supported for now
        if (storage_type === "GoogleDrive") {
          files = await downloadFromGoogleDrive(link, apiKey);
        } else {
          return new Response(
            JSON.stringify({ error: `Unsupported storage type: ${storage_type}` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // Calculate total size
        const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

        // Check and enforce quota BEFORE downloading
        const quotaResult = await enforceQuota(env.MEDIA, MAX_BUCKET_SIZE, totalSize);

        const uploaded = [];
        const errors = [];

        // Download and upload each file
        for (const f of files) {
          try {
            console.log(`Downloading ${f.name} (${(f.size / 1024 / 1024).toFixed(2)}MB)...`);
            
            // Stream download from Google Drive
            const dataRes = await fetchWithRetry(f.url);
            
            if (!dataRes.ok) {
              errors.push({ 
                name: f.name, 
                error: `Download failed: ${dataRes.status} ${dataRes.statusText}` 
              });
              continue;
            }

            // Stream upload to R2 (no memory buffering!)
            await env.MEDIA.put(f.name, dataRes.body, {
              httpMetadata: {
                contentType: f.mimeType || "application/octet-stream"
              }
            });

            console.log(`✓ Uploaded ${f.name}`);

            uploaded.push({
              name: f.name,
              url: `${publicUrl}/${encodeURIComponent(f.name)}`,
              size: f.size,
              mimeType: f.mimeType
            });

          } catch (err) {
            console.error(`Error uploading ${f.name}:`, err);
            errors.push({ 
              name: f.name, 
              error: err.message 
            });
          }
        }

        return new Response(
          JSON.stringify({
            success: true,
            files: uploaded,
            errors: errors.length > 0 ? errors : undefined,
            quota: {
              deletedFiles: quotaResult.deletedCount,
              freedSpaceMB: (quotaResult.freedSpace / 1024 / 1024).toFixed(2),
              uploadedSizeMB: (totalSize / 1024 / 1024).toFixed(2)
            }
          }),
          { 
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }

      // ==========================================
      // Debug endpoint
      // ==========================================
      if (url.pathname === "/debug" && req.method === "GET") {
        const r2PublicUrl = await env.KV.get("R2_PUBLIC_URL");
        try {
          await requireRole(req, env, "admin")
        } catch {
          return new Response("Unauthorized", { status: 401 })
        }
        // const body = await req.json();

        // const { access_key } = body;

        // if (access_key != await env.KV.get("access_key")){
        //   return new Response(
        //     JSON.stringify({ error: "Access key is incorrect" }),
        //     { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }else{
        
        //   // List first few files
        //   const listed = await env.MEDIA.list({ limit: 10 });
        //   const files = listed.objects.map(obj => ({
        //     key: obj.key,
        //     size: obj.size
        //   }));
          
        //   return new Response(
        //     JSON.stringify({
        //       workerUrl: url.origin,
        //       r2PublicUrl,
        //       filesInBucket: files,
        //       requestedPath: url.pathname,
        //       requestedHost: url.host
        //     }, null, 2),
        //     { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }

        const listed = await env.MEDIA.list({ limit: 10 });
        const files = listed.objects.map(obj => ({
          key: obj.key,
          size: obj.size
        }));
        
        return new Response(
          JSON.stringify({
            workerUrl: url.origin,
            r2PublicUrl,
            filesInBucket: files,
            requestedPath: url.pathname,
            requestedHost: url.host
          }, null, 2),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      }

      // ==========================================
      // Serve media files from R2
      // ==========================================
      if (url.pathname.startsWith("/media/") && req.method === "GET") {
        const filename = decodeURIComponent(url.pathname.slice(7)); // Remove "/media/"
        
        if (!filename) {
          return new Response(
            JSON.stringify({ error: "Missing filename" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        console.log(`Fetching file: ${filename}`);

        const obj = await env.MEDIA.get(filename);
        
        if (!obj) {
          console.log(`File not found: ${filename}`);
          return new Response(
            JSON.stringify({ error: "File not found", filename }),
            { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        console.log(`File found: ${filename}, size: ${obj.size}, type: ${obj.httpMetadata?.contentType}`);

        // Determine content type
        let contentType = obj.httpMetadata?.contentType || "application/octet-stream";
        
        // Force correct content type for common video formats
        if (filename.endsWith('.mp4')) contentType = "video/mp4";
        else if (filename.endsWith('.webm')) contentType = "video/webm";
        else if (filename.endsWith('.mov')) contentType = "video/quicktime";
        else if (filename.endsWith('.avi')) contentType = "video/x-msvideo";

        // Support range requests for video streaming
        const range = req.headers.get("Range");
        if (range) {
          console.log(`Range request: ${range}`);
          
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : obj.size - 1;
          
          // Validate range
          if (isNaN(start) || start < 0 || start >= obj.size) {
            return new Response("Invalid range", {
              status: 416,
              headers: {
                ...corsHeaders,
                "Content-Range": `bytes */${obj.size}`
              }
            });
          }

          // Ensure end is within bounds
          const validEnd = Math.min(end, obj.size - 1);
          const chunkSize = validEnd - start + 1;

          // Fetch the specific range from R2
          const rangedObj = await env.MEDIA.get(filename, {
            range: { offset: start, length: chunkSize }
          });

          if (!rangedObj) {
            return new Response("Range not satisfiable", { status: 416, headers: corsHeaders });
          }

          const headers = {
            ...corsHeaders,
            "Content-Type": contentType,
            "Content-Range": `bytes ${start}-${validEnd}/${obj.size}`,
            "Content-Length": chunkSize.toString(),
            "Accept-Ranges": "bytes",
            "Cache-Control": "public, max-age=3600"
          };

          return new Response(rangedObj.body, {
            status: 206, // Partial Content
            headers
          });
        }

        // Full file request
        const headers = {
          ...corsHeaders,
          "Content-Type": contentType,
          "Content-Length": obj.size.toString(),
          "Cache-Control": "public, max-age=31536000, immutable",
          "Accept-Ranges": "bytes"
        };

        console.log(`Serving full file: ${filename}`);
        return new Response(obj.body, { headers });
      }

      // ==========================================
      // List uploaded files
      // ==========================================
      if (url.pathname === "/files" && req.method === "GET") {
        const publicUrl = await env.KV.get("R2_PUBLIC_URL");
        try {
          await requireRole(req, env, "admin")
        } catch {
          return new Response("Unauthorized", { status: 401 })
        }
        // const body = await req.json();

        // const { access_key } = body;

        // if (access_key != await env.KV.get("access_key")){
        //   return new Response(
        //     JSON.stringify({ error: "Access key is incorrect" }),
        //     { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }else{
        
        //   if (!publicUrl) {
        //     return new Response(
        //       JSON.stringify({ error: "R2_PUBLIC_URL not configured" }),
        //       { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //     );
        //   }
          
        //   const files = [];
        //   let cursor;
          
        //   do {
        //     const listed = await env.MEDIA.list({ limit: 1000, cursor });
            
        //     for (const obj of listed.objects) {
        //       files.push({
        //         name: obj.key,
        //         url: `${publicUrl}/${encodeURIComponent(obj.key)}`,
        //         size: obj.size,
        //         uploaded: obj.uploaded.toISOString()
        //       });
        //     }
            
        //     cursor = listed.truncated ? listed.cursor : undefined;
        //   } while (cursor);

        //   return new Response(
        //     JSON.stringify({
        //       success: true,
        //       count: files.length,
        //       files,
        //       totalSizeMB: (files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(2)
        //     }),
        //     { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }

        if (!publicUrl) {
          return new Response(
            JSON.stringify({ error: "R2_PUBLIC_URL not configured" }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        const files = [];
        let cursor;
        
        do {
          const listed = await env.MEDIA.list({ limit: 1000, cursor });
          
          for (const obj of listed.objects) {
            files.push({
              name: obj.key,
              url: `${publicUrl}/${encodeURIComponent(obj.key)}`,
              size: obj.size,
              uploaded: obj.uploaded.toISOString()
            });
          }
          
          cursor = listed.truncated ? listed.cursor : undefined;
        } while (cursor);

        return new Response(
          JSON.stringify({
            success: true,
            count: files.length,
            files,
            totalSizeMB: (files.reduce((sum, f) => sum + f.size, 0) / 1024 / 1024).toFixed(2)
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      }

      // ==========================================
      // Delete file from R2
      // ==========================================
      if (url.pathname.startsWith("/files/") && req.method === "DELETE") {
        const filename = decodeURIComponent(url.pathname.slice(7));
        try {
          await requireRole(req, env, "admin")
        } catch {
          return new Response("Unauthorized", { status: 401 })
        }
        // const body = await req.json();

        // const { access_key } = body;

        // if (access_key != await env.KV.get("access_key")){
        //   return new Response(
        //     JSON.stringify({ error: "Access key is incorrect" }),
        //     { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }else{
        
        //   if (!filename) {
        //     return new Response(
        //       JSON.stringify({ error: "Missing filename" }),
        //       { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //     );
        //   }

        //   await env.MEDIA.delete(filename);

        //   return new Response(
        //     JSON.stringify({ 
        //       success: true, 
        //       deleted: filename 
        //     }),
        //     { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        //   );
        // }

        if (!filename) {
          return new Response(
            JSON.stringify({ error: "Missing filename" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        await env.MEDIA.delete(filename);

        return new Response(
          JSON.stringify({ 
            success: true, 
            deleted: filename 
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );

      }

      // ==========================================
      // Health check
      // ==========================================
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response(
          JSON.stringify({
            status: "ok",
            service: "StreamDeck Worker",
            timestamp: new Date().toISOString(),
            endpoints: {
              upload: "POST /upload",
              files: "GET /files",
              deleteFile: "DELETE /files/{filename}",
              kvGet: "GET /kv/{key}",
              kvSet: "POST /kv/{key}",
              kvDelete: "DELETE /kv/{key}",
              party: "WS /party/{roomId}"
            }
          }),
          { 
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          }
        );
      }

      // ==========================================
      // 404 for unknown routes
      // ==========================================
      return new Response(
        JSON.stringify({ 
          error: "Not found",
          path: url.pathname
        }),
        { 
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );

    } catch (err) {
      console.error("Worker error:", err);
      
      return new Response(
        JSON.stringify({ 
          error: err.message,
          stack: process.env.NODE_ENV === "development" ? err.stack : undefined
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        }
      );
    }
  }
};