import { useState, useEffect } from "react";
import socket from "../socket";
import DvrPlayer from "./DvrPlayer";
import { debugLog } from "../debug";
import "./Dashboard.css";

const TYPE_COLORS = {
  TAB_OUT: "var(--warning-alt)", // amber
  ILLEGAL_PASTE: "var(--danger)", // red
  AST_VIOLATION: "var(--violet)", // purple
};

function fmt(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export default function Dashboard() {
  const [alerts, setAlerts] = useState([]);
  const [connected, setConnected] = useState(socket.connected);
  const [selectedSessionId, setSelectedSessionId] = useState(null);
  const [sessionIdInput, setSessionIdInput] = useState("");

  useEffect(() => {
    socket.emit("join_instructor");

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onAlert = (payload) => {
      debugLog("[RECV]", payload.type, payload);
      setAlerts((prev) => [payload, ...prev]);
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

  return (
    <div className="dashboard">
      <div className="dash-header">
        <span className="dash-title">CoDecep — Live Instructor Dashboard</span>
        <span className={`dash-status ${connected ? "connected" : "disconnected"}`}>
          {connected ? "● Connected" : "○ Disconnected"}
        </span>
      </div>

      <div className="dash-columns">
        <div className="dash-alerts">
          {alerts.length === 0 ? (
            <div className="dash-empty">No alerts yet — waiting for student activity…</div>
          ) : (
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Student</th>
                  <th>Session</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a, i) => (
                  <tr key={i}>
                    <td className="col-time">{fmt(a.timestamp)}</td>
                    <td className="col-type" style={{ color: TYPE_COLORS[a.type] ?? "var(--text)" }}>
                      {a.type}
                    </td>
                    <td className="col-student">{a.studentId}</td>
                    <td className="col-session">
                      {a.sessionId ? (
                        <button
                          className="session-link"
                          title={`Load ${a.sessionId} in the DVR`}
                          onClick={() => {
                            setSelectedSessionId(a.sessionId);
                            setSessionIdInput(a.sessionId);
                          }}
                        >
                          {a.sessionId.slice(0, 8)}…
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="col-detail">{a.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="dash-dvr">
          <form
            className="dvr-load-row"
            onSubmit={(e) => {
              e.preventDefault();
              const id = sessionIdInput.trim();
              if (id) setSelectedSessionId(id);
            }}
          >
            <input
              type="text"
              className="dvr-load-input"
              placeholder="Load session by ID"
              value={sessionIdInput}
              onChange={(e) => setSessionIdInput(e.target.value)}
              spellCheck={false}
            />
            <button type="submit" className="dvr-load-btn">Load</button>
          </form>
          <DvrPlayer sessionId={selectedSessionId} />
        </div>
      </div>
    </div>
  );
}
