import { useState, useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../lib/api";
import { NODE_TYPE_GROUPS, ALL_NODE_TYPES } from "../lib/nodeTypes";
import "../pages/portal.css";

// Session 20 — class-level "Syllabus & Allowed Constructs".
// The COURSE syllabus is uploaded once per class (re-uploadable mid-semester);
// Gemini parses it into a per-week AST allowlist that the instructor REVIEWS
// and EDITS before anything is saved (preview-then-confirm — a human always
// approves what the model produced). Assignments link to it by week.
export default function SyllabusManager({ klass, onSaved }) {
  const { token } = useAuth();

  const [file, setFile] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  // Working copy: starts from whatever is already stored on the class.
  const [weeks, setWeeks] = useState(klass?.allowlist?.weeks ?? null);
  const [dirty, setDirty] = useState(false);

  // Searchable add-menu state, per week
  const [searchFor, setSearchFor] = useState(null); // weekKey | null
  const [query, setQuery] = useState("");

  const hasSyllabus = Boolean(klass?.syllabusFilename);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!searchFor) return [];
    const already = new Set(weeks?.[searchFor] ?? []);
    const pool = q
      ? ALL_NODE_TYPES.filter((n) => n.toLowerCase().includes(q))
      : null;
    if (pool) return pool.filter((n) => !already.has(n)).slice(0, 40);
    // No query → show the curated groups, minus what's already in the week.
    return NODE_TYPE_GROUPS.map((g) => ({
      group: g.group,
      nodes: g.nodes.filter((n) => !already.has(n)),
    })).filter((g) => g.nodes.length > 0);
  }, [query, searchFor, weeks]);

  async function handleUpload(e) {
    e.preventDefault();
    if (!file) return;
    setError("");
    setWarning("");
    setSaved(false);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("syllabus", file);
      const data = await apiFetch(`/api/classes/${klass.id}/syllabus`, {
        method: "POST",
        token,
        body: fd,
      });
      if (data?.weeks) {
        setWeeks(data.weeks);
        setDirty(true); // parsed but NOT yet saved — instructor must confirm
      } else {
        setWarning(data?.warning ?? "Could not parse the syllabus.");
        // Seed an empty week1 so manual building is possible.
        setWeeks((prev) => prev ?? { week1: [] });
        setDirty(true);
      }
      setFile(null);
      onSaved?.(); // refresh the class (syllabusFilename is stored immediately)
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      await apiFetch(`/api/classes/${klass.id}/allowlist`, {
        method: "PUT",
        token,
        body: { allowlist: { weeks } },
      });
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function removeNode(weekKey, node) {
    setWeeks((prev) => ({ ...prev, [weekKey]: prev[weekKey].filter((n) => n !== node) }));
    setDirty(true);
  }

  function addNode(weekKey, node) {
    const clean = node.trim();
    if (!clean) return;
    setWeeks((prev) => ({
      ...prev,
      [weekKey]: prev[weekKey].includes(clean) ? prev[weekKey] : [...prev[weekKey], clean],
    }));
    setDirty(true);
    setQuery("");
  }

  function addWeek() {
    setWeeks((prev) => {
      const nums = Object.keys(prev ?? {})
        .map((k) => Number(/^week(\d+)$/.exec(k)?.[1]))
        .filter(Number.isFinite);
      const next = (nums.length ? Math.max(...nums) : 0) + 1;
      return { ...(prev ?? {}), [`week${next}`]: [] };
    });
    setDirty(true);
  }

  const weekKeys = Object.keys(weeks ?? {}).sort(
    (a, b) => (Number(/\d+/.exec(a)?.[0]) || 0) - (Number(/\d+/.exec(b)?.[0]) || 0),
  );

  return (
    <div className="section">
      <h2>Syllabus &amp; Allowed Constructs</h2>

      <form className="inline-form" onSubmit={handleUpload}>
        <div className="field">
          <label htmlFor="syllabus-pdf">
            {hasSyllabus ? "Replace course syllabus (PDF)" : "Upload course syllabus (PDF)"}
          </label>
          <input
            id="syllabus-pdf"
            type="file"
            accept="application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <button className="btn" type="submit" disabled={!file || uploading}>
          {uploading ? "Parsing syllabus with AI…" : hasSyllabus ? "Re-parse" : "Upload & Parse"}
        </button>
        {hasSyllabus && (
          <span className="syllabus-state">
            ✓ Syllabus on file
            {klass.allowlist ? " · allowlist saved" : " · allowlist not saved yet"}
          </span>
        )}
      </form>

      <p className="field-hint">
        The syllabus defines which C++ constructs students may use each week. It belongs to the
        class — assignments pick a week and inherit that week's allowed constructs.
      </p>

      {error && <p className="form-error">{error}</p>}
      {warning && <p className="allowlist-warning">{warning}</p>}

      {weeks && (
        <div className="allowlist-preview">
          <p className="allowlist-note">
            AI-generated from your syllabus — review and adjust before saving. Weeks are
            cumulative (week 3 includes weeks 1–2).
          </p>

          {weekKeys.map((weekKey) => (
            <details key={weekKey} className="allowlist-week" open={weekKey === "week1"}>
              <summary>
                {weekKey}{" "}
                <span className="allowlist-count">({weeks[weekKey].length} node types)</span>
              </summary>
              <div className="chip-list">
                {weeks[weekKey].map((node) => (
                  <span key={node} className="chip">
                    {node}
                    <button
                      type="button"
                      className="chip-x"
                      title={`Remove ${node}`}
                      onClick={() => removeNode(weekKey, node)}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setSearchFor(searchFor === weekKey ? null : weekKey);
                    setQuery("");
                  }}
                >
                  {searchFor === weekKey ? "× close" : "+ add construct"}
                </button>
              </div>

              {searchFor === weekKey && (
                <div className="node-picker">
                  <input
                    autoFocus
                    className="node-search"
                    placeholder="Search node types (e.g. loop, struct, pointer)…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addNode(weekKey, query);
                      }
                    }}
                  />
                  <div className="node-results">
                    {query.trim() ? (
                      matches.length ? (
                        matches.map((n) => (
                          <button
                            key={n}
                            type="button"
                            className="node-option"
                            onClick={() => addNode(weekKey, n)}
                          >
                            {n}
                          </button>
                        ))
                      ) : (
                        <span className="field-hint">
                          No match — press Enter to add "{query.trim()}" anyway.
                        </span>
                      )
                    ) : (
                      matches.map((g) => (
                        <div key={g.group} className="node-group">
                          <span className="node-group-title">{g.group}</span>
                          <div className="node-group-items">
                            {g.nodes.map((n) => (
                              <button
                                key={n}
                                type="button"
                                className="node-option"
                                onClick={() => addNode(weekKey, n)}
                              >
                                {n}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </details>
          ))}

          <div className="allowlist-actions">
            <button className="btn" type="button" onClick={handleSave} disabled={saving || !dirty}>
              {saving ? "Saving…" : "Save Allowlist"}
            </button>
            <button className="btn btn-secondary" type="button" onClick={addWeek}>
              + Add week
            </button>
            {saved && <span className="save-ok">✓ Saved</span>}
            {dirty && !saved && <span className="field-hint">Unsaved changes</span>}
          </div>
        </div>
      )}

      {!weeks && !hasSyllabus && (
        <p className="empty-note">
          No syllabus yet — upload one above to generate the per-week allowed-constructs list.
          Until then, AST checks fall back to the built-in week-1 baseline.
        </p>
      )}
    </div>
  );
}
