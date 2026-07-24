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
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1. Load the assignment (gives us type = lab mode, title, week).
        const a = await apiFetch(`/api/assignments/${assignmentId}`, { token });
        // 2. Create a session tied to this student + assignment.
        const { sessionId: sid } = await apiFetch("/api/session/create", {
          method: "POST",
          token,
          body: { studentId: user.username, userId: user.id, assignmentId },
        });
        if (cancelled) return;
        setAssignment(a);
        setSessionId(sid);
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
    return <div className="exam-loading">Loading exam…</div>;
  }

  return (
    <div>
      <div className="exam-strip">
        <button className="btn btn-secondary" onClick={() => navigate(-1)}>← Back to Class</button>
        <span className="exam-title">{assignment.title}</span>
        <span className={`type-pill ${assignment.type}`}>{assignment.type}</span>
      </div>
      <App
        sessionId={sessionId}
        userId={user.id}
        assignmentId={assignmentId}
        labMode={assignment.type}
        studentId={user.username}
      />
    </div>
  );
}
