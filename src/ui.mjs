/* ============================================================================
 * ui.mjs — tiny DOM + formatting helpers shared by the page scripts
 * (index.mjs, admin.mjs, login.mjs, settings.mjs).
 *
 * Browser-only: src/shared.mjs must stay pure (it's imported by the server),
 * so anything that touches the DOM or formats for display lives here instead.
 * ========================================================================== */

export const $ = (id) => document.getElementById(id);

// Escape text before interpolating it into innerHTML (usernames and other
// server-supplied strings must pass through here).
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Null-tolerant display formatters: "–" when the value isn't known yet.
export const dash = (v) => (v == null ? "–" : v);
export const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");

export function fmtMs(ms) {
  if (ms == null) return "–";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60);
  return m + "m " + String(Math.round(s - m * 60)).padStart(2, "0") + "s";
}

export function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
