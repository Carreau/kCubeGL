/* ============================================================================
 * ui.mjs — tiny DOM + formatting helpers shared by the page scripts
 * (index.mjs, admin.mjs, login.mjs, settings.mjs).
 *
 * Browser-only: src/shared.mjs must stay pure (it's imported by the server),
 * so anything that touches the DOM or formats for display lives here instead.
 * ========================================================================== */

import { gravatarUrl, gravatarUrlForHash } from "./shared.mjs";

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

// A small Gravatar avatar <img> for a player. `entry` is a { username, avatarHash }
// object (account or leaderboard row) or a bare username string: we use the real
// Gravatar hash when they linked an email, otherwise fall back to a username hash
// with `d=retro` so every player still gets a stable generated icon. Broken images
// are hidden by the delegated error listener below (no inline handlers, so pages
// stay CSP-compatible).
export function avatarHtml(entry, size = 18, className = "avatar") {
  const username = typeof entry === "string" ? entry : entry && entry.username;
  const hash = entry && typeof entry === "object" ? entry.avatarHash : null;
  const opts = { size: size * 2 }; // 2× for crisp HiDPI
  const src = hash ? gravatarUrlForHash(hash, opts) : gravatarUrl(username, opts);
  return `<img class="${esc(className)}" src="${esc(src)}" alt="" width="${size}" height="${size}" ` +
    `loading="lazy" referrerpolicy="no-referrer">`;
}

// Hide any avatar image that fails to load so it never leaves a broken-icon gap.
// Error events don't bubble, so listen in the capture phase.
if (typeof document !== "undefined") {
  document.addEventListener("error", (e) => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.matches(".avatar, .settings-avatar")) {
      t.style.display = "none";
    }
  }, true);
}

// Shared status-line helper for the auth/settings pages: show `msg` in `el`,
// styled as an error when `isErr` is true.
export function setStatus(el, msg, isErr = false) {
  if (!el) return;
  el.textContent = msg;
  el.className = "auth-status" + (isErr ? " auth-err" : "");
  el.classList.remove("hidden");
}
