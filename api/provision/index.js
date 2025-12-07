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
    const { accountId, apiToken, access_token, userEmail } = await req.json();

    if (!accountId || !apiToken || !access_token || !userEmail) {
      return new Response(
        JSON.stringify({
          error: "Missing required fields: accountId, apiToken, access_token, userEmail"
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const bucketName = "streamdeck-media";
    const workerName = "streamdeck-worker";
    const kvName = "streamdeck-kv";
    const doClass = "PartyDO";

    console.log("Starting provisioning...");

    // ==========================================
    // STEP 1: Create R2 Bucket
    // ==========================================
    console.log("Creating R2 bucket...");
    try {
      await cf(apiToken, "POST",
        `${CF}/accounts/${accountId}/r2/buckets`,
        { name: bucketName, locationHint: "auto" }
      );
    } catch (err) {
      if (!err.message.includes("already exists")) throw err;
    }

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
      const namespaces = await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/storage/kv/namespaces`
      );
      const existing = namespaces.find(ns => ns.title === kvName);
      if (!existing) throw err;
      kvId = existing.id;
    }

    // ==========================================
    // STEP 3: Store ACCESS TOKEN in KV
    // ==========================================
    console.log("Storing access_token in KV...");
    await fetch(
      `${CF}/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/access_token`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "text/plain"
        },
        body: access_token
      }
    );

    // ==========================================
    // STEP 4: Load Worker Source
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
    // STEP 5: Deploy Worker (no DO binding yet)
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
    // STEP 6: Create Durable Object Namespace
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
      const namespaces = await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`
      );
      const existing = namespaces.find(ns => ns.class === doClass);
      if (!existing) throw err;
      doId = existing.id;
    }

    // ==========================================
    // STEP 7: Redeploy Worker (with DO binding)
    // ==========================================
    console.log("Re-deploying worker with DO binding...");
    const metadata2 = JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2024-01-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { name: "MEDIA", type: "r2_bucket", bucket_name: bucketName },
        { name: "KV", type: "kv_namespace", namespace_id: kvId },
        {
          name: "PARTY",
          type: "durable_object_namespace",
          namespace_id: doId,
          class_name: doClass
        }
      ]
    });

    await deployWorker(apiToken, accountId, workerName, workerSource, metadata2);

    // ==========================================
    // STEP 8: Enable workers.dev SUBDOMAIN
    // ==========================================
    console.log("Ensuring workers.dev subdomain is enabled...");
    const preferred = userEmail.split("@")[0];
    let subdomain;

    try {
      const existing = await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/workers/subdomain`
      );
      subdomain = existing.subdomain;
    } catch (_) {
      // no subdomain yet
    }

    if (!subdomain) {
      try {
        const result = await cf(apiToken, "PUT",
          `${CF}/accounts/${accountId}/workers/subdomain?subdomain=${preferred}`
        );
        subdomain = result.subdomain;
      } catch {
        const fallback = `cf-${Math.random().toString(36).slice(2, 8)}`;
        const result = await cf(apiToken, "PUT",
          `${CF}/accounts/${accountId}/workers/subdomain?subdomain=${fallback}`
        );
        subdomain = result.subdomain;
      }
    }

    console.log("Using subdomain:", subdomain);

    const workerUrl = `https://${workerName}.${subdomain}.workers.dev`;
    const publicUrl = `${workerUrl}/media`;

    // ==========================================
    // SUCCESS RESPONSE
    // ==========================================
    return new Response(
      JSON.stringify({
        success: true,
        workerUrl,
        mediaUrl: publicUrl,
        bucketName,
        kvNamespaceId: kvId,
        doNamespaceId: doId,
        workersDevSubdomain: subdomain,
        setup: {
          step1: "Store your Google Drive API key",
          command1: `curl -X POST ${workerUrl}/kv/GoogleDrive -H "Content-Type: text/plain" -d "YOUR_API_KEY"`,
          step2: "Upload files from Google Drive",
          command2: `curl -X POST ${workerUrl}/upload -H "Content-Type: application/json" -d '{"storage_type":"GoogleDrive","link":"YOUR_DRIVE_LINK"}'`,
          step3: "Files will be accessible at",
          url: `${publicUrl}/YOUR_FILENAME`,
          step4: "Connect to sync party via WebSocket",
          ws: `wss://${workerName}.${subdomain}.workers.dev/party/ROOM_NAME`
        }
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
