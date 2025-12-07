// api/provision/index.js
export const config = { runtime: "edge" };

const CF = "https://api.cloudflare.com/client/v4";

/* ---------------------------------------------
   BASIC CF HELPERS
--------------------------------------------- */

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

/* ---------------------------------------------
   NAME-CONFLICT RESOLVER
--------------------------------------------- */

async function findAvailableName(existingListFn, baseName, extractName) {
  const list = await existingListFn();
  const names = list.map(extractName);

  if (!names.includes(baseName)) return baseName;

  let suffix = 1;
  while (names.includes(`${baseName}${suffix}`)) {
    suffix++;
  }
  return `${baseName}${suffix}`;
}

/* ---------------------------------------------
   MAIN HANDLER
--------------------------------------------- */

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

    console.log("Starting provisioning...");

    /* ---------------------------------------------
       STEP 0: Generate non-conflicting names
    --------------------------------------------- */

    const bucketName = await findAvailableName(
      async () => await cf(apiToken, "GET", `${CF}/accounts/${accountId}/r2/buckets`),
      "streamdeck-media",
      (b) => b.name
    );

    const kvName = await findAvailableName(
      async () => await cf(apiToken, "GET", `${CF}/accounts/${accountId}/storage/kv/namespaces`),
      "streamdeck-kv",
      (ns) => ns.title
    );

    const workerName = await findAvailableName(
      async () => await cf(apiToken, "GET", `${CF}/accounts/${accountId}/workers/scripts`),
      "streamdeck-worker",
      (s) => s.id
    );

    const doNamespaceName = await findAvailableName(
      async () => await cf(apiToken, "GET", `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`),
      "PARTY",
      (ns) => ns.name
    );

    const doClass = "PartyDO";

    /* ---------------------------------------------
       STEP 1: Create R2 bucket
    --------------------------------------------- */
    console.log("Creating R2 bucket:", bucketName);

    try {
      await cf(apiToken, "POST",
        `${CF}/accounts/${accountId}/r2/buckets`,
        { name: bucketName, locationHint: "auto" }
      );
    } catch (err) {
      if (!err.message.includes("already exists")) throw err;
    }


    /* ---------------------------------------------
       STEP 2: Create KV namespace
    --------------------------------------------- */
    console.log("Creating KV namespace:", kvName);

    let kvId;
    try {
      const kv = await cf(apiToken, "POST",
        `${CF}/accounts/${accountId}/storage/kv/namespaces`,
        { title: kvName }
      );
      kvId = kv.id;
    } catch {
      const namespaces = await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/storage/kv/namespaces`);
      kvId = namespaces.find(ns => ns.title === kvName).id;
    }

    /* ---------------------------------------------
       STEP 3: Store access token in KV
    --------------------------------------------- */
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

    /* ---------------------------------------------
       STEP 4: Load worker source
    --------------------------------------------- */
    console.log("Loading worker source...");
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const workerSource = await fetch(`${origin}/streamdeck-worker.js`).then(r => r.text());

    /* ---------------------------------------------
       STEP 5: Deploy worker without DO binding
    --------------------------------------------- */
    console.log("Deploying worker (initial):", workerName);

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

    /* ---------------------------------------------
       STEP 6: Create Durable Object namespace
    --------------------------------------------- */
    console.log("Creating DO namespace:", doNamespaceName);

    let doId;
    try {
      const doResult = await cf(apiToken, "POST",
        `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`,
        {
          name: doNamespaceName,
          script_name: workerName,
          class_name: doClass
        }
      );
      doId = doResult.id;
    } catch {
      const list = await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/workers/durable_objects/namespaces`);
      doId = list.find(n => n.name === doNamespaceName).id;
    }

    /* ---------------------------------------------
       STEP 7: Re-deploy worker with DO binding
    --------------------------------------------- */
    console.log("Redeploying worker with DO binding...");

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

    /* ---------------------------------------------
       STEP 8: Ensure workers.dev subdomain
    --------------------------------------------- */

    const preferred = userEmail.split("@")[0];
    let subdomain;

    try {
      subdomain = (await cf(apiToken, "GET",
        `${CF}/accounts/${accountId}/workers/subdomain`)).subdomain;
    } catch {}

    if (!subdomain) {
      try {
        subdomain = (await cf(apiToken, "PUT",
          `${CF}/accounts/${accountId}/workers/subdomain?subdomain=${preferred}`
        )).subdomain;
      } catch {
        const fallback = `cf-${Math.random().toString(36).slice(2, 8)}`;
        subdomain = (await cf(apiToken, "PUT",
          `${CF}/accounts/${accountId}/workers/subdomain?subdomain=${fallback}`
        )).subdomain;
      }
    }

    console.log("Using subdomain:", subdomain);

    const workerUrl = `https://${workerName}.${subdomain}.workers.dev`;
    const mediaUrl = `${workerUrl}/media`;

    /* ---------------------------------------------
       SUCCESS
    --------------------------------------------- */
    return new Response(
      JSON.stringify({
        success: true,
        workerUrl,
        mediaUrl,
        names: {
          bucketName,
          kvName,
          workerName,
          doNamespaceName
        },
        ids: {
          kvId,
          doId
        }
      }, null, 2),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    console.error(err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
