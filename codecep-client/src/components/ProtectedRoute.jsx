import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

// Guards a route. No token → /login. Wrong role (when `role` given) → /portal.
export default function ProtectedRoute({ role, children }) {
  const { token, user } = useAuth();

  if (!token) return <Navigate to="/login" replace />;
  if (role && user?.role !== role) return <Navigate to="/portal" replace />;

  return children;
}
