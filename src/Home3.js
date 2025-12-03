//workers/streamdeck-worker.js

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

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Party WebSocket route
    if (url.pathname.startsWith("/party/")) {
      const id = url.pathname.split("/")[2];
      const stub = env.PARTY.get(env.PARTY.idFromName(id));
      return stub.fetch(request);
    }

    // Upload from Google Drive
    if (url.pathname === "/api/upload-gdrive" && request.method === "POST") {
      try {
        const { gdriveLink } = await request.json();
        
        // Extract file/folder ID from Google Drive link
        const fileId = extractGDriveId(gdriveLink);
        if (!fileId) {
          return jsonResponse({ error: "Invalid Google Drive link" }, 400, corsHeaders);
        }

        // Check if it's a folder or file
        const isFolder = gdriveLink.includes("/folders/");
        
        if (isFolder) {
          // Handle folder (requires API key)
          const apiKey = env.GDRIVE_API_KEY || "";
          const folderName = await downloadGDriveFolder(fileId, env.MEDIA_BUCKET, apiKey);
          return jsonResponse({ success: true, folder: folderName }, 200, corsHeaders);
        } else {
          // Handle single file
          const apiKey = env.GDRIVE_API_KEY || "";
          const fileName = await downloadGDriveFile(fileId, env.MEDIA_BUCKET, "", apiKey);
          return jsonResponse({ success: true, file: fileName }, 200, corsHeaders);
        }
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // List folders in R2
    if (url.pathname === "/api/folders") {
      try {
        const listed = await env.MEDIA_BUCKET.list({ delimiter: "/" });
        const folders = listed.delimitedPrefixes.map(p => p.replace("/", ""));
        return jsonResponse({ folders }, 200, corsHeaders);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // Get files from a specific folder
    if (url.pathname.startsWith("/api/folder/")) {
      try {
        const folderName = decodeURIComponent(url.pathname.split("/api/folder/")[1]);
        const listed = await env.MEDIA_BUCKET.list({ prefix: `${folderName}/` });
        
        const files = listed.objects.map(obj => obj.key);
        
        // Find video and subtitle files
        const videoFile = files.find(k => 
          /\.(mp4|mkv|mov|avi|webm|mp3|m4v)$/i.test(k)
        );
        
        const subtitleFile = files.find(k => /\.vtt$/i.test(k));
        
        const response = {
          videoUrl: videoFile ? `/media/${videoFile}` : null,
          subtitleUrl: subtitleFile ? `/media/${subtitleFile}` : null,
        };
        
        return jsonResponse(response, 200, corsHeaders);
      } catch (err) {
        return jsonResponse({ error: err.message }, 500, corsHeaders);
      }
    }

    // Serve media files from R2
    if (url.pathname.startsWith("/media/")) {
      try {
        const key = url.pathname.replace("/media/", "");
        const object = await env.MEDIA_BUCKET.get(key);
        
        if (!object) {
          return new Response("File not found", { status: 404 });
        }

        const headers = {
          ...corsHeaders,
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000",
        };

        return new Response(object.body, { headers });
      } catch (err) {
        return new Response("Error: " + err.message, { status: 500 });
      }
    }

    return new Response("StreamDeck Worker Active", { headers: corsHeaders });
  }
};

// Helper functions

function extractGDriveId(url) {
  // Extract file/folder ID from various Google Drive URL formats
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/folders\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /^([a-zA-Z0-9_-]+)$/  // Direct ID
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  return null;
}

async function downloadGDriveFile(fileId, bucket, folderPrefix = "", apiKey = "") {
  // Make file publicly accessible temporarily or use API key
  // Try direct download first (works for publicly shared files)
  const directUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  
  try {
    // Get file metadata using API key if provided
    let fileName = `file_${fileId}`;
    let mimeType = "application/octet-stream";
    
    if (apiKey) {
      const metaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&key=${apiKey}`;
      const metaRes = await fetch(metaUrl);
      
      if (metaRes.ok) {
        const metadata = await metaRes.json();
        fileName = metadata.name;
        mimeType = metadata.mimeType;
      }
    }
    
    // Try to download the file
    const fileRes = await fetch(directUrl, {
      redirect: "follow"
    });
    
    if (!fileRes.ok) {
      throw new Error(`Failed to download file: ${fileRes.status}`);
    }
    
    // Check if we got HTML (Google Drive warning page)
    const contentType = fileRes.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      // Try alternative method for large files
      const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;
      const retryRes = await fetch(confirmUrl, { redirect: "follow" });
      
      if (!retryRes.ok) {
        throw new Error("File requires authentication or is not publicly accessible");
      }
      
      // Upload to R2
      const key = folderPrefix ? `${folderPrefix}/${fileName}` : fileName;
      await bucket.put(key, retryRes.body, {
        httpMetadata: { contentType: mimeType }
      });
    } else {
      // Upload to R2
      const key = folderPrefix ? `${folderPrefix}/${fileName}` : fileName;
      await bucket.put(key, fileRes.body, {
        httpMetadata: { contentType: mimeType }
      });
    }
    
    return fileName;
  } catch (err) {
    throw new Error(`Download failed: ${err.message}. Make sure the file is publicly shared.`);
  }
}

async function downloadGDriveFolder(folderId, bucket, apiKey = "") {
  // Get folder name
  let folderName = `folder_${folderId}`;
  
  if (apiKey) {
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=name&key=${apiKey}`;
    const metaRes = await fetch(metaUrl);
    
    if (metaRes.ok) {
      const metadata = await metaRes.json();
      folderName = metadata.name;
    }
  }
  
  // List all files in the folder (requires API key)
  if (!apiKey) {
    throw new Error("API key required for folder downloads. Please set GDRIVE_API_KEY in worker environment.");
  }
  
  const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&fields=files(id,name,mimeType)&key=${apiKey}`;
  const listRes = await fetch(listUrl);
  
  if (!listRes.ok) {
    throw new Error("Failed to list folder contents. Make sure folder is publicly shared.");
  }
  
  const listData = await listRes.json();
  const files = listData.files || [];
  
  // Download each file
  for (const file of files) {
    if (file.mimeType !== "application/vnd.google-apps.folder") {
      try {
        await downloadGDriveFile(file.id, bucket, folderName, apiKey);
      } catch (err) {
        console.error(`Failed to download ${file.name}:`, err);
      }
    }
  }
  
  return folderName;
}

function jsonResponse(data, status = 200, additionalHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...additionalHeaders
    }
  });
}