import { useState } from "react";

export default function Login({ onLogin }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    setError("");

    const res = await fetch(process.env.REACT_APP_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });

    const data = await res.json();

    if (data.valid) {
      localStorage.setItem("accessToken", token);
      onLogin();
    } else {
      setError("Invalid token");
    }
  }

  return (
    <>
      <style>
        {`@import url('https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,100..900;1,100..900&display=swap');`}
      </style>
      <div
        style={{
          background: `
            linear-gradient(to right, #1a1a1a 1px, transparent 1px),
            linear-gradient(to bottom, #1a1a1a 1px, transparent 1px),
            #0a0a0a
          `,
          backgroundSize: "60px 60px",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'Montserrat', sans-serif",
        }}
      >
        <div
          style={{
            background: "rgba(255, 255, 255, 0.05)",
            backdropFilter: "blur(10px)",
            border: "1px solid rgba(255, 255, 255, 0.1)",
            borderRadius: 16,
            padding: 40,
            maxWidth: 450,
            width: "100%",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 30 }}>
            <img 
              src="./logo.png" 
              alt="Logo" 
              style={{ width: 48, height: 48, objectFit: "contain" }}
            />
            <h1
              style={{
                margin: 0,
                color: "#fffffeff",
                fontWeight: 600,
                fontSize: 32,
              }}
            >
              Stream Deck
            </h1>
          </div>

          <input
            style={{
              padding: "14px 16px",
              borderRadius: 8,
              width: "100%",
              background: "rgba(255, 255, 255, 0.03)",
              color: "#e6e6e6",
              border: "1px solid rgba(255, 255, 255, 0.1)",
              fontSize: 15,
              fontFamily: "'Montserrat', sans-serif",
              outline: "none",
              transition: "all 0.2s ease",
              boxSizing: "border-box",
            }}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter your token..."
            onFocus={(e) => {
              e.target.style.borderColor = "rgba(255, 215, 0, 0.3)";
              e.target.style.background = "rgba(255, 255, 255, 0.05)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "rgba(255, 255, 255, 0.1)";
              e.target.style.background = "rgba(255, 255, 255, 0.03)";
            }}
          />

          <button
            onClick={submit}
            style={{
              padding: "14px 24px",
              marginTop: 20,
              width: "100%",
              background: "#e19003ff",
              color: "#0a0a0a",
              borderRadius: 8,
              border: "none",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.2s ease",
              fontFamily: "'Montserrat', sans-serif",
            }}
            onMouseEnter={(e) => {
              e.target.style.background = "#f0ae07ff";
              e.target.style.transform = "translateY(-2px)";
            }}
            onMouseLeave={(e) => {
              e.target.style.background = "#dc8a06ff";
              e.target.style.transform = "translateY(0)";
            }}
          >
            Continue
          </button>

          {error && (
            <div
              style={{
                marginTop: 20,
                padding: "12px 16px",
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.3)",
                borderRadius: 8,
                color: "#ff6b6b",
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </>
  );
}