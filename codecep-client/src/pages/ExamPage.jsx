import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import App from "../App";
import "./portal.css";

// Wraps the IDE (App) with a real authenticated identity + the assignment's
// lab mode. This is what finally makes labMode (LIVE_LAB vs ASSESSMENT) and
// tab-out gating real, and populates session.userId / session.assignmentId.
export default function ExamPage() {
  const { assignmentId } = useParams();
  const { token, user } = useAuth();
  const navigate = useNavigate();

  const [assignment, setAssignment] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  // The workspace to open with, restored from the last DB flush when this
  // session is being RESUMED (gap #4). Resolved here, before <App/> renders, so
  // the editor is seeded rather than programmatically written to after mount —
  // that ordering is what keeps the restore out of the telemetry entirely.
  const [restore, setRestore] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Load the assignment (gives us type = lab mode, title, week, and
        //    whether THIS student already submitted it).
        const a = await apiFetch(`/api/assignments/${assignmentId}`, { token });
        if (a.mySubmittedSession) {
          // Session 16: already submitted — do NOT create a fresh session.
          // Reuse the submitted session id and open the IDE locked.
          if (cancelled) return;
          setAssignment(a);
          setSessionId(a.mySubmittedSession.id);
          setAlreadySubmitted(true);
          return;
        }
        // 2. Resolve THIS student's session for THIS assignment. Since the
        //    gap #12 fix the server keys on (student, assignment): the same
        //    pair reopened resumes the same row, a different assignment always
        //    gets its own, and a submitted pair comes back locked instead of
        //    silently starting a second attempt.
        const created = await apiFetch("/api/session/create", {
          method: "POST",
          token,
          body: { studentId: user.username, userId: user.id, assignmentId },
        });
        if (cancelled) return;
        if (created.status === "ALREADY_SUBMITTED") {
          // Belt and braces with the mySubmittedSession branch above — that one
          // reads the assignment, this one reads the session rows themselves,
          // and neither may quietly hand back an editable session.
          setAssignment(a);
          setSessionId(created.sessionId);
          setAlreadySubmitted(true);
          return;
        }

        // 3. Resuming? Put the student's code back from the last DB flush.
        //    Best-effort: a failure here costs the restore, never the exam, so
        //    the worst case is the blank editor they had before this existed.
        let restored = null;
        if (created.resumed) {
          try {
            const r = await apiFetch(`/api/session/${created.sessionId}/restore`, { token });
            if (r.restorable && r.restoredFrom) restored = r;
          } catch (err) {
            console.warn("[EXAM] could not restore previous code:", err?.message ?? err);
          }
        }
        if (cancelled) return;
        setRestore(restored);
        setAssignment(a);
        setSessionId(created.sessionId);
      } catch (err) {
        if (!cancelled) setError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignmentId, token, user]);

  if (error) {
    return (
      <div className="exam-loading">
        <div>
          <p className="form-error">{error}</p>
          <button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back</button>
        </div>
      </div>
    );
  }

  if (!assignment || !sessionId) {
    return (
      <div className="exam-loading">
        <span className="spinner" aria-hidden="true" />Loading exam…
      </div>
    );
  }

  // Session 21: App owns the whole exam shell — one top strip (back + title +
  // lab mode + Run/Submit) and the draggable PDF/editor split. ExamPage just
  // resolves identity + assignment and hands them over.
  return (
    <App
      sessionId={sessionId}
      userId={user.id}
      assignmentId={assignmentId}
      labMode={assignment.type}
      studentId={user.username}
      initialStatus={alreadySubmitted ? "SUBMITTED" : undefined}
      assignmentTitle={assignment.title}
      onBack={() => navigate(-1)}
      hasPdf={Boolean(assignment.assignmentPdfFilename)}
      // Session 22: a real exam starts from an empty file. Pre-written
      // boilerplate is code the student neither typed nor pasted, which
      // muddies the authorship metric's accounting of the final program.
      initialCode=""
      // Prompt 1: how many questions this exam has. Each gets its own file
      // workspace behind its own tab; one PDF, one allowlist and one submit
      // still cover the lot. Absent on assignments created before this
      // feature — those default to the single-task exam they already were.
      taskCount={assignment.taskCount ?? 1}
      // Gap #4: the workspace this session last flushed, or null for a fresh
      // one (which opens blank as it always did). App seeds its state from
      // this, so the restored text is present from the editor's first frame
      // and is never captured as input.
      restore={restore}
    />
  );
}
