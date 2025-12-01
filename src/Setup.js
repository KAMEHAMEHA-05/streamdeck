import { useState } from "react";

const API_BASE = process.env.REACT_APP_API_BASE;

export default function Setup() {
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [output, setOutput] = useState("");

  async function submit(e) {
    e.preventDefault();

    const res = await fetch(`${API_BASE}/api/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, apiToken })
    });

    const data = await res.json();
    setOutput(JSON.stringify(data, null, 2));
  }

  return (
    <div style={{ padding: 40, fontFamily: "sans-serif", color: "#eee", background: "#111", minHeight: "100vh" }}>
      <h1>StreamDeck Cloudflare Setup</h1>

      <form onSubmit={submit} style={{ maxWidth: 400 }}>
        <label>Cloudflare Account ID</label>
        <input
          style={{ width: "100%", padding: 10, marginBottom: 20 }}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />

        <label>API Token</label>
        <input
          style={{ width: "100%", padding: 10, marginBottom: 20 }}
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
        />

        <button style={{ padding: 12, width: "100%", background: "gold", border: 0 }}>
          Deploy Backend
        </button>
      </form>

      <pre style={{ marginTop: 40, background: "#222", padding: 20 }}>
        {output}
      </pre>
    </div>
  );
}
