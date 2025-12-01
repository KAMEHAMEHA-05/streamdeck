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

export default async function handler(req) {
  try {
    const { accountId, apiToken } = await req.json();
    if (!accountId || !apiToken) {
      return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400 });
    }

    const bucketName = "streamdeck-media";
    const dbName = "streamdeck-db";
    const workerName = "streamdeck-worker";
    const doNamespaceName = "streamdeck-party";

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
    const workerFile = await fetch(`${req.nextUrl.origin}/workers/streamdeck-worker.js`);
    const workerCode = await workerFile.text();

    // ----------------------------------
    // 4. FIRST DEPLOY (WITHOUT BINDINGS)
    // ----------------------------------
    const form1 = new FormData();
    form1.append("metadata", new Blob([
      JSON.stringify({ main_module: "worker.js" })
    ], { type: "application/json" }), "metadata.json");

    form1.append("script", new Blob([workerCode], {
      type: "application/javascript"
    }), "worker.js");

    const up1 = await fetch(
      `${CF}/accounts/${accountId}/workers/scripts/${workerName}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${apiToken}` },
        body: form1
      }
    );
    const up1Json = await up1.json();
    if (!up1Json.success) throw new Error(JSON.stringify(up1Json.errors));

    // ----------------------------------
    // 5. NOW CREATE DURABLE OBJECT NAMESPACE
    // ----------------------------------
    const doNS = await cfApi(apiToken, "POST",
      `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`,
      {
        name: doNamespaceName,
        script: workerName,
        class_name: "PartyDO"
      }
    );

    const doNamespaceId = doNS.id;

    // ----------------------------------
    // 6. REDEPLOY WORKER WITH BINDINGS
    // ----------------------------------
    const metadata = {
      main_module: "worker.js",
      bindings: [
        { name: "MEDIA_BUCKET", type: "r2_bucket", bucket_name: bucketName },
        { name: "DB", type: "d1", id: d1Id },
        { name: "PARTY", type: "durable_object_namespace", namespace_id: doNamespaceId }
      ]
    };

    const form2 = new FormData();
    form2.append("metadata", new Blob([
      JSON.stringify(metadata)
    ], { type: "application/json" }), "metadata.json");

    form2.append("script", new Blob([workerCode], {
      type: "application/javascript"
    }), "worker.js");

    const up2 = await fetch(
      `${CF}/accounts/${accountId}/workers/scripts/${workerName}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${apiToken}` },
        body: form2
      }
    );
    const up2Json = await up2.json();
    if (!up2Json.success) throw new Error(JSON.stringify(up2Json.errors));

    return new Response(
      JSON.stringify({
        success: true,
        workerUrl: `https://${workerName}.${accountId}.workers.dev`,
        bucketName,
        dbName,
        d1Id,
        doNamespaceId
      }),
      { status: 200 }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
