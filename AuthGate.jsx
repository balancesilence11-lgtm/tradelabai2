import React, { useEffect, useState } from "react";

export default function AuthGate({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [registering, setRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function checkSession() {
    try {
      const response = await fetch("/api/auth/me", {
        credentials: "same-origin"
      });

      const data = await response.json();
      setUser(response.ok && data.authenticated ? data.user : null);
    } catch {
      setUser(null);
      setError("Unable to connect to the authentication service.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    checkSession();

    const logoutHandler = () => signOut();

    window.addEventListener("tradelab:logout", logoutHandler);

    return () => {
      window.removeEventListener("tradelab:logout", logoutHandler);
    };
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setBusy(true);

    try {
      const endpoint = registering
        ? "/api/auth/register"
        : "/api/auth/login";

      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Authentication failed.");
      }

      setPassword("");
      await checkSession();

    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin"
      });
    } finally {
      setUser(null);
      setPassword("");
      setError("");
    }
  }

  const inputStyle = {
    width: "100%",
    padding: "13px",
    marginTop: "7px",
    background: "#0b1728",
    border: "1px solid #2b3b52",
    borderRadius: "7px",
    color: "#fff",
    boxSizing: "border-box"
  };

  if (loading) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#0b1220",
        color: "#20d6a1"
      }}>
        Securing TradeLab AI...
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#0b1220",
        color: "#e5e7eb",
        padding: "20px",
        fontFamily: "Arial, sans-serif"
      }}>
        <div style={{
          width: "100%",
          maxWidth: "420px",
          background: "#101a2c",
          border: "1px solid #253149",
          borderRadius: "14px",
          padding: "30px",
          boxSizing: "border-box"
        }}>
          <h1 style={{ margin: "0 0 8px", fontSize: "27px" }}>
            TradeLab <span style={{ color: "#20d6a1" }}>AI</span>
          </h1>

          <p style={{ color: "#8290a8", fontSize: "13px" }}>
            Secure access to your trading workspace.
          </p>

          <h2 style={{ fontSize: "19px", marginTop: "28px" }}>
            {registering ? "Create your account" : "Welcome back"}
          </h2>

          <form onSubmit={submit}>
            <label style={{ fontSize: "12px" }}>Email address</label>
            <input
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              style={inputStyle}
            />

            <label style={{
              display: "block",
              marginTop: "18px",
              fontSize: "12px"
            }}>
              Password
            </label>

            <input
              type="password"
              required
              minLength={registering ? 12 : 1}
              maxLength={128}
              autoComplete={registering ? "new-password" : "current-password"}
              value={password}
              onChange={e => setPassword(e.target.value)}
              style={inputStyle}
            />

            {registering && (
              <p style={{
                color: "#8290a8",
                fontSize: "11px"
              }}>
                Use at least 12 characters.
              </p>
            )}

            {error && (
              <p role="alert" style={{
                color: "#fb7185",
                fontSize: "12px",
                lineHeight: 1.5
              }}>
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              style={{
                width: "100%",
                padding: "13px",
                marginTop: "20px",
                background: "#079b78",
                color: "white",
                border: 0,
                borderRadius: "7px",
                fontWeight: "bold",
                cursor: "pointer"
              }}
            >
              {busy
                ? "Please wait..."
                : registering
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>

          <button
            onClick={() => {
              setRegistering(!registering);
              setError("");
            }}
            style={{
              width: "100%",
              marginTop: "18px",
              background: "transparent",
              border: 0,
              color: "#20d6a1",
              cursor: "pointer"
            }}
          >
            {registering
              ? "Already registered? Sign in"
              : "New user? Create an account"}
          </button>

          <p style={{
            color: "#8290a8",
            fontSize: "10px",
            textAlign: "center",
            marginTop: "25px"
          }}>
            TradeLab AI · Secure account authentication
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{
        position: "fixed",
        right: "15px",
        bottom: "15px",
        zIndex: 1000,
        background: "#101a2c",
        border: "1px solid #253149",
        borderRadius: "8px",
        padding: "9px 12px",
        color: "#20d6a1",
        fontSize: "11px"
      }}>
        {user.email}
        <button
          onClick={signOut}
          style={{
            marginLeft: "12px",
            background: "transparent",
            border: 0,
            color: "#fb7185",
            cursor: "pointer"
          }}
        >
          Sign out
        </button>
      </div>

      {children}
    </>
  );
}
