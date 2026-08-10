import { useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../context/AuthContext";

// ── Edit an assignment's scheduled window (gap #52) ──────────────────────────
// Before this the schedule could only be set at CREATION, so the one adjustment
// an instructor most plausibly needs mid-sitting — "give the cohort another
// fifteen minutes" — had no route and no control.
//
// This is deliberately the SMALL affordance: the window, plus the title. The
// exam type, the PDF and (once anyone has started) the task count are not
// editable here, because each of them changes how a recorded session is read
// rather than when it is due. The server is the authority on all of that and
// refuses what it must; this form simply does not offer it.
//
// It works at all BECAUSE the window is wall-clock and shared by the cohort
// (§7.3b): `closesAt` is one instant read from the database on every submit, so
// saving a later one extends the deadline for every in-progress student at
// once. There is no per-student clock to adjust and none is introduced.

/** An absolute ISO instant → the local wall-clock string a datetime-local wants. */
function toLocalInput(iso) {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  // Shift by the zone offset so toISOString's UTC slice reads as local time —
  // the input has no timezone, so it must be given the instructor's own clock.
  const local = new Date(ms - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** The datetime-local string back to an absolute instant. Blank stays blank. */
function toIso(local) {
  const t = String(local).trim();
  if (t === "") return "";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function fmtWhen(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return null;
  }
}

export default function AssignmentScheduleEditor({ assignment, onSaved, onCancel }) {
  const { token } = useAuth();
  const [title, setTitle] = useState(assignment.title ?? "");
  const [opensAt, setOpensAt] = useState(toLocalInput(assignment.opensAt));
  const [closesAt, setClosesAt] = useState(toLocalInput(assignment.closesAt));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");

  const opensLabel = fmtWhen(assignment.opensAt);
  const closesLabel = fmtWhen(assignment.closesAt);

  /** Push the close out by N minutes from wherever it currently sits. */
  function extendBy(minutes) {
    const base = Date.parse(toIso(closesAt) || assignment.closesAt || "");
    if (!Number.isFinite(base)) return;
    setClosesAt(toLocalInput(new Date(base + minutes * 60_000).toISOString()));
    setSaved("");
  }

  async function handleSave(e) {
    e.preventDefault();
    setError("");
    setSaved("");
    setBusy(true);
    try {
      // A PATCH sends only what this form owns. An empty string is meaningful —
      // it CLEARS that bound — which is why every field is sent rather than
      // only the non-empty ones.
      const updated = await apiFetch(`/api/assignments/${assignment.id}`, {
        method: "PATCH",
        token,
        body: {
          title: title.trim(),
          opensAt: toIso(opensAt),
          closesAt: toIso(closesAt),
        },
      });
      setSaved(
        updated?.closesAt
          ? `Saved — closes ${fmtWhen(updated.closesAt)}. In-progress students pick this up.`
          : "Saved — this assignment is now unscheduled."
      );
      onSaved?.(updated);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="schedule-editor" onSubmit={handleSave}>
      <p className="empty-note">
        {closesLabel || opensLabel ? (
          <>
            Currently {opensLabel ? <>opens <strong>{opensLabel}</strong></> : "opens any time"} and{" "}
            {closesLabel ? <>closes <strong>{closesLabel}</strong></> : "has no closing time"}.
          </>
        ) : (
          <>This assignment is unscheduled — students can submit at any time.</>
        )}
      </p>

      <div className="inline-form">
        <div className="field">
          <label htmlFor={`edit-title-${assignment.id}`}>Title</label>
          <input
            id={`edit-title-${assignment.id}`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor={`edit-opens-${assignment.id}`}>Opens at</label>
          <input
            id={`edit-opens-${assignment.id}`}
            type="datetime-local"
            value={opensAt}
            onChange={(e) => setOpensAt(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`edit-closes-${assignment.id}`}>Closes at</label>
          <input
            id={`edit-closes-${assignment.id}`}
            type="datetime-local"
            value={closesAt}
            onChange={(e) => setClosesAt(e.target.value)}
          />
        </div>
        <button type="button" className="link-btn" disabled={busy} onClick={() => extendBy(15)}>
          +15 min
        </button>
        <button type="button" className="link-btn" disabled={busy} onClick={() => extendBy(30)}>
          +30 min
        </button>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save schedule"}
        </button>
        <button type="button" className="link-btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>

      {error && <p className="field-error">{error}</p>}
      {saved && <p className="empty-note">{saved}</p>}

      <p className="field-hint">
        Leaving a field blank removes that bound. The window is enforced on the server against its
        own clock, so a change here applies to every student at once — including anyone already
        working. The number of tasks and the exam type cannot be changed once the exam exists,
        because per-task telemetry is already recorded against them.
      </p>
    </form>
  );
}
