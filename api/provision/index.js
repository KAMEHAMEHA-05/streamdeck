// api/provision/index.js
export const config = { runtime: "edge" };

const CF = "https://api.cloudflare.com/client/v4";

async function cf(apiToken, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  
  const json = await res.json();
  if (!json.success) {
    throw new Error(`CF API Error: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

function multipart(boundary, parts) {
  let out = "";
  for (const p of parts) {
    out += `--${boundary}\r\n`;
    out += `Content-Disposition: form-data; name="${p.name}"`;
    if (p.filename) out += `; filename="${p.filename}"`;
    out += `\r\n`;
    out += `Content-Type: ${p.type}\r\n\r\n`;
    out += p.content + "\r\n";
  }
  out += `--${boundary}--`;
  return out;
}

async function deployWorker(apiToken, accountId, workerName, workerSource, metadata) {
  const boundary = "----streamdeckBoundary" + Math.random().toString(36);
  const body = multipart(boundary, [
    {
      name: "metadata",
      filename: "metadata.json",
      type: "application/json",
      content: metadata
    },
    {
      name: "worker.js",
      filename: "worker.js",
      type: "application/javascript+module",
      content: workerSource
    }
  ]);

  const res = await fetch(
    `${CF}/accounts/${accountId}/workers/scripts/${workerName}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`
      },
      body
    }
  );

  const json = await res.json();
  if (!json.success) {
    throw new Error(`Worker deployment failed: ${JSON.stringify(json.errors)}`);
  }
  return json.result;
}

export default async function handler(req) {
  try {
    const { accountId, apiToken } = await req.json();
    
    if (!accountId || !apiToken) {
      return new Response(
        JSON.stringify({ error: "Missing accountId or apiToken" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const bucketName = "streamdeck-media";
    const workerName = "streamdeck-worker";
    const kvName = "streamdeck-kv";
    const doClass = "PartyDO";

    console.log("Starting provisioning...");

    // ==========================================
    // STEP 1: Create R2 Bucket (public)
    // ==========================================
    console.log("Creating R2 bucket...");
    
    try {
      await cf(apiToken, "POST",
        `${CF}/accounts/${accountId}/r2/buckets`,
        { name: bucketName }
      );
    } catch (err) {
      // Bucket might already exist, that's okay
      if (!err.message.includes("already exists")) throw err;
    }

    // Enable public access
    await cf(apiToken, "PUT",
      `${CF}/accounts/${accountId}/r2/buckets/${bucketName}/public`,
      { enabled: true }
    );

    // Get bucket info to retrieve public URL
    const bucketInfo = await cf(apiToken, "GET",
      `${CF}/accounts/${accountId}/r2/buckets/${bucketName}`
    );

    const publicUrl = bucketInfo.public_url || `https://pub-${bucketName}.r2.dev`;

    // ==========================================
    // STEP 2: Create KV Namespace
    // ==========================================
    console.log("Creating KV namespace...");
    
    let kvId;
    try {
      const kv = await cf(apiToken, "POST",
        `${CF}/accounts/${accountId}/storage/kv/namespaces`,
        { title: kvName }
      );
      kvId = kv.id;
    } catch (err) {
      // If exists, get existing ID
      const namespaces = await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/storage/kv/namespaces`
      );
      const existing = namespaces.find(ns => ns.title === kvName);
      if (!existing) throw err;
      kvId = existing.id;
    }

    // ==========================================
    // STEP 3: Load Worker Source
    // ==========================================
    console.log("Loading worker source...");
    
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const workerSource = await fetch(`${origin}/streamdeck-worker.js`)
      .then(r => {
        if (!r.ok) throw new Error("Failed to load worker source");
        return r.text();
      });

    // ==========================================
    // STEP 4: Deploy Worker (without DO binding)
    // ==========================================
    console.log("Deploying worker (initial)...");
    
    const metadata1 = JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2024-01-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { name: "MEDIA", type: "r2_bucket", bucket_name: bucketName },
        { name: "KV", type: "kv_namespace", namespace_id: kvId }
      ]
    });

    await deployWorker(apiToken, accountId, workerName, workerSource, metadata1);

    // ==========================================
    // STEP 5: Create Durable Object Namespace
    // ==========================================
    console.log("Creating Durable Object namespace...");
    
    let doId;
    try {
      const doResult = await cf(apiToken, "POST",
        `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`,
        {
          name: "PARTY",
          script_name: workerName,
          class_name: doClass
        }
      );
      doId = doResult.id;
    } catch (err) {
      // If exists, get existing ID
      const namespaces = await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`
      );
      const existing = namespaces.find(ns => ns.class === doClass);
      if (!existing) throw err;
      doId = existing.id;
    }

    // ==========================================
    // STEP 6: Re-deploy Worker (with DO binding)
    // ==========================================
    console.log("Re-deploying worker with DO binding...");
    
    const metadata2 = JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2024-01-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { name: "MEDIA", type: "r2_bucket", bucket_name: bucketName },
        { name: "KV", type: "kv_namespace", namespace_id: kvId },
        { name: "PARTY", type: "durable_object_namespace", namespace_id: doId }
      ]
    });

    await deployWorker(apiToken, accountId, workerName, workerSource, metadata2);

    // ==========================================
    // STEP 7: Store R2 Public URL in KV
    // ==========================================
    console.log("Storing R2 public URL in KV...");
    
    await fetch(
      `${CF}/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/R2_PUBLIC_URL`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "text/plain"
        },
        body: publicUrl
      }
    );

    // ==========================================
    // SUCCESS
    // ==========================================
    const workerUrl = `https://${workerName}.${accountId}.workers.dev`;

    console.log("Provisioning complete!");

    return new Response(
      JSON.stringify({
        success: true,
        workerUrl,
        publicUrl,
        bucketName,
        kvNamespaceId: kvId,
        doNamespaceId: doId,
        instructions: [
          "1. Store your Google Drive API key:",
          `   curl -X POST ${workerUrl}/kv/GoogleDrive -d "YOUR_API_KEY"`,
          "",
          "2. Upload files:",
          `   curl -X POST ${workerUrl}/upload -H "Content-Type: application/json" -d '{"storage_type":"GoogleDrive","link":"YOUR_DRIVE_LINK"}'`,
          "",
          "3. Connect to sync party:",
          `   ws://${workerUrl.replace('https://', '')}/party/ROOM_NAME`
        ].join("\n")
      }, null, 2),
      { 
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );

  } catch (err) {
    console.error("Provisioning error:", err);
    
    return new Response(
      JSON.stringify({
        error: err.message,
        stack: err.stack
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}