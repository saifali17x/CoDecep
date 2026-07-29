import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import "./theme.css";
import "./index.css";

import { AuthProvider } from "./context/AuthContext";
import ProtectedRoute from "./components/ProtectedRoute";
import App from "./App.jsx";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import PortalPage from "./pages/PortalPage";
import ClassPage from "./pages/ClassPage";
import ExamPage from "./pages/ExamPage";
import InstructorDashboard from "./pages/InstructorDashboard";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />

          <Route
            path="/portal"
            element={
              <ProtectedRoute>
                <PortalPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/portal/classes/:classId"
            element={
              <ProtectedRoute>
                <ClassPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/exam/:assignmentId"
            element={
              <ProtectedRoute role="STUDENT">
                <ExamPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute role="INSTRUCTOR">
                <InstructorDashboard />
              </ProtectedRoute>
            }
          />

          {/* Raw hardcoded dev IDE — keeps the legacy student-001 flow reachable */}
          <Route path="/legacy" element={<App />} />

          <Route path="/" element={<Navigate to="/portal" replace />} />
          <Route path="*" element={<Navigate to="/portal" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
