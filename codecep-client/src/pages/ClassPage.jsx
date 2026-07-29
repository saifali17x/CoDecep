import { useEffect, useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import AppShell from "../components/AppShell";
import DvrPlayer from "../components/DvrPlayer";
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

  // Instructor create-assignment form
  const [title, setTitle] = useState("");
  const [type, setType] = useState("LIVE_LAB");
  const [week, setWeek] = useState(1);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  // Phase 6 — syllabus → allowlist preview/confirm (human-in-the-loop)
  const [allowlistWeeks, setAllowlistWeeks] = useState(null); // { week1: [...], ... } | null
  const [parseWarning, setParseWarning] = useState("");
  const [parsing, setParsing] = useState(false);
  const [newNodeByWeek, setNewNodeByWeek] = useState({}); // { week1: "typed text", ... }

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

  function resetAllowlistPreview() {
    setAllowlistWeeks(null);
    setParseWarning("");
    setNewNodeByWeek({});
  }

  async function handleParseSyllabus() {
    if (!file) return;
    setError("");
    setParseWarning("");
    setParsing(true);
    try {
      const fd = new FormData();
      fd.append("syllabus", file);
      const data = await apiFetch("/api/assignments/preview-allowlist", {
        method: "POST",
        token,
        body: fd,
      });
      if (data?.weeks) {
        setAllowlistWeeks(data.weeks);
      } else {
        setAllowlistWeeks(null);
        setParseWarning(data?.warning ?? "Could not parse the syllabus.");
      }
    } catch (err) {
      setAllowlistWeeks(null);
      setParseWarning(err.message);
    } finally {
      setParsing(false);
    }
  }

  function removeNode(weekKey, node) {
    setAllowlistWeeks((prev) => ({
      ...prev,
      [weekKey]: prev[weekKey].filter((n) => n !== node),
    }));
  }

  function addNode(weekKey) {
    const node = (newNodeByWeek[weekKey] ?? "").trim();
    if (!node) return;
    setAllowlistWeeks((prev) => ({
      ...prev,
      [weekKey]: prev[weekKey].includes(node) ? prev[weekKey] : [...prev[weekKey], node],
    }));
    setNewNodeByWeek((prev) => ({ ...prev, [weekKey]: "" }));
  }

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
      // Instructor-confirmed (possibly edited) allowlist from the preview step.
      if (allowlistWeeks) fd.append("allowlist", JSON.stringify({ weeks: allowlistWeeks }));

      await apiFetch(`/api/classes/${classId}/assignments`, {
        method: "POST",
        token,
        body: fd,
      });
      setTitle("");
      setWeek(1);
      setFile(null);
      resetAllowlistPreview();
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
          <p className="empty-note">Loading class…</p>
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
                <input
                  id="a-pdf"
                  type="file"
                  accept="application/pdf"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    resetAllowlistPreview();
                  }}
                />
              </div>
              {file && !allowlistWeeks && (
                <button className="btn btn-secondary" type="button" onClick={handleParseSyllabus} disabled={parsing || busy}>
                  {parsing ? "Parsing syllabus with AI…" : "Parse Syllabus"}
                </button>
              )}
              <button className="btn" type="submit" disabled={busy || parsing}>Create</button>
            </form>

            {parseWarning && (
              <p className="allowlist-warning">
                {parseWarning}
              </p>
            )}

            {allowlistWeeks && (
              <div className="allowlist-preview">
                <p className="allowlist-note">
                  AI-generated from your syllabus — review and adjust before saving.
                </p>
                {Object.entries(allowlistWeeks).map(([weekKey, nodes]) => (
                  <details key={weekKey} className="allowlist-week" open={weekKey === "week1"}>
                    <summary>
                      {weekKey} <span className="allowlist-count">({nodes.length} node types)</span>
                    </summary>
                    <div className="chip-list">
                      {nodes.map((node) => (
                        <span key={node} className="chip">
                          {node}
                          <button
                            type="button"
                            className="chip-x"
                            title={`Remove ${node}`}
                            onClick={() => removeNode(weekKey, node)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <span className="chip-add">
                        <input
                          value={newNodeByWeek[weekKey] ?? ""}
                          placeholder="add node type"
                          onChange={(e) => setNewNodeByWeek((prev) => ({ ...prev, [weekKey]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addNode(weekKey);
                            }
                          }}
                        />
                        <button type="button" className="link-btn" onClick={() => addNode(weekKey)}>+ add</button>
                      </span>
                    </div>
                  </details>
                ))}
              </div>
            )}
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
                            <p className="empty-note">Loading sessions…</p>
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
