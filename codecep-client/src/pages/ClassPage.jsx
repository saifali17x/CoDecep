import { useEffect, useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import AppShell from "../components/AppShell";
import DvrPlayer from "../components/DvrPlayer";
import SyllabusManager from "../components/SyllabusManager";
import {
  metricASeverity,
  metricBSeverity,
  metricCSeverity,
  LEVEL_COLORS,
} from "../lib/metricColors";
import "./portal.css";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

// Probabilistic framing: red means "flagged for instructor review" — never an
// accusation. Color is always paired with visible text (Session 17 severity
// scale); the full label rides in the title. Pending forensics → grey dash.
function SeverityCell({ sev, short }) {
  return (
    <span className="sev-cell" style={{ color: LEVEL_COLORS[sev.level] }} title={sev.label}>
      {short}
    </span>
  );
}
const PENDING_SEV = { level: "grey", label: "Forensics pending (session not yet submitted)" };

export default function ClassPage() {
  const { classId } = useParams();
  const { token, user } = useAuth();

  const [klass, setKlass] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Instructor create-assignment form. `file` is the TASK/QUESTION document
  // shown to students in the exam split-pane — NOT the syllabus (Session 20:
  // the syllabus + allowlist are managed per-class in <SyllabusManager/>).
  const [title, setTitle] = useState("");
  const [type, setType] = useState("LIVE_LAB");
  const [week, setWeek] = useState(1);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  // Session 16 — instructor session discovery + inline DVR replay
  const [sessionsFor, setSessionsFor] = useState(null); // assignmentId | null
  const [sessions, setSessions] = useState(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState("");
  const [replaySessionId, setReplaySessionId] = useState(null);

  const isInstructor = klass ? klass.instructorId === user?.id : false;

  const load = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      // GET /api/classes/:id returns the class WITH its assignments (Prisma
      // include) and, for the requester, mySubmissions (assignment ids).
      const data = await apiFetch(`/api/classes/${classId}`, { token });
      setKlass(data);
      setAssignments(data?.assignments ?? []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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
      // The TASK/QUESTION document for the exam split-pane.
      if (file) fd.append("assignmentPdf", file);

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

  const loadSessions = useCallback(
    async (assignmentId) => {
      setSessionsError("");
      setSessionsLoading(true);
      try {
        const list = await apiFetch(`/api/assignments/${assignmentId}/sessions`, { token });
        setSessions(list ?? []);
      } catch (err) {
        setSessionsError(err.message);
      } finally {
        setSessionsLoading(false);
      }
    },
    [token]
  );

  function toggleSessions(assignmentId) {
    if (sessionsFor === assignmentId) {
      setSessionsFor(null);
      setSessions(null);
      setReplaySessionId(null);
      return;
    }
    setSessionsFor(assignmentId);
    setSessions(null);
    setReplaySessionId(null);
    loadSessions(assignmentId);
  }

  if (loading && !klass) {
    return (
      <AppShell>
        <div className="portal-body">
          <p className="empty-note"><span className="spinner" aria-hidden="true" />Loading class…</p>
        </div>
      </AppShell>
    );
  }

  if (error && !klass) {
    return (
      <AppShell>
        <div className="portal-body">
          <div className="form-error">
            {error} <button className="link-btn" onClick={load}>Retry</button>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="portal-body">
        {error && <div className="form-error">{error}</div>}

        <div className="section">
          <h2>Class</h2>
          <div className="card">
            <span className="card-title">{klass?.name ?? "—"}</span>
            {isInstructor && klass?.joinCode && (
              <span className="join-code" title="Share with students">{klass.joinCode}</span>
            )}
          </div>
        </div>

        {isInstructor && klass && <SyllabusManager klass={klass} onSaved={load} />}

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
                <label htmlFor="a-pdf">Assignment PDF (optional)</label>
                <input
                  id="a-pdf"
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </div>
              <button className="btn" type="submit" disabled={busy}>Create</button>
            </form>
            <p className="field-hint">
              The assignment PDF is the task shown to students in the exam. Allowed constructs
              come from this class's syllabus (Week N).
            </p>
          </div>
        )}

        <div className="section">
          <h2>Assignments</h2>
          {assignments.length === 0 ? (
            <p className="empty-note">
              {isInstructor
                ? "No assignments yet — create one above."
                : "No assignments yet — check back later."}
            </p>
          ) : (
            <div className="table-scroll">
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
                {assignments.map((a) => {
                  const submitted = klass?.mySubmissions?.includes(a.id) ?? false;
                  return [
                    <tr key={a.id}>
                      <td>{a.title}</td>
                      <td><span className={`type-pill ${a.type}`}>{a.type}</span></td>
                      <td>{a.week}</td>
                      <td>{fmtDate(a.createdAt)}</td>
                      <td>
                        {isInstructor ? (
                          <button className="link-btn" onClick={() => toggleSessions(a.id)}>
                            {sessionsFor === a.id ? "Hide Sessions" : "View Sessions"}
                          </button>
                        ) : (
                          <span className="row-actions">
                            {submitted && <span className="submitted-badge">Submitted</span>}
                            <Link className="link-btn" to={`/exam/${a.id}`}>
                              {submitted ? "View →" : "Open →"}
                            </Link>
                          </span>
                        )}
                      </td>
                    </tr>,
                    isInstructor && sessionsFor === a.id && (
                      <tr key={`${a.id}-sessions`} className="sessions-row">
                        <td colSpan={5}>
                          {sessionsLoading ? (
                            <p className="empty-note"><span className="spinner" aria-hidden="true" />Loading sessions…</p>
                          ) : sessionsError ? (
                            <p className="form-error">
                              {sessionsError}{" "}
                              <button className="link-btn" onClick={() => loadSessions(a.id)}>Retry</button>
                            </p>
                          ) : !sessions || sessions.length === 0 ? (
                            <p className="empty-note">No student sessions yet.</p>
                          ) : (
                            <table className="session-table">
                              <thead>
                                <tr>
                                  <th>Student</th>
                                  <th>Status</th>
                                  <th>Runs</th>
                                  <th title="Metric A — Trial-and-Error">A</th>
                                  <th title="Metric B — Linear Injection">B</th>
                                  <th title="Metric C — Robotic Variance">C</th>
                                  <th>Submitted</th>
                                  <th></th>
                                </tr>
                              </thead>
                              <tbody>
                                {sessions.map((s) => (
                                  <tr key={s.id}>
                                    <td>{s.studentId}</td>
                                    <td>
                                      <span className={`status-pill ${s.status === "SUBMITTED" ? "done" : "active"}`}>
                                        {s.status}
                                      </span>
                                    </td>
                                    <td>{s.runCount}</td>
                                    <td>
                                      {s.forensicsResults ? (
                                        <SeverityCell
                                          sev={metricASeverity(s.runCount)}
                                          short={`${s.runCount} run${s.runCount === 1 ? "" : "s"}`}
                                        />
                                      ) : (
                                        <SeverityCell sev={PENDING_SEV} short="—" />
                                      )}
                                    </td>
                                    <td>
                                      {s.forensicsResults ? (
                                        <SeverityCell
                                          sev={metricBSeverity(s.forensicsResults.metricB?.flag)}
                                          short={s.forensicsResults.metricB?.flag ? "flag" : "ok"}
                                        />
                                      ) : (
                                        <SeverityCell sev={PENDING_SEV} short="—" />
                                      )}
                                    </td>
                                    <td>
                                      {s.forensicsResults ? (
                                        <SeverityCell
                                          sev={metricCSeverity(s.forensicsResults.metricC?.cv ?? null)}
                                          short={
                                            s.forensicsResults.metricC?.cv != null
                                              ? `CV ${s.forensicsResults.metricC.cv.toFixed(2)}`
                                              : "—"
                                          }
                                        />
                                      ) : (
                                        <SeverityCell sev={PENDING_SEV} short="—" />
                                      )}
                                    </td>
                                    <td>{s.status === "SUBMITTED" ? fmtTime(s.updatedAt) : "—"}</td>
                                    <td>
                                      <button className="link-btn" onClick={() => setReplaySessionId(s.id)}>
                                        Replay
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {isInstructor && replaySessionId && (
          <div className="section">
            <h2>
              Session replay{" "}
              <button className="link-btn" onClick={() => setReplaySessionId(null)}>× close</button>
            </h2>
            <DvrPlayer sessionId={replaySessionId} />
          </div>
        )}
      </div>
    </AppShell>
  );
}
