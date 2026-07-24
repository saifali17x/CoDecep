import { useEffect, useState, useCallback } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import "./portal.css";

export default function PortalPage() {
  const { token, user, logout } = useAuth();
  const navigate = useNavigate();
  const [classes, setClasses] = useState([]);
  const [error, setError] = useState("");

  // Instructor create-class / student join-class form state
  const [name, setName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);

  const isInstructor = user?.role === "INSTRUCTOR";

  const loadClasses = useCallback(async () => {
    try {
      const list = await apiFetch("/api/classes", { token });
      setClasses(list ?? []);
    } catch (err) {
      setError(err.message);
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

  function handleLogout() {
    logout();
    navigate("/login");
  }

  return (
    <div className="portal">
      <div className="portal-header">
        <span className="portal-brand">CoDecep</span>
        <span className="portal-user">
          <span className="role-pill">{user?.role}</span>
          {user?.username}
          <button className="btn btn-secondary" onClick={handleLogout}>Logout</button>
        </span>
      </div>

      <div className="portal-body">
        {error && <div className="form-error">{error}</div>}

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
          {classes.length === 0 ? (
            <p className="empty-note">
              {isInstructor ? "No classes yet — create one above." : "You haven't joined any classes yet."}
            </p>
          ) : (
            <div className="card-grid">
              {classes.map((c) => (
                <div className="card" key={c.id}>
                  <span className="card-title">{c.name}</span>
                  {isInstructor ? (
                    <span
                      className="join-code"
                      title="Click to select — share with students"
                    >
                      {c.joinCode}
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
    </div>
  );
}
