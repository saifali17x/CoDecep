import { useEffect, useRef, useState } from "react";
import "./ExamTimer.css";

// ── Timed submission window — the countdown (Feature 1) ─────────────────────
//
// DISPLAY ONLY. The server decides whether a submission is accepted, using its
// own clock against the assignment's SCHEDULED closing instant; this component
// cannot widen that window, and nothing it renders is sent anywhere. If this
// file were deleted the enforcement would be unchanged — the student would just
// not know how long they had left.
//
// The deadline is WALL-CLOCK and shared by the whole cohort, so this counts down
// to the same instant on every student's screen. A student who opened the paper
// late simply sees less time, which is the point.
//
// Two details make it honest rather than decorative:
//
// 1. **Clock-skew correction.** The countdown runs against `deadlineAt`
//    (server-computed, absolute) offset by the difference between the server's
//    clock and this machine's, measured once when the session was resolved. A
//    student whose laptop is ten minutes slow would otherwise see ten extra
//    minutes and be rejected at submit for something that is not their fault.
// 2. **The auto-submit fires slightly EARLY.** A request sent at exactly the
//    deadline arrives after it, and the server — correctly — refuses it. Rather
//    than weakening the server rule with a grace period, the client acts a few
//    seconds sooner so an honest student's work lands inside the window.

// How long before the deadline the client submits on the student's behalf.
// Small enough to cost nothing on an exam-length window, large enough to cover
// the final flush plus a slow network.
export const AUTO_SUBMIT_LEAD_MS = 10_000;

const WARN_AT_MS = 5 * 60_000; // amber
const URGENT_AT_MS = 60_000; // red

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export default function ExamTimer({ deadlineAt, serverNow, onExpire, isSubmitted }) {
  // Measured ONCE, when this timer first mounts: how far this machine's clock
  // is from the server's. Held as state rather than a ref because it is read
  // during render — a student whose laptop is ten minutes slow would otherwise
  // see ten extra minutes and be refused at submit for something that is not
  // their fault.
  const [skew] = useState(() => (typeof serverNow === "number" ? serverNow - Date.now() : 0));
  const firedRef = useRef(false);
  const [remaining, setRemaining] = useState(() =>
    typeof deadlineAt === "number" ? deadlineAt - (Date.now() + skew) : null,
  );

  useEffect(() => {
    if (typeof deadlineAt !== "number") return undefined;
    const tick = () => {
      const left = deadlineAt - (Date.now() + skew);
      setRemaining(left);
      // One-shot, and never after the Immune Phase has already disarmed.
      if (!firedRef.current && !isSubmitted && left <= AUTO_SUBMIT_LEAD_MS) {
        firedRef.current = true;
        onExpire?.();
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [deadlineAt, isSubmitted, onExpire, skew]);

  if (typeof deadlineAt !== "number" || remaining === null) return null;

  const level =
    remaining <= URGENT_AT_MS ? "urgent" : remaining <= WARN_AT_MS ? "warn" : "ok";
  const expired = remaining <= 0;

  return (
    <div
      className={`exam-timer ${level} ${isSubmitted ? "done" : ""}`}
      role="timer"
      aria-live={level === "ok" ? "off" : "polite"}
      title={
        isSubmitted
          ? "Submitted."
          : "Time left until this exam closes. The closing time is the same for everyone and is enforced by the server."
      }
    >
      <span className="exam-timer-label">
        {isSubmitted ? "Submitted" : expired ? "Time up" : "Time left"}
      </span>
      {!isSubmitted && <span className="exam-timer-value">{formatRemaining(remaining)}</span>}
    </div>
  );
}
