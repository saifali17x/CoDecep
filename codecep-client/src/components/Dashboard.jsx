import { useState, useEffect } from "react";
import socket from "../socket";
import "./Dashboard.css";

const TYPE_COLORS = {
  TAB_OUT: "#f59e0b",       // amber
  ILLEGAL_PASTE: "#ef4444", // red
  AST_VIOLATION: "#a855f7", // purple
};

function fmt(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export default function Dashboard() {
  const [alerts, setAlerts] = useState([]);
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    socket.emit("join_instructor");

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    const onAlert = (payload) => {
      console.log("[RECV]", payload.type, payload);
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
                <td className="col-type" style={{ color: TYPE_COLORS[a.type] ?? "#fff" }}>
                  {a.type}
                </td>
                <td className="col-student">{a.studentId}</td>
                <td className="col-session">{a.sessionId?.slice(0, 8) ?? "—"}…</td>
                <td className="col-detail">{a.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
