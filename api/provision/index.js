// api/provision/index.js
export const config = {
  runtime: "edge"
};

const CF = "https://api.cloudflare.com/client/v4";

async function cfApi(apiToken, method, url, body) {
  const headers = {
    "Authorization": `Bearer ${apiToken}`,
    "Content-Type": "application/json"
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
    const doNamespaceName = "streamdeck-party";
    const workerName = "streamdeck-worker";

    // ----------------------------------
    // 1. CREATE R2 BUCKET
    // ----------------------------------
    await cfApi(
      apiToken,
      "PUT",
      `${CF}/accounts/${accountId}/r2/buckets/${bucketName}`
    );

    // ----------------------------------
    // 2. CREATE D1 DATABASE
    // ----------------------------------
    const d1Result = await cfApi(
      apiToken,
      "POST",
      `${CF}/accounts/${accountId}/d1/database`,
      { name: dbName }
    );

    const d1Id = d1Result.uuid;

    // ----------------------------------
    // 3. CREATE DURABLE OBJECT NAMESPACE
    // ----------------------------------
    const doResult = await cfApi(
      apiToken,
      "POST",
      `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`,
      {
        name: doNamespaceName,
        class: "PartyDO"
      }
    );

    const doNamespaceId = doResult.id;

    // ----------------------------------
    // 4. LOAD WORKER CODE
    // ----------------------------------
    const workerCodeFile = await fetch(
      `${req.nextUrl.origin}/workers/streamdeck-worker.js`
    );

    const workerCode = await workerCodeFile.text();

    // ----------------------------------
    // 5. DEPLOY WORKER WITH BINDINGS
    // ----------------------------------

    const metadata = {
      main_module: "worker.js",
      bindings: [
        {
          name: "MEDIA_BUCKET",
          type: "r2_bucket",
          bucket_name: bucketName
        },
        {
          name: "DB",
          type: "d1",
          id: d1Id
        },
        {
          name: "PARTY",
          type: "durable_object_namespace",
          namespace_id: doNamespaceId
        }
      ]
    };

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
    form.append(
      "script",
      new Blob([workerCode], { type: "application/javascript" }),
      "worker.js"
    );

    const deployRes = await fetch(
      `${CF}/accounts/${accountId}/workers/scripts/${workerName}`,
      {
        method: "PUT",
        headers: { "Authorization": `Bearer ${apiToken}` },
        body: form
      }
    );

    const deployJson = await deployRes.json();

    if (!deployJson.success) {
      throw new Error(JSON.stringify(deployJson.errors));
    }

    const workerUrl = `https://${workerName}.${accountId}.workers.dev`;

    return new Response(
      JSON.stringify({
        success: true,
        workerUrl,
        bucketName,
        dbName,
        d1Id,
        doNamespaceId
      }),
      { status: 200 }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500 }
    );
  }
}
