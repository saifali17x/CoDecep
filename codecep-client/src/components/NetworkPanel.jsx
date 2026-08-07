import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { validateIpRule } from "../lib/ipRules";
import "./NetworkPanel.css";

// ── Network restriction (Feature 2) — instructor panel ──────────────────────
//
// Toggle + an allowlist of addresses and CIDR ranges. Nothing is inferred: the
// instructor types what is allowed and presses Save, the same preview-then-
// confirm shape as the syllabus allowlist.
//
// The copy here is deliberately honest and must stay that way. This restricts
// CASUAL off-network access; it is a deterrent, not a guarantee, because a
// determined student can tunnel through a VPN and the server only ever sees the
// address a request arrives from. Overclaiming here would be the one place in
// the product that promises something the mechanism cannot deliver.
export default function NetworkPanel({ klass, onSaved }) {
  const { token } = useAuth();
  const [enabled, setEnabled] = useState(Boolean(klass?.ipRestrictionEnabled));
  const [rules, setRules] = useState(() =>
    Array.isArray(klass?.allowedIps) ? klass.allowedIps.map(String) : [],
  );
  const [draft, setDraft] = useState("");
  const [entryError, setEntryError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [myIp, setMyIp] = useState(null);

  // What the SERVER sees this instructor coming from. Shown because the most
  // common way to lock a class out is to allowlist the wrong address — a
  // guessed LAN range instead of the one requests actually arrive from.
  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/network/my-ip", { token })
      .then((r) => {
        if (!cancelled) setMyIp(r.ip ?? null);
      })
      .catch(() => {
        /* advisory only — never block the panel on it */
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const dirty =
    enabled !== Boolean(klass?.ipRestrictionEnabled) ||
    JSON.stringify(rules) !== JSON.stringify(klass?.allowedIps ?? []);

  function addRule(value) {
    const entry = (value ?? draft).trim();
    const problem = validateIpRule(entry);
    if (problem) {
      setEntryError(problem);
      return;
    }
    if (rules.includes(entry)) {
      setEntryError(`"${entry}" is already on the list.`);
      return;
    }
    setRules([...rules, entry]);
    setDraft("");
    setEntryError("");
    setSaved(false);
  }

  function removeRule(entry) {
    setRules(rules.filter((r) => r !== entry));
    setSaved(false);
  }

  async function save() {
    setError("");
    setBusy(true);
    try {
      await apiFetch(`/api/classes/${klass.id}/network`, {
        method: "PUT",
        token,
        body: { ipRestrictionEnabled: enabled, allowedIps: rules },
      });
      setSaved(true);
      onSaved?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Enabling with nothing allowed would deny everyone (the server refuses it
  // too). Catching it here means the instructor sees why before they submit.
  const wouldLockEveryoneOut = enabled && rules.length === 0;

  return (
    <div className="section network-panel">
      <h2>Network restriction</h2>

      <label className="network-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setSaved(false);
          }}
        />
        <span>
          Restrict this class to the addresses below
          {!enabled && <em> — currently off, everyone can access from anywhere</em>}
        </span>
      </label>

      <p className="field-hint">
        When on, students can only OPEN an exam in this class from an allowed address.
        This deters casual off-network access — it is <strong>not a guarantee</strong>:
        a student using a VPN or a phone hotspot bridge can still appear to be on the
        network. Treat it as one control among several, alongside the behavioral signals.
      </p>

      <div className="network-add">
        <input
          type="text"
          value={draft}
          placeholder="203.0.113.5 or 10.0.0.0/24"
          onChange={(e) => {
            setDraft(e.target.value);
            setEntryError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addRule();
            }
          }}
          aria-label="IP address or CIDR range"
        />
        <button className="btn btn-secondary" type="button" onClick={() => addRule()}>
          Add
        </button>
        {myIp && !rules.includes(myIp) && (
          <button
            className="btn btn-ghost"
            type="button"
            onClick={() => addRule(myIp)}
            title="Add the address this browser is reaching the server from"
          >
            + Add mine ({myIp})
          </button>
        )}
      </div>
      {entryError && <p className="form-error">{entryError}</p>}
      {myIp && (
        <p className="field-hint">
          The server sees your requests coming from <code className="mono">{myIp}</code>.
        </p>
      )}

      {rules.length === 0 ? (
        <p className="empty-note">No addresses added yet.</p>
      ) : (
        <ul className="network-list">
          {rules.map((rule) => (
            <li key={rule} className={`network-chip ${rule.includes("/") ? "range" : "exact"}`}>
              <code className="mono">{rule}</code>
              <span className="network-chip-kind">{rule.includes("/") ? "range" : "single"}</span>
              <button
                type="button"
                className="network-chip-remove"
                onClick={() => removeRule(rule)}
                aria-label={`Remove ${rule}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {wouldLockEveryoneOut && (
        <p className="form-error">
          Add at least one address before turning the restriction on — an empty list
          would block every student, including you.
        </p>
      )}
      {error && <p className="form-error">{error}</p>}

      <div className="network-actions">
        <button
          className="btn"
          type="button"
          onClick={save}
          disabled={busy || wouldLockEveryoneOut || !dirty}
        >
          {busy ? "Saving…" : "Save network policy"}
        </button>
        {dirty && !saved && <span className="field-hint">Unsaved changes</span>}
        {saved && !dirty && <span className="saved-note">✓ Saved</span>}
      </div>
    </div>
  );
}
