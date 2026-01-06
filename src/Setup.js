import { useState } from "react";

const API_BASE = process.env.REACT_APP_API_BASE;

export default function Setup() {
  const [accountId, setAccountId] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [email, setEmail] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [confirmAccessToken, setConfirmAccessToken] = useState("");

  const [error, setError] = useState("");
  const [output, setOutput] = useState("");

  function validateEmail(e) {
    // Simple and reliable email regex
    const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return pattern.test(e);
  }

  async function submit(e) {
    e.preventDefault();
    setError("");

    // ----------------------------
    // Field validations
    // ----------------------------

    if (!accountId.trim()) {
      setError("Account ID is required.");
      return;
    }

    if (!apiToken.trim()) {
      setError("API Token is required.");
      return;
    }

    if (!email.trim()) {
      setError("Email is required.");
      return;
    }

    if (!validateEmail(email)) {
      setError("Invalid email format.");
      return;
    }

    if (!accessToken.trim()) {
      setError("Access token is required.");
      return;
    }

    if (accessToken !== confirmAccessToken) {
      setError("Access tokens do not match.");
      return;
    }

    // ----------------------------
    // Send request
    // ----------------------------

    const res = await fetch(`${API_BASE}/api/provision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accountId,
        apiToken,
        access_token: accessToken,
        userEmail: email
      })
    });

    const data = await res.json();
    setOutput(JSON.stringify(data, null, 2));
  }

  return (
    <div
      style={{
        padding: 40,
        fontFamily: "sans-serif",
        color: "#eee",
        background: "#111",
        minHeight: "100vh"
      }}
    >
      <h1>StreamDeck Cloudflare Setup</h1>

      <form onSubmit={submit} style={{ maxWidth: 400 }}>
        {/* Account ID */}
        <label>Cloudflare Account ID</label>
        <input
          style={{ width: "100%", padding: 10, marginBottom: 20 }}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        />

        {/* API Token */}
        <label>API Token</label>
        <input
          style={{ width: "100%", padding: 10, marginBottom: 20 }}
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
        />

        {/* Email */}
        <label>Email (must match your Cloudflare login)</label>
        <input
          type="email"
          style={{ width: "100%", padding: 10, marginBottom: 20 }}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        {/* Access Token */}
        <label>Access Token</label>
        <input
          type="password"
          style={{ width: "100%", padding: 10, marginBottom: 20 }}
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
        />

        {/* Confirm Access Token */}
        <label>Confirm Access Token</label>
        <input
          type="password"
          style={{ width: "100%", padding: 10, marginBottom: 20 }}
          value={confirmAccessToken}
          onChange={(e) => setConfirmAccessToken(e.target.value)}
        />

        {/* Error Message */}
        {error && (
          <div
            style={{
              background: "#661111",
              padding: 10,
              marginBottom: 20,
              borderRadius: 4
            }}
          >
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          style={{
            padding: 12,
            width: "100%",
            background: "gold",
            border: 0,
            fontWeight: "bold",
            cursor: "pointer"
          }}
        >
          Deploy Backend
        </button>
      </form>

      <pre style={{ marginTop: 40, background: "#222", padding: 20 }}>
        {output}
      </pre>
    </div>
  );
}


