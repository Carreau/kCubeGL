/* ============================================================================
 * Landing page (index.html): account widget, level grid, and per-level
 * leaderboard + difficulty detail.
 *
 * Works against the optional backend (server/server.mjs) but degrades cleanly:
 * with no server it still renders a level grid from the deterministic level
 * params and your locally-saved best scores — just without leaderboards.
 * ========================================================================== */

import * as api from "./api.mjs";
import { levelParams, baseBudget } from "./shared.mjs";

const LOCAL_KEY = "kcube.v1"; // same store the game writes best scores to

const state = { online: false, user: null, levels: [] };

const $ = (id) => document.getElementById(id);

/* --- small helpers ---------------------------------------------------------- */

// Escape text before putting it in innerHTML (usernames come from the server).
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Locally-saved best scores, used as the offline fallback for "your best".
function readLocalBest() {
  try { return (JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}).best || {}; }
  catch { return {}; }
}

const dash = (v) => (v == null ? "–" : v);

function fmtMs(ms) {
  if (ms == null) return "–";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60);
  return m + "m " + String(Math.round(s - m * 60)).padStart(2, "0") + "s";
}

function clampCount() {
  const n = parseInt($("levelCount").value, 10);
  return Number.isFinite(n) ? Math.max(6, Math.min(60, n)) : 12;
}

/* --- account widget --------------------------------------------------------- */

function renderAccount() {
  const box = $("account");
  if (!state.online) {
    box.innerHTML = `<span class="who-pill offline-pill">offline</span>`;
    return;
  }
  if (state.user) {
    box.innerHTML =
      `<span class="who-pill">@${esc(state.user.username)}</span>` +
      (state.user.isAdmin ? `<a href="admin.html" class="link-btn">Admin</a>` : '') +
      `<button id="signout" class="link-btn" type="button">Sign out</button>`;
    $("signout").addEventListener("click", () => { api.clearToken(); boot(); });
    return;
  }
  box.innerHTML =
    `<a href="login.html" class="primary" style="text-decoration:none;font-size:13px;padding:8px 18px">Sign In</a>`;
}

/* --- your skill summary ----------------------------------------------------- */

