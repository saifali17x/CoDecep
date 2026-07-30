import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import { useAuth } from "../context/AuthContext";
import { BASE } from "../lib/api";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import "./PdfPane.css";

// pdf.js worker for Vite: import the version-matched worker that ships with the
// installed pdfjs-dist as a URL so Vite bundles it (no CDN, no version skew).
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.15;
const PAGE_GUTTER = 24; // horizontal breathing room inside the pane

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

// Assignment PDF viewer for the exam split-pane. Session 21 replaced the
// iframe/blob strip with react-pdf so the student can actually READ the
// question sheet: continuous scroll through all pages, zoom in/out (buttons or
// ctrl+scroll), and a live "Page X of N" indicator.
export default function PdfPane({ assignmentId }) {
  const { token } = useAuth();
  const [blobUrl, setBlobUrl] = useState(null);
  const [status, setStatus] = useState("loading"); // 'loading' | 'ready' | 'error'
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [paneWidth, setPaneWidth] = useState(0);

  const scrollRef = useRef(null);
  const pageRefs = useRef([]);

  // ── Fetch the PDF with the auth token (the route is requireAuth) ──────────
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
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setBlobUrl(url);
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

  // ── Fit-to-width: track the pane's own width, zoom multiplies it ──────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setPaneWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [status]);

  // ── "Page X of N": whichever page is most visible in the scroll container ─
  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container || numPages === 0) return;
    const mid = container.scrollTop + container.clientHeight / 2;
    let current = 1;
    for (let i = 0; i < pageRefs.current.length; i++) {
      const el = pageRefs.current[i];
      if (el && el.offsetTop <= mid) current = i + 1;
    }
    setPageNum(current);
  }, [numPages]);

  // Ctrl+scroll to zoom, like every other document viewer.
  function handleWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
  }

  if (status === "error") {
    return (
      <div className="pdf-pane pdf-pane-msg">
        Could not load assignment PDF.
      </div>
    );
  }

  const pageWidth = paneWidth > 0 ? Math.max(200, paneWidth - PAGE_GUTTER) : undefined;

  return (
    <div className="pdf-pane">
      <div className="pdf-toolbar">
        <span className="pdf-page-indicator">
          {numPages > 0 ? `Page ${pageNum} of ${numPages}` : "Assignment"}
        </span>
        <div className="pdf-zoom">
          <button
            className="pdf-zoom-btn"
            onClick={() => setZoom((z) => clampZoom(z - ZOOM_STEP))}
            disabled={zoom <= ZOOM_MIN}
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            className="pdf-zoom-level"
            onClick={() => setZoom(1)}
            title="Reset to fit width"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            className="pdf-zoom-btn"
            onClick={() => setZoom((z) => clampZoom(z + ZOOM_STEP))}
            disabled={zoom >= ZOOM_MAX}
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      <div
        className="pdf-scroll"
        ref={scrollRef}
        onScroll={handleScroll}
        onWheel={handleWheel}
      >
        {status === "loading" && (
          <p className="pdf-msg">
            <span className="spinner" aria-hidden="true" />
            Loading assignment…
          </p>
        )}
        {blobUrl && (
          <Document
            file={blobUrl}
            loading={
              <p className="pdf-msg">
                <span className="spinner" aria-hidden="true" />
                Rendering…
              </p>
            }
            error={<p className="pdf-msg">Could not load assignment PDF.</p>}
            onLoadSuccess={({ numPages: n }) => {
              setNumPages(n);
              pageRefs.current = new Array(n).fill(null);
              setStatus("ready");
            }}
            onLoadError={() => setStatus("error")}
          >
            {Array.from({ length: numPages }, (_, i) => (
              <div
                className="pdf-page-wrap"
                key={i}
                ref={(el) => {
                  pageRefs.current[i] = el;
                }}
              >
                <Page
                  pageNumber={i + 1}
                  width={pageWidth}
                  scale={zoom}
                  renderAnnotationLayer
                  renderTextLayer
                />
              </div>
            ))}
          </Document>
        )}
      </div>
    </div>
  );
}
