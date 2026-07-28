import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "../pages/portal.css";

// Shared authenticated layout (Session 16): consistent top nav on every
// logged-in page. ExamPage deliberately does NOT use this — a student
// mid-exam keeps the minimal back strip so nothing tempts them away.
export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate("/login");
  }

  const linkClass = ({ isActive }) => `shell-link${isActive ? " active" : ""}`;

  return (
    <div className="portal">
      <div className="portal-header">
        <span className="shell-left">
          <NavLink to="/portal" className="portal-brand">CoDecep</NavLink>
          <nav className="shell-nav">
            <NavLink to="/portal" className={linkClass}>Portal</NavLink>
            {user?.role === "INSTRUCTOR" && (
              <NavLink to="/dashboard" className={linkClass}>Live Dashboard</NavLink>
            )}
          </nav>
        </span>
        <span className="portal-user">
          <span className="role-pill">{user?.role}</span>
          {user?.username}
          <button className="btn btn-secondary" onClick={handleLogout}>Logout</button>
        </span>
      </div>
      {children}
    </div>
  );
}
