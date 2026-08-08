import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { BrandLockup } from "../components/BrandMark";
import { logoAlt } from "../lib/brandAssets";
import ThemeToggle from "../components/ThemeToggle";
import "./portal.css";

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { token, user } = await apiFetch("/api/auth/login", {
        method: "POST",
        body: { username, password },
      });
      login(token, user);
      navigate("/portal");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap branded" style={{ "--auth-backdrop": `url(${logoAlt})` }}>
      <form className="auth-card" onSubmit={handleSubmit}>
        {/* The lockup already contains the wordmark, so a text <h1> beside it
            would be the brand name twice. It carries the accessible name. */}
        <BrandLockup />
        <p className="auth-sub">Sign in to your account</p>

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>

        <div className="form-error">{error}</div>

        <button className="btn btn-block" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="auth-alt">
          No account? <Link to="/register">Create one</Link>
        </p>
      </form>

      <div className="auth-theme">
        <span className="auth-theme-label">Colour theme</span>
        <ThemeToggle compact />
      </div>
    </div>
  );
}