async function renderMyStats() {
  const box = $("mystats");
  if (!state.online || !state.user) { box.classList.add("hidden"); return; }
  const s = await api.myStats();
  if (!s) { box.classList.add("hidden"); return; }
  const chips = [
    ["Levels solved", dash(s.solved)],
    ["Attempts", dash(s.attempts)],
    ["Win rate", s.attempts ? Math.round(s.winRate * 100) + "%" : "–"],
    ["Avg moves over best-known", s.avgMovesOverOptimal == null ? "–" : "+" + s.avgMovesOverOptimal.toFixed(1)],
    ["Avg solve time", fmtMs(s.avgDurationMs)],
  ];
  box.innerHTML =
    `<h2>Your record</h2><div class="chips">` +
    chips.map(([k, v]) => `<div class="chip"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("") +
    `</div>`;
  box.classList.remove("hidden");
}

/* --- level grid ------------------------------------------------------------- */

function offlineLevels(count) {
  const local = readLocalBest();
  return Array.from({ length: count }, (_, i) => {
    const level = i + 1;
    return {
      level,
      numCubes: levelParams(level).numCubes,
      par: baseBudget(level),
      optimal: null,
      yourBest: local[level] ?? null,
      worldBest: null,
      solvers: 0,
    };
  });
}

async function loadGrid() {
  const count = clampCount();
  let levels = state.online ? await api.listLevels(count) : null;
  if (!Array.isArray(levels)) levels = offlineLevels(count);
  state.levels = levels;
  renderGrid(levels);
}

function renderGrid(levels) {
  $("grid").innerHTML = levels.map((L) => {
    const solved = L.yourBest != null;
    return (
      `<div class="card${solved ? " solved" : ""}" data-level="${L.level}" tabindex="0" role="button">` +
        `<div class="card-top"><span class="lvl">Level ${L.level}</span>` +
        `<span class="dot" title="${solved ? "solved" : "unsolved"}"></span></div>` +
        `<div class="card-mid muted">${L.numCubes} cubes · par ${L.par}` +
        (L.optimal ? ` · best-known ${L.optimal}` : "") + `</div>` +
        `<div class="card-stats">` +
          `<span>you <b>${dash(L.yourBest)}</b></span>` +
          `<span>world <b>${dash(L.worldBest)}</b></span>` +
          (L.solvers ? `<span class="muted">${L.solvers} solved</span>` : "") +
        `</div>` +
        `<div class="card-actions">` +
          `<span class="play-hint">Play ▸</span>` +
          `<button class="lb-btn link-btn" type="button" data-level="${L.level}">Leaderboard</button>` +
        `</div>` +
      `</div>`
    );
  }).join("");
}

function go(level) { location.href = `play.html?level=${level}`; }

// Delegated grid clicks: the Leaderboard button opens the detail; anything else
// on a card starts that level.
$("grid").addEventListener("click", (e) => {
  const lb = e.target.closest(".lb-btn");
  if (lb) { e.stopPropagation(); openDetail(Number(lb.dataset.level)); return; }
  const card = e.target.closest(".card");
  if (card) go(Number(card.dataset.level));
});
$("grid").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest(".card");
  if (card) { e.preventDefault(); go(Number(card.dataset.level)); }
});

/* --- per-level detail (leaderboard + difficulty) ---------------------------- */

async function openDetail(level) {
  const body = $("detailBody");
  body.innerHTML = `<h2>Level ${level}</h2><p class="muted">Loading…</p>`;
  $("detail").classList.remove("hidden");

  const info = state.online ? await api.getLevel(level) : null;
  if (!info) {
    body.innerHTML =
      `<h2>Level ${level}</h2>` +
      `<p class="muted">Leaderboards &amp; difficulty stats need the server. ` +
      `Run <code>npm start</code> and sign in.</p>` +
      `<button class="primary" type="button" id="detailPlay">Play level ${level}</button>`;
    $("detailPlay").addEventListener("click", () => go(level));
    return;
  }

  const st = info.stats || {};
  const rows = (info.leaderboard || []).map((r, i) =>
    `<tr${r.you ? ' class="me"' : ""}>` +
    `<td>${i + 1}</td><td>@${esc(r.username)}</td>` +
    `<td>${r.best}</td><td>${fmtMs(r.durationMs)}</td><td>${dash(r.attempts)}</td></tr>`
  ).join("");

  const diff = [
    ["Players", dash(st.players)],
    ["Attempts", dash(st.attempts)],
    ["Solves", dash(st.solves)],
    ["Win rate", st.attempts ? Math.round((st.winRate || 0) * 100) + "%" : "–"],
    ["World best", dash(info.worldBest)],
    ["Best-known", dash(info.optimal)],
    ["Avg winning moves", st.avgMoves == null ? "–" : st.avgMoves.toFixed(1)],
    ["Avg attempts to first solve", st.avgAttemptsToSolve == null ? "–" : st.avgAttemptsToSolve.toFixed(1)],
    ["Avg attempts to personal best", st.avgAttemptsToBest == null ? "–" : st.avgAttemptsToBest.toFixed(1)],
    ["Avg solve time", fmtMs(st.avgDurationMs)],
  ];

  body.innerHTML =
    `<h2>Level ${level} <span class="muted">· ${dash(info.numCubes)} cubes · par ${dash(info.par)}</span></h2>` +
    `<div class="chips small">` +
    diff.map(([k, v]) => `<div class="chip"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("") +
    `</div>` +
    `<h3>Leaderboard</h3>` +
    (rows
      ? `<table class="lb"><thead><tr><th>#</th><th>player</th><th>moves</th><th>time</th><th>tries</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">No solves yet — be the first.</p>`) +
    `<button class="primary" type="button" id="detailPlay">Play level ${level}</button>`;
  $("detailPlay").addEventListener("click", () => go(level));
}

function closeDetail() { $("detail").classList.add("hidden"); }
$("detailClose").addEventListener("click", closeDetail);
$("detail").addEventListener("click", (e) => { if (e.target.id === "detail") closeDetail(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

$("levelCount").addEventListener("change", loadGrid);

/* --- boot ------------------------------------------------------------------- */

async function boot() {
  state.online = await api.probe();
  $("offline").classList.toggle("hidden", state.online);
  state.user = state.online ? await api.me() : null;
  renderAccount();
  await Promise.all([loadGrid(), renderMyStats()]);
}

boot();
