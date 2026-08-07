import {
  METRIC_INFO,
  TIER1_INFO,
  REVIEW_FRAMING,
  isMetricShownFor,
  isTier1ShownFor,
} from "../lib/metricLabels";
import "./MetricGlossary.css";

// ── "What these columns check" (UI polish part 1) ────────────────────────────
//
// A tooltip is enough for someone who already knows a metric exists. It is not
// enough for a professor opening a forensic report for the first time, who has
// no reason to hover over a column header called "Rhythm" — the description
// would be there and never read. So the same wording is also available INLINE,
// collapsed by default so it costs nothing once it has been read.
//
// Everything here comes from lib/metricLabels.js. Nothing is written twice, so
// the glossary and the pills it explains can never drift apart.
export default function MetricGlossary({
  keys,
  includeTier1 = false,
  open = false,
  // LIVE_LAB vs ASSESSMENT: the glossary must not explain a signal the report
  // above it deliberately does not show. Absent/unknown explains everything.
  assignmentType = null,
}) {
  const shown = (keys ?? Object.keys(METRIC_INFO)).filter(
    (k) => METRIC_INFO[k] && isMetricShownFor(k, assignmentType),
  );
  const tier1Shown = Object.entries(TIER1_INFO).filter(([k]) =>
    isTier1ShownFor(k, assignmentType),
  );
  if (shown.length === 0 && !includeTier1) return null;

  return (
    <details className="metric-glossary" open={open}>
      <summary>What these signals check</summary>
      <dl className="metric-glossary-list">
        {shown.map((key) => {
          const info = METRIC_INFO[key];
          return (
            <div className="metric-glossary-item" key={key}>
              <dt>
                {info.plain}
                <span className="metric-glossary-tech mono">{info.tech}</span>
              </dt>
              <dd>{info.desc}</dd>
            </div>
          );
        })}
        {includeTier1 &&
          tier1Shown.map(([key, info]) => (
            <div className="metric-glossary-item" key={key}>
              <dt>
                {info.plain}
                <span className="metric-glossary-tech mono">{info.tech}</span>
              </dt>
              <dd>{info.desc}</dd>
            </div>
          ))}
      </dl>
      {/* The caveat that applies to every row above, worded once. */}
      <p className="metric-glossary-note">{REVIEW_FRAMING}</p>
    </details>
  );
}
