import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import AppShell from "../components/AppShell";
import "./portal.css";

export default function PortalPage() {
  const { token, user } = useAuth();
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Instructor create-class / student join-class form state
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState(null);

  const isInstructor = user?.role === "INSTRUCTOR";

  const loadClasses = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      const list = await apiFetch("/api/classes", { token });
      setClasses(list ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadClasses();
  }, [loadClasses]);

  async function handleCreateClass(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiFetch("/api/classes", { method: "POST", token, body: { name } });
      setName("");
      await loadClasses();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleJoinClass(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await apiFetch("/api/classes/join", {
        method: "POST",
        token,
        body: { joinCode: joinCode.trim().toUpperCase() },
      });
      setJoinCode("");
      await loadClasses();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyJoinCode(c) {
    try {
      await navigator.clipboard.writeText(c.joinCode);
      setCopiedId(c.id);
      setTimeout(() => setCopiedId((prev) => (prev === c.id ? null : prev)), 1500);
    } catch {
      // Clipboard unavailable (permissions) — the code is still selectable text.
    }
  }

  return (
    <AppShell>
      <div className="portal-body">
        {error && (
          <div className="form-error">
            {error}{" "}
            <button className="link-btn" onClick={loadClasses}>Retry</button>
          </div>
        )}

        <div className="section">
          <h2>{isInstructor ? "Create a class" : "Join a class"}</h2>
          {isInstructor ? (
            <form className="inline-form" onSubmit={handleCreateClass}>
              <div className="field">
                <label htmlFor="cls-name">Class name</label>
                <input
                  id="cls-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. PF Fall 2026"
                  required
                />
              </div>
              <button className="btn" type="submit" disabled={busy}>Create</button>
            </form>
          ) : (
            <form className="inline-form" onSubmit={handleJoinClass}>
              <div className="field">
                <label htmlFor="join-code">Join code</label>
                <input
                  id="join-code"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="6-character code"
                  required
                />
              </div>
              <button className="btn" type="submit" disabled={busy}>Join</button>
            </form>
          )}
        </div>

        <div className="section">
          <h2>Your classes</h2>
          {loading ? (
            <p className="empty-note">Loading classes…</p>
          ) : classes.length === 0 ? (
            <p className="empty-note">
              {isInstructor
                ? "No classes yet — create your first class above."
                : "You haven't joined any classes yet. Enter a join code above."}
            </p>
          ) : (
            <div className="card-grid">
              {classes.map((c) => (
                <div className="card" key={c.id}>
                  <span className="card-title">{c.name}</span>
                  {isInstructor ? (
                    <span className="join-code-row">
                      <span className="join-code" title="Share with students">{c.joinCode}</span>
                      <button
                        className="link-btn copy-btn"
                        type="button"
                        onClick={() => copyJoinCode(c)}
                      >
                        {copiedId === c.id ? "Copied!" : "Copy"}
                      </button>
                    </span>
                  ) : (
                    <span className="card-meta">Instructor: {c.instructorId?.slice(0, 8) ?? "—"}…</span>
                  )}
                  <Link className="link-btn" to={`/portal/classes/${c.id}`}>Open →</Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
