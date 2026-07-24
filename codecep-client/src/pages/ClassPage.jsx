import { useEffect, useState, useCallback } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import "./portal.css";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

export default function ClassPage() {
  const { classId } = useParams();
  const { token, user } = useAuth();
  const navigate = useNavigate();

  const [klass, setKlass] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [error, setError] = useState("");

  // Instructor create-assignment form
  const [title, setTitle] = useState("");
  const [type, setType] = useState("LIVE_LAB");
  const [week, setWeek] = useState(1);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const isInstructor = klass ? klass.instructorId === user?.id : false;

  const load = useCallback(async () => {
    try {
      // GET /api/classes/:id returns the class WITH its assignments (Prisma include).
      const data = await apiFetch(`/api/classes/${classId}`, { token });
      setKlass(data);
      setAssignments(data?.assignments ?? []);
    } catch (err) {
      setError(err.message);
    }
  }, [classId, token]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreateAssignment(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("title", title);
      fd.append("type", type);
      fd.append("week", String(week));
      if (file) fd.append("syllabus", file);

      await apiFetch(`/api/classes/${classId}/assignments`, {
        method: "POST",
        token,
        body: fd,
      });
      setTitle("");
      setWeek(1);
      setFile(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="portal">
      <div className="portal-header">
        <span className="portal-brand">CoDecep</span>
        <span className="portal-user">
          <button className="btn btn-secondary" onClick={() => navigate("/portal")}>← Portal</button>
        </span>
      </div>

      <div className="portal-body">
        {error && <div className="form-error">{error}</div>}

        <div className="section">
          <h2>Class</h2>
          <div className="card">
            <span className="card-title">{klass?.name ?? "Loading…"}</span>
            {isInstructor && klass?.joinCode && (
              <span className="join-code" title="Share with students">{klass.joinCode}</span>
            )}
          </div>
        </div>

        {isInstructor && (
          <div className="section">
            <h2>Create assignment</h2>
            <form className="inline-form" onSubmit={handleCreateAssignment}>
              <div className="field">
                <label htmlFor="a-title">Title</label>
                <input id="a-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
              </div>
              <div className="field">
                <label htmlFor="a-type">Type</label>
                <select id="a-type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="LIVE_LAB">Live Lab</option>
                  <option value="ASSESSMENT">Assessment</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="a-week">Week</label>
                <input
                  id="a-week"
                  type="number"
                  min="1"
                  value={week}
                  onChange={(e) => setWeek(e.target.value)}
                  style={{ width: 70 }}
                />
              </div>
              <div className="field">
                <label htmlFor="a-pdf">Syllabus PDF (optional)</label>
                <input id="a-pdf" type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </div>
              <button className="btn" type="submit" disabled={busy}>Create</button>
            </form>
          </div>
        )}

        <div className="section">
          <h2>Assignments</h2>
          {assignments.length === 0 ? (
            <p className="empty-note">No assignments yet.</p>
          ) : (
            <table className="assign-table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Week</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.id}>
                    <td>{a.title}</td>
                    <td><span className={`type-pill ${a.type}`}>{a.type}</span></td>
                    <td>{a.week}</td>
                    <td>{fmtDate(a.createdAt)}</td>
                    <td>
                      {isInstructor ? (
                        <Link className="link-btn" to={`/dashboard?assignmentId=${a.id}`}>View Sessions →</Link>
                      ) : (
                        <Link className="link-btn" to={`/exam/${a.id}`}>Open →</Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
