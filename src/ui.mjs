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
export const fmt1 = (v) => (v == null ? "–" : v.toFixed(1));

export function fmtMs(ms) {
  if (ms == null) return "–";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60);
  return m + "m " + String(Math.round(s - m * 60)).padStart(2, "0") + "s";
}

export function fmtDate(ms) {
  if (ms == null) return "–"; // null-tolerant like the other formatters
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

// Shared status-line helpers for the auth/settings pages. `el` may be the
// status element itself or its id. setStatus shows `msg`, styled as an error
// when `isErr` is true; clearStatus hides the line again.
const statusEl = (el) => (typeof el === "string" ? $(el) : el);

export function setStatus(el, msg, isErr = false) {
  el = statusEl(el);
  if (!el) return;
  el.textContent = msg;
  el.className = "auth-status" + (isErr ? " auth-err" : "");
  el.classList.remove("hidden");
}

export function clearStatus(el) {
  el = statusEl(el);
  if (el) el.classList.add("hidden");
}

// The signed-in header widget shared by the landing and admin pages: who-pill
// (optionally with avatar), page links, and a Sign out button. Signed out it
// shows the Sign In link instead. `opts`:
//   avatar       — include the Gravatar avatar in the who-pill
//   adminLink    — link to admin.html (only rendered when user.isAdmin)
//   settingsLink — link to settings.html
//   levelsLink   — link back to index.html
//   onSignOut    — click handler for the Sign out button (the caller owns the
//                  api.mjs call; ui.mjs stays free of api imports)
export function renderAccountWidget(container, user, opts = {}) {
  if (!user) {
    container.innerHTML =
      `<a href="login.html" class="primary" style="text-decoration:none;font-size:13px;padding:8px 18px">Sign In</a>`;
    return;
  }
  container.innerHTML =
    `<span class="who-pill">${opts.avatar ? avatarHtml(user) : ""}@${esc(user.username)}</span>` +
    (opts.adminLink && user.isAdmin ? `<a href="admin.html" class="link-btn">Admin</a>` : "") +
    (opts.settingsLink ? `<a href="settings.html" class="link-btn">Settings</a>` : "") +
    (opts.levelsLink ? `<a href="index.html" class="link-btn" style="text-decoration:none">Levels</a>` : "") +
    `<button id="signout" class="link-btn" type="button">Sign out</button>`;
  if (opts.onSignOut) container.querySelector("#signout").addEventListener("click", opts.onSignOut);
}
