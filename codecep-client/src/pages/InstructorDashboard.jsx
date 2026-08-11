import { useEffect, useState, useRef, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import socket from "../socket";
import AppShell from "../components/AppShell";
import DvrPlayer from "../components/DvrPlayer";
import MetricGlossary from "../components/MetricGlossary";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { debugLog } from "../debug";
import {
  alertTypeInfo,
  alertPlainName,
  isAlertTypeShownFor,
  isTakeHome,
  ASSESSMENT_GATE_NOTE,
} from "../lib/metricLabels";
import "../components/Dashboard.css"; // .dash-status / .dash-table / .session-link
import "./MonitorGrid.css";

// Session 17 — grid-first live monitoring. One tile per rostered student; a
// live Tier-1 alert turns the tile red and moves it to the top; clicking a
// tile opens that student's DVR replay. The raw chronological alert log stays
// available below the grid. Detection, payloads, and the DVR are unchanged —
// this is a new VIEW over the existing alert stream and session data.

const COOLDOWN_MS = 10_000; // red → amber after this long without new alerts

function fmt(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

// The three Tier-1 kinds, in the same three hues the DVR's scrubber ticks use
// so one event reads the same wherever it is shown. Tokens rather than
// literals (UI polish part 2) — a var() resolves in an inline style exactly as
// it does in a stylesheet, so the log follows the active theme.
const TYPE_COLORS = {
  TAB_OUT: "var(--warning-alt)",
  ILLEGAL_PASTE: "var(--danger)",
  AST_VIOLATION: "var(--violet)",
};

export default function InstructorDashboard() {
  const [params, setParams] = useSearchParams();
  const { token } = useAuth();

  const [assignments, setAssignments] = useState([]); // [{id, title, className}]
  const [assignmentId, setAssignmentId] = useState(params.get("assignmentId") ?? "");
  const [roster, setRoster] = useState(null); // null until an assignment is picked
  const [rosterError, setRosterError] = useState("");
  const [rosterLoading, setRosterLoading] = useState(false);

  // Live alert state, keyed by studentId (username):
  // { [studentId]: { count, lastType, lastAt, sessionId } }
  const [live, setLive] = useState({});
  const [alerts, setAlerts] = useState([]); // raw chronological log
  const [connected, setConnected] = useState(socket.connected);
  // Session 28 — a tile click opens the DVR in LIVE mode, which is what makes
  // the grid a monitoring tool rather than a post-mortem index: the instructor
  // watches the code being typed instead of reading it 30 seconds later. Held
  // together as one object so the session and its mode can never disagree.
  const [dvr, setDvr] = useState(null); // { sessionId, live }
  const [, setTick] = useState(0); // 1s ticker so cool-down transitions render

  // The socket handler must know the current roster without re-subscribing.
  const rosterNamesRef = useRef(new Set());
  useEffect(() => {
    rosterNamesRef.current = new Set((roster ?? []).map((r) => r.username));
  }, [roster]);

  // LIVE_LAB vs ASSESSMENT for the selected exam. On a take-home, a tab-out is
  // a student getting a coffee, so it is not surfaced here at all — the alert
  // is still relayed and still recorded, but a dashboard that lights up for
  // three days of ordinary life trains an instructor to ignore it. Preferred
  // from the roster (authoritative, and present even with no sessions yet),
  // falling back to the selector list.
  const assignmentType =
    roster?.[0]?.assignmentType ??
    assignments.find((a) => a.id === assignmentId)?.type ??
    null;
  // The socket handler is registered once; a ref keeps it reading the CURRENT
  // exam type without tearing the subscription down on every change.
  const assignmentTypeRef = useRef(assignmentType);
  useEffect(() => {
    assignmentTypeRef.current = assignmentType;
  }, [assignmentType]);

  // ── Assignment selector data: all of this instructor's assignments ────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const classes = (await apiFetch("/api/classes", { token })) ?? [];
        const lists = await Promise.all(
          classes.map((c) =>
            apiFetch(`/api/classes/${c.id}/assignments`, { token }).then((as) =>
              (as ?? []).map((a) => ({
                id: a.id,
                title: a.title,
                type: a.type,
                className: c.name,
              }))
            )
          )
        );
        if (!cancelled) setAssignments(lists.flat());
      } catch (err) {
        if (!cancelled) setRosterError(err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ── Roster load on selection ──────────────────────────────────────────────
  const loadRoster = useCallback(async () => {
    if (!assignmentId) return;
    setRosterError("");
    setRosterLoading(true);
    try {
      const list = await apiFetch(`/api/assignments/${assignmentId}/roster`, { token });
      setRoster(list ?? []);
    } catch (err) {
      setRosterError(err.message);
      setRoster(null);
    } finally {
      setRosterLoading(false);
    }
  }, [assignmentId, token]);

  useEffect(() => {
    setLive({});
    setDvr(null);
    loadRoster();
  }, [loadRoster]);

  // ── Live socket (payloads/relay untouched — this only consumes them) ──────
  useEffect(() => {
    socket.emit("join_instructor");
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onAlert = (payload) => {
      debugLog("[RECV]", payload.type, payload);
      // Gated for a take-home before it reaches ANY of this screen's state, so
      // a suppressed event cannot colour a tile, bump a counter or fill the log.
      if (!isAlertTypeShownFor(payload.type, assignmentTypeRef.current)) return;
      setAlerts((prev) => [payload, ...prev].slice(0, 200));
      // Grid update only for students on the current roster.
      if (!rosterNamesRef.current.has(payload.studentId)) return;
      setLive((prev) => {
        const cur = prev[payload.studentId] ?? { count: 0, lastType: null, lastAt: 0, sessionId: null };
        return {
          ...prev,
          [payload.studentId]: {
            count: cur.count + 1,
            lastType: payload.type,
            lastAt: payload.timestamp ?? Date.now(),
            sessionId: payload.sessionId ?? cur.sessionId,
          },
        };
      });
    };
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("alert", onAlert);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("alert", onAlert);
    };
  }, []);

  // 1s ticker: lets violating tiles cool to amber without new events.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  function selectAssignment(id) {
    setAssignmentId(id);
    setParams(id ? { assignmentId: id } : {});
  }

  // ── Tile derivation + violation-first ordering ────────────────────────────
  const now = Date.now();
  const tiles = (roster ?? [])
    .map((r) => {
      const lv = live[r.username];
      const sessionId = r.sessionId ?? lv?.sessionId ?? null;
      // An alert implies the student is in the exam even if the roster
      // snapshot predates their session.
      const status = r.status === "NOT_STARTED" && lv ? "IN_PROGRESS" : r.status;
      const violating = lv && now - lv.lastAt < COOLDOWN_MS;
      const flagged = lv && !violating;
      return { ...r, sessionId, status, lv, violating, flagged };
    })
    .sort((a, b) => {
      const aAt = a.lv?.lastAt ?? 0;
      const bAt = b.lv?.lastAt ?? 0;
      if (aAt !== bAt) return bAt - aAt; // most-recent violation first
      return a.username.localeCompare(b.username);
    });

  return (
    <AppShell>
      <div className="monitor-body">
        <div className="monitor-controls">
          <div className="field">
            <label htmlFor="assignment-select">Monitoring</label>
            <select
              id="assignment-select"
              value={assignmentId}
              onChange={(e) => selectAssignment(e.target.value)}
            >
              <option value="">— select an assignment —</option>
              {assignments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.className} · {a.title}
                </option>
              ))}
            </select>
          </div>
          <span className={`dash-status ${connected ? "connected" : "disconnected"}`}>
            {connected ? "● Connected" : "○ Disconnected"}
          </span>
        </div>

        {rosterError && (
          <p className="form-error">
            {rosterError} <button className="link-btn" onClick={loadRoster}>Retry</button>
          </p>
        )}

        {/* A dashboard that quietly shows fewer kinds of alert is
            indistinguishable from one that is broken, so it says so. */}
        {assignmentId && isTakeHome(assignmentType) && (
          <p className="empty-note">{ASSESSMENT_GATE_NOTE}</p>
        )}

        {!assignmentId ? (
          <p className="empty-note">Select an assignment above to monitor its exam roster.</p>
        ) : rosterLoading ? (
          <p className="empty-note"><span className="spinner" aria-hidden="true" />Loading roster…</p>
        ) : roster && roster.length === 0 ? (
          <p className="empty-note">No students in this class yet.</p>
        ) : roster ? (
          <div className={`monitor-main ${dvr ? "with-dvr" : ""}`}>
            <div className="tile-grid">
              {tiles.map((t) => (
                <button
                  // A student who has a session but no membership row carries
                  // no userId (2026-08-11) — the username is the identity the
                  // roster de-duplicates on, so it is the stable fallback key.
                  key={t.userId ?? t.username}
                  className={[
                    "student-tile",
                    t.violating ? "violating" : t.flagged ? "had-violations" : "calm",
                    t.sessionId ? "clickable" : "",
                  ].join(" ")}
                  disabled={!t.sessionId}
                  title={
                    t.sessionId
                      ? t.status === "IN_PROGRESS"
                        ? `Watch ${t.username} live — see their code being typed`
                        : `Open ${t.username}'s DVR replay`
                      : `${t.username} has not started`
                  }
                  onClick={() =>
                    t.sessionId &&
                    setDvr({ sessionId: t.sessionId, live: t.status === "IN_PROGRESS" })
                  }
                >
                  <span className="tile-top">
                    <span className={`status-dot ${t.status.toLowerCase()}`} />
                    <span className="tile-name">{t.username}</span>
                    {t.lv && <span className="alert-count">{t.lv.count}</span>}
                  </span>
                  <span className="tile-sub">
                    {t.lv
                      ? `${alertPlainName(t.lv.lastType)} · ${fmt(t.lv.lastAt)}`
                      : t.status === "NOT_STARTED"
                        ? "not started"
                        : t.status === "SUBMITTED"
                          ? "submitted"
                          : "in progress"}
                    {/* They sat the exam but are not on the class roll. Shown
                        rather than hidden, and labelled rather than passed off
                        as enrolled — it is a roster problem to notice, not a
                        reason to hide their work. */}
                    {t.enrolled === false && " · not enrolled"}
                  </span>
                </button>
              ))}
            </div>

            {dvr && (
              <div className="monitor-dvr">
                <div className="monitor-dvr-head">
                  <span>{dvr.live ? "Live session" : "Session replay"}</span>
                  {/* Closing is what stops the student streaming: the DVR's own
                      cleanup emits watch:stop, and the server tells the student
                      to stop once no watchers remain. */}
                  <button className="link-btn" onClick={() => setDvr(null)}>× close</button>
                </div>
                <DvrPlayer key={dvr.sessionId} sessionId={dvr.sessionId} live={dvr.live} />
              </div>
            )}
          </div>
        ) : null}

        {/* Secondary chronological log — the timeline detail is never lost. */}
        <details className="alert-log">
          <summary>Raw alert log ({alerts.length})</summary>
          {alerts.length === 0 ? (
            <p className="empty-note">No alerts yet — waiting for student activity…</p>
          ) : (
            <div className="table-scroll">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Time</th><th>Type</th><th>Student</th><th>Session</th><th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => (
                  <tr key={i}>
                    <td>{fmt(a.timestamp)}</td>
                    {/* Plain language first, the raw event name underneath —
                        the log stays greppable against the stored tier1_log
                        while reading as English. Wording: lib/metricLabels.js. */}
                    <td style={{ color: TYPE_COLORS[a.type] ?? "var(--text)" }} title={alertTypeInfo(a.type)?.desc}>
                      {alertPlainName(a.type)}
                      <span className="alert-type-tech mono">{a.type}</span>
                    </td>
                    <td>{a.studentId}</td>
                    <td>
                      {a.sessionId ? (
                        <button
                          className="session-link"
                          onClick={() => setDvr({ sessionId: a.sessionId, live: true })}
                        >
                          {a.sessionId.slice(0, 8)}…
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {/* What each live event actually means, in the same words the DVR
              and the reports use. Tier-1 events only — no metric is computed
              here; this screen shows what fired, not what was inferred. */}
          <MetricGlossary keys={[]} includeTier1 assignmentType={assignmentType} />
        </details>
      </div>
    </AppShell>
  );
}
