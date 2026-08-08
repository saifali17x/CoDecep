import "./BrandMark.css";

// ── Brand marks (UI polish part 2) ──────────────────────────────────────────
//
// Two logo files, used at two sizes, and the sizes are why this is a component
// rather than an <img> in each header.
//
// Both files are FULL LOCKUPS: a circuit-tree above the CODECEP wordmark, on a
// dark ground, with generous margin. Dropped into a 56px nav at its natural
// aspect that lockup renders the wordmark at about four pixels tall — present,
// unreadable, and worse than the text it replaced. So the nav uses a square
// crop of the TREE alone as a mark and pairs it with the existing text
// wordmark, while the auth pages use the whole lockup at a size where it can
// actually be read.
//
// The crops are done with background-size / background-position on a container,
// NOT by editing the images — the files are untouched. Their numbers are
// measured from the artwork rather than guessed: logo-2 is 1877x1536 with the
// tree occupying x[521..1348], y[236..995] and the full lockup x[322..1573],
// y[236..1300]. The percentages in BrandMark.css are derived from exactly
// those bounds, so re-deriving them after an artwork change is arithmetic
// rather than nudging.

// The files themselves live in lib/brandAssets.js — see that module for why
// they are imported rather than referenced by URL, and what they cost.
import { logoMain } from "../lib/brandAssets";

/**
 * The compact nav/header mark: the circuit tree on its own black tile.
 *
 * A div with role="img" rather than an <img>, because the crop is done with
 * background positioning. The accessible name is still the brand, so a screen
 * reader hears "CoDecep" exactly as it did from the text wordmark.
 *
 * The tile keeps its own dark ground on purpose. The artwork's background is
 * black, and letting it sit directly on a nav surface would show a black
 * rectangle with a visible edge; a rounded, bordered tile makes that ground
 * read as deliberate on BOTH themes rather than as a clipping bug.
 */
export function BrandMark({ size = 28, className = "" }) {
  return (
    <span
      className={`brand-mark ${className}`}
      role="img"
      aria-label="CoDecep"
      style={{ width: size, height: size, backgroundImage: `url(${logoMain})` }}
    />
  );
}

/**
 * The full lockup — tree and wordmark together — for the auth pages, where the
 * brand gets room and there is no nav to compete with.
 */
export function BrandLockup({ className = "" }) {
  return (
    <div
      className={`brand-lockup ${className}`}
      role="img"
      aria-label="CoDecep"
      style={{ backgroundImage: `url(${logoMain})` }}
    />
  );
}
