import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { BrandLockup } from "../components/BrandMark";
import { logoAlt } from "../lib/brandAssets";
import ThemeToggle from "../components/ThemeToggle";
import "./portal.css";

// Client-side mirror of the backend rules (validation.ts). The backend remains
// the source of truth — this is just immediate feedback.
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
function passwordIssue(pw) {
  if (pw.length < 8) return "At least 8 characters required";
  if (pw.length > 72) return "At most 72 characters";
  if (!/[a-zA-Z]/.test(pw)) return "Must include a letter";
  if (!/[0-9]/.test(pw)) return "Must include a number";
  return "";
}

// Simple dependency-free strength estimate: length + charset variety.
function scorePassword(pw) {
  let s = 0;
  if (pw.length >= 8) s += 1;
  if (pw.length >= 12) s += 1;
  if (/[a-zA-Z]/.test(pw) && /[0-9]/.test(pw)) s += 1;
  if (/[^a-zA-Z0-9]/.test(pw)) s += 1;
  if (pw.length >= 16) s += 1;
  return Math.min(s, 4);
}
// Tokens, not literals (UI polish part 2), so the meter follows the active
// theme. The scale keeps its meaning in both: weak is the danger colour,
// strong is the success colour, and the LABEL is what actually states the
// verdict — the bar is emphasis on top of the word.
const STRENGTH = [
  { label: "Weak", color: "var(--danger)" },
  { label: "Weak", color: "var(--danger)" },
  { label: "Fair", color: "var(--warning-alt)" },
  { label: "Good", color: "var(--warning)" },
  { label: "Strong", color: "var(--success)" },
];

export default function RegisterPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("STUDENT");
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState({}); // { username, password, role }
  const [busy, setBusy] = useState(false);

  const usernameValid = USERNAME_RE.test(username.trim());
  const pwIssue = passwordIssue(password);
  const formValid = usernameValid && pwIssue === "";
  const strength = scorePassword(password);
  const { label: strengthLabel, color: strengthColor } = STRENGTH[strength];

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setFieldErrors({});
    setBusy(true);
    try {
      const { token, user } = await apiFetch("/api/auth/register", {
        method: "POST",
        body: { username: username.trim(), password, role },
      });
      login(token, user);
      navigate("/portal");
    } catch (err) {
      // Map backend validation details[] to the right fields; anything else
      // (username taken, rate limit, network) shows as the form-level error.
      if (Array.isArray(err.details) && err.details.length > 0) {
        const mapped = {};
        for (const d of err.details) {
          if (!mapped[d.field]) mapped[d.field] = d.message;
        }
        setFieldErrors(mapped);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap branded" style={{ "--auth-backdrop": `url(${logoAlt})` }}>
      <form className="auth-card" onSubmit={handleSubmit}>
        {/* Same lockup as sign-in — the two auth screens are one moment. */}
        <BrandLockup />
        <p className="auth-sub">Create an account</p>

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <p className="field-hint">3–20 characters: letters, numbers, underscore</p>
          {(fieldErrors.username || (username && !usernameValid)) && (
            <p className="field-error">
              {fieldErrors.username ?? "Letters, numbers, and underscores only (3–20 chars)"}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <p className="field-hint">At least 8 characters, including a letter and a number</p>
          {password && (
            <div className="pw-meter">
              <div className="pw-meter-track">
                <div
                  className="pw-meter-bar"
                  style={{ width: `${(strength / 4) * 100}%`, background: strengthColor }}
                />
              </div>
              <span className="pw-meter-label" style={{ color: strengthColor }}>
                {strengthLabel}
              </span>
            </div>
          )}
          {(fieldErrors.password || (password && pwIssue)) && (
            <p className="field-error">{fieldErrors.password ?? pwIssue}</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="role">Role</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="STUDENT">Student</option>
            <option value="INSTRUCTOR">Instructor</option>
          </select>
        </div>

        <div className="form-error">{error}</div>

        <button className="btn btn-block" type="submit" disabled={busy || !formValid}>
          {busy ? "Creating…" : "Create account"}
        </button>

        <p className="auth-alt">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>

      <div className="auth-theme">
        <span className="auth-theme-label">Colour theme</span>
        <ThemeToggle compact />
      </div>
    </div>
  );
}
