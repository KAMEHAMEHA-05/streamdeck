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
  if (!json.success) throw new Error(JSON.stringify(json.errors));
  return json.result;
}

function multipart(boundary, parts) {
  let out = "";
  for (const p of parts) {
    out += `--${boundary}\r\n`;
    out += `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`;
    out += `Content-Type: ${p.type}\r\n\r\n`;
    out += p.content + "\r\n";
  }
  out += `--${boundary}--`;
  return out;
}

export default async function handler(req) {
  try {
    const { accountId, apiToken } = await req.json();
    if (!accountId || !apiToken)
      return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400 });

    const bucketName = "streamdeck-media";
    const workerName = "streamdeck-worker";
    const kvName = "streamdeck-kv";
    const doClass = "PartyDO";

    // 1. R2 BUCKET (public)
    await cf(apiToken, "PUT",
      `${CF}/accounts/${accountId}/r2/buckets/${bucketName}`
    );

    await cf(apiToken, "PATCH",
      `${CF}/accounts/${accountId}/r2/buckets/${bucketName}`,
      { public: true }
    );

    // 2. KV NAMESPACE
    const kv = await cf(apiToken, "POST",
      `${CF}/accounts/${accountId}/storage/kv/namespaces`,
      { title: kvName }
    );
    const kvId = kv.id;

    // 3. DO namespace
    const doResult = await cf(apiToken, "PUT",
      `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`,
      {
        name: "party_namespace",
        class_name: doClass
      }
    );
    const doId = doResult.id;

    // 4. Load Worker source
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const workerSource = await fetch(`${origin}/streamdeck-worker.js`).then(r => r.text());

    // 5. Deploy Worker
    const metadata = JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2024-01-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { name: "MEDIA", type: "r2_bucket", bucket_name: bucketName },
        { name: "KV", type: "kv_namespace", namespace_id: kvId },
        { name: "PARTY", type: "durable_object_namespace", class_name: doClass, namespace_id: doId }
      ]
    });

    const boundary = "----streamdeckBoundary" + Math.random();
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

    const deployRes = await fetch(
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

    const deployJson = await deployRes.json();
    if (!deployJson.success) throw new Error(JSON.stringify(deployJson.errors));

    return new Response(JSON.stringify({
      success: true,
      workerUrl: `https://${workerName}.${accountId}.workers.dev`,
      bucketName,
      kvName,
      doClass,
      doId
    }));

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
