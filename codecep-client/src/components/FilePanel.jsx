import { useState } from "react";
import {
  ENTRY_FILE,
  MAX_FILES,
  ALLOWED_EXTENSIONS,
  badgeOf,
  kindOf,
  outputKey,
  sortFiles,
  validateFileName,
} from "../lib/workspace";
import "./FilePanel.css";

// ── Exam file panel (Session 23) ─────────────────────────────────────────────
// The FUNCTIONAL replacement for the dead EXPLORER tree that was deleted in
// Session 21. That one listed two files that did not exist; this one owns the
// real workspace: create, rename, delete, and switch the active buffer.
//
// Three groups, because they mean different things to the student:
//   Source files   — .cpp/.h, compiled together by `g++ *.cpp -o main`
//   Data files     — .txt/.csv/.dat, present in the sandbox for fstream
//   Program output — files the last run WROTE; read-only, not part of the
//                    workspace, replaced on every run

function FileRow({
  file,
  active,
  onSelect,
  onRename,
  onDelete,
  readOnly,
  canDelete,
}) {
  return (
    <li className={`file-row ${active ? "active" : ""}`}>
      <button
        type="button"
        className="file-row-main"
        onClick={() => onSelect(file.name)}
        title={file.name}
      >
        <span className={`file-badge ${kindOf(file.name)}`}>{badgeOf(file.name)}</span>
        <span className="file-name">{file.name}</span>
      </button>
      {!readOnly && (
        <span className="file-actions">
          <button
            type="button"
            className="file-action"
            title={`Rename ${file.name}`}
            aria-label={`Rename ${file.name}`}
            onClick={() => onRename(file.name)}
          >
            ✎
          </button>
          <button
            type="button"
            className="file-action danger"
            title={
              canDelete
                ? `Delete ${file.name}`
                : `${ENTRY_FILE} is the entry point and cannot be deleted`
            }
            aria-label={`Delete ${file.name}`}
            disabled={!canDelete}
            onClick={() => onDelete(file.name)}
          >
            ×
          </button>
        </span>
      )}
    </li>
  );
}

export default function FilePanel({
  files,
  activeFile,
  outputFiles = [],
  onSelect,
  onCreate,
  onRename,
  onDelete,
  readOnly = false,
}) {
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState(null);
  // Rename happens inline in the same field so the panel never opens a modal
  // over the editor mid-exam.
  const [renaming, setRenaming] = useState(null);

  const names = files.map((f) => f.name);
  const atLimit = files.length >= MAX_FILES;

  function resetForm() {
    setCreating(false);
    setRenaming(null);
    setDraftName("");
    setError(null);
  }

  function submitForm(e) {
    e.preventDefault();
    const problem = validateFileName(draftName, names, { ignore: renaming ?? undefined });
    if (problem) {
      setError(problem);
      return;
    }
    const name = draftName.trim();
    if (renaming) onRename(renaming, name);
    else onCreate(name);
    resetForm();
  }

  function startRename(name) {
    setCreating(false);
    setRenaming(name);
    setDraftName(name);
    setError(null);
  }

  function startCreate() {
    setRenaming(null);
    setCreating(true);
    setDraftName("");
    setError(null);
  }

  function confirmDelete(name) {
    if (window.confirm(`Delete "${name}"? This cannot be undone.`)) onDelete(name);
  }

  const sourceFiles = sortFiles(files.filter((f) => kindOf(f.name) === "code"));
  const dataFiles = sortFiles(files.filter((f) => kindOf(f.name) === "data"));
  const showForm = creating || renaming !== null;

  return (
    <aside className="file-panel" aria-label="Workspace files">
      <div className="file-panel-header">
        <span>Files</span>
        {!readOnly && (
          <button
            type="button"
            className="file-new"
            onClick={startCreate}
            disabled={atLimit}
            title={atLimit ? `Limit is ${MAX_FILES} files` : "New file"}
          >
            + New
          </button>
        )}
      </div>

      {showForm && (
        <form className="file-form" onSubmit={submitForm}>
          <input
            autoFocus
            className="file-input"
            value={draftName}
            placeholder="Student.h"
            aria-label={renaming ? "New file name" : "New file name"}
            onChange={(e) => {
              setDraftName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") resetForm();
            }}
          />
          <div className="file-form-actions">
            <button type="submit" className="file-form-btn primary">
              {renaming ? "Rename" : "Create"}
            </button>
            <button type="button" className="file-form-btn" onClick={resetForm}>
              Cancel
            </button>
          </div>
          {error ? (
            <p className="file-form-error">{error}</p>
          ) : (
            <p className="file-form-hint">
              Allowed: {ALLOWED_EXTENSIONS.map((e) => "." + e).join(", ")}
            </p>
          )}
        </form>
      )}

      <div className="file-groups">
        <section className="file-group">
          <h4 className="file-group-title">Source</h4>
          <ul className="file-list">
            {sourceFiles.map((file) => (
              <FileRow
                key={file.name}
                file={file}
                active={file.name === activeFile}
                onSelect={onSelect}
                onRename={startRename}
                onDelete={confirmDelete}
                readOnly={readOnly}
                canDelete={file.name !== ENTRY_FILE}
              />
            ))}
          </ul>
        </section>

        <section className="file-group">
          <h4 className="file-group-title">Data</h4>
          {dataFiles.length === 0 ? (
            <p className="file-group-empty">
              No data files. Create one (.txt / .csv / .dat) to read it with ifstream.
            </p>
          ) : (
            <ul className="file-list">
              {dataFiles.map((file) => (
                <FileRow
                  key={file.name}
                  file={file}
                  active={file.name === activeFile}
                  onSelect={onSelect}
                  onRename={startRename}
                  onDelete={confirmDelete}
                  readOnly={readOnly}
                  canDelete
                />
              ))}
            </ul>
          )}
        </section>

        {outputFiles.length > 0 && (
          <section className="file-group">
            <h4 className="file-group-title">
              Program output
              <span className="file-group-note">written by your last run</span>
            </h4>
            <ul className="file-list">
              {outputFiles.map((file) => (
                <li
                  key={file.name}
                  className={`file-row output ${outputKey(file.name) === activeFile ? "active" : ""}`}
                >
                  <button
                    type="button"
                    className="file-row-main"
                    onClick={() => onSelect(outputKey(file.name))}
                    title={`${file.name} — ${file.bytes} bytes (read-only)`}
                  >
                    <span className="file-badge output">OUT</span>
                    <span className="file-name">{file.name}</span>
                    <span className="file-size">{file.bytes}B</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  );
}
