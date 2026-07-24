import { useSearchParams } from "react-router-dom";
import Dashboard from "../components/Dashboard";
import "./portal.css";

// Route wrapper for the existing live-alert Dashboard.
// Adds an optional "Monitoring assignment <id>" banner when ?assignmentId=X
// is present. All Socket.io alert-table logic stays untouched inside Dashboard.
export default function InstructorDashboard() {
  const [params] = useSearchParams();
  const assignmentId = params.get("assignmentId");

  return (
    <>
      {assignmentId && (
        <div className="dash-filter">Monitoring assignment {assignmentId}</div>
      )}
      <Dashboard />
    </>
  );
}
