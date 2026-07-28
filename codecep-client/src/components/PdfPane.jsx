import { useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext";
import { BASE } from "../lib/api";

// Assignment PDF viewer for the exam split-pane (Phase 1). Fetches the PDF
// with the auth token, holds it as a blob URL, and renders it in an iframe —
// the browser's native PDF viewer handles all PDF types without react-pdf.
export default function PdfPane({ assignmentId }) {
  const { token } = useAuth();
  const [blobUrl, setBlobUrl] = useState(null);
  const [status, setStatus] = useState("loading"); // 'loading' | 'ready' | 'error'

  useEffect(() => {
    let cancelled = false;
    let url = null;
    (async () => {
      try {
        const res = await fetch(`${BASE}/api/assignments/${assignmentId}/pdf`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
        if (cancelled) return;
        setBlobUrl(url);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      // Revoke on unmount so blob URLs don't leak across exam navigations.
      if (url) URL.revokeObjectURL(url);
    };
  }, [assignmentId, token]);

  if (status === "loading") {
    return <div className="pdf-pane pdf-pane-msg">Loading assignment…</div>;
  }
  if (status === "error") {
    return <div className="pdf-pane pdf-pane-msg">No assignment document.</div>;
  }
  return (
    <div className="pdf-pane">
      <iframe
        src={blobUrl}
        width="100%"
        height="100%"
        title="Assignment PDF"
        style={{ border: "none" }}
      />
    </div>
  );
}
