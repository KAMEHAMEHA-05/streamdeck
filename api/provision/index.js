// api/provision/index.js
export const config = { runtime: "edge" };

const CF = "https://api.cloudflare.com/client/v4";

async function cfApi(apiToken, method, url, body) {
  const headers = {
    "Authorization": `Bearer ${apiToken}`,
    ...(body ? { "Content-Type": "application/json" } : {})
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const json = await res.json();
  if (!json.success) {
    throw new Error(JSON.stringify(json.errors));
  }
  return json.result;
}

function buildMultipart(boundary, parts) {
  let body = "";

  for (const p of parts) {
    body += `--${boundary}\r\n`;
    body += `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`;
    body += `Content-Type: ${p.type}\r\n\r\n`;
    body += p.content + "\r\n";
  }

  body += `--${boundary}--`;

  return body;
}

export default async function handler(req) {
  try {
    const { accountId, apiToken } = await req.json();
    if (!accountId || !apiToken) {
      return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400 });
    }

    const bucketName = "streamdeck-media";
    const dbName = "streamdeck-db";
    const workerName = "streamdeck-worker";

    // ----------------------------------
    // 1. CREATE R2 BUCKET
    // ----------------------------------
    await cfApi(apiToken, "PUT",
      `${CF}/accounts/${accountId}/r2/buckets/${bucketName}`
    );

    // ----------------------------------
    // 2. CREATE D1 DATABASE
    // ----------------------------------
    const d1 = await cfApi(apiToken, "POST",
      `${CF}/accounts/${accountId}/d1/database`,
      { name: dbName }
    );
    const d1Id = d1.uuid;

    // ----------------------------------
    // 3. LOAD WORKER CODE
    // ----------------------------------
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;

    const workerFile = await fetch(`${origin}/streamdeck-worker.js`);
    const workerCode = await workerFile.text();

    // ----------------------------------
    // 4. DEPLOY WORKER WITH MIGRATION
    // ----------------------------------
    const boundary = "----streamdeckBoundary" + Math.random();

    const metadata = JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2024-01-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { name: "MEDIA_BUCKET", type: "r2_bucket", bucket_name: bucketName },
        { name: "DB", type: "d1", id: d1Id }
      ],
      migrations: {
        new_tag: "v1",
        new_sqlite_classes: ["PartyDO"]
      }
    });

    const uploadBody = buildMultipart(boundary, [
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
        content: workerCode
      }
    ]);

    const uploadRes = await fetch(
      `${CF}/accounts/${accountId}/workers/scripts/${workerName}`,
      {
        method: "PUT",
        headers: {
          "Authorization": `Bearer ${apiToken}`,
          "Content-Type": `multipart/form-data; boundary=${boundary}`
        },
        body: uploadBody
      }
    );

    const uploadJson = await uploadRes.json();
    if (!uploadJson.success) throw new Error(JSON.stringify(uploadJson.errors));

    return new Response(
      JSON.stringify({
        success: true,
        workerUrl: `https://${workerName}.${accountId}.workers.dev`,
        bucketName,
        dbName,
        d1Id
      }),
      { status: 200 }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}