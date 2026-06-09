/* ============================================================================
 * Landing page (index.html): account widget, the puzzle catalogue, and a
 * per-puzzle leaderboard + difficulty detail.
 *
 * Puzzles are a fixed, named pool (no level numbers, no auto-create). The grid
 * can be sorted by difficulty signals — failure rate, how far players land from
 * the scramble's optimal, cube count, or name.
 *
 * The server (server/server.mjs) is the source of truth for the catalogue,
 * leaderboards and difficulty stats. If it's briefly unreachable we fall back to
 * a cold-start cache — the same catalogue computed from the deterministic
 * src/shared.mjs definitions plus your locally-saved best scores — so the page
 * still renders and you can keep playing until the connection returns.
 * ========================================================================== */

import * as api from "./api.mjs";
import { buildCatalog, gravatarUrl } from "./shared.mjs";

const LOCAL_KEY = "kcube.v1"; // same store the game writes best scores to

const state = { online: false, user: null, puzzles: [], sort: "featured" };

const $ = (id) => document.getElementById(id);

/* --- small helpers ---------------------------------------------------------- */

// Escape text before putting it in innerHTML (usernames come from the server).
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Locally-saved best scores (keyed by puzzle name), the offline "your best".
function readLocalBest() {
  try { return (JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}).best || {}; }
  catch { return {}; }
}

const dash = (v) => (v == null ? "–" : v);

// A small Gravatar avatar <img> for a username (or email). `d=retro` gives every
// player a stable generated icon even without a Gravatar account; onerror hides
// it so a broken image never leaves a gap.
function avatar(identifier, size = 18) {
  const src = gravatarUrl(identifier, { size: size * 2 }); // 2× for crisp HiDPI
  return `<img class="avatar" src="${esc(src)}" alt="" width="${size}" height="${size}" ` +
    `loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'">`;
}

function fmtMs(ms) {
  if (ms == null) return "–";
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + "s";
  const m = Math.floor(s / 60);
  return m + "m " + String(Math.round(s - m * 60)).padStart(2, "0") + "s";
}

const pct = (v) => (v == null ? "–" : Math.round(v * 100) + "%");

// "Moves over optimal": how far the world's best solve sits above the scramble's
// length — a measured proxy for how tricky the puzzle is in practice.
function overScramble(p) {
  return p.worldBest != null ? p.worldBest - p.scramble : null;
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
      `<span class="who-pill">${avatar(state.user.username)}@${esc(state.user.username)}</span>` +
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
    ["Puzzles solved", dash(s.solved)],
    ["Attempts", dash(s.attempts)],
    ["Win rate", s.attempts ? pct(s.winRate) : "–"],
    ["Avg moves over best-known", s.avgMovesOverOptimal == null ? "–" : "+" + s.avgMovesOverOptimal.toFixed(1)],
    ["Avg solve time", fmtMs(s.avgDurationMs)],
  ];
  box.innerHTML =
    `<h2>Your record</h2><div class="chips">` +
    chips.map(([k, v]) => `<div class="chip"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("") +
    `</div>`;
  box.classList.remove("hidden");
}

/* --- puzzle catalogue ------------------------------------------------------- */

// Cold-start cache: when the server can't be reached, render the same catalogue
// from the deterministic definitions plus your locally-saved bests.
function cachedCatalog() {
  const local = readLocalBest();
  return buildCatalog().map((p) => ({
    id: p.name,           // no DB id without the server; the name is the key everywhere
    name: p.name,
    numCubes: p.numCubes,
    scramble: p.scramble,
    par: p.par,
    optimal: null,
    pinned: false,
    yourBest: local[p.name] ?? null,
    worldBest: null,
    solvers: 0,
    attempts: 0,
    winRate: 0,
    failRate: 0,
    avgMoves: null,
  }));
}

// Comparators for each sort key. Nulls always sort last for "harder = higher".
const SORTS = {
  featured: null, // keep server/catalogue order (pinned first)
  fail: (a, b) => (b.failRate || 0) - (a.failRate || 0) || a.name.localeCompare(b.name),
  over: (a, b) => nullLast(overScramble(b)) - nullLast(overScramble(a)) || a.name.localeCompare(b.name),
  cubes: (a, b) => b.numCubes - a.numCubes || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};
const nullLast = (v) => (v == null ? -Infinity : v);

async function loadGrid() {
  let puzzles = state.online ? await api.listPuzzles() : null;
  if (!Array.isArray(puzzles)) puzzles = cachedCatalog();
  state.puzzles = puzzles;
  renderGrid();
}

// One puzzle card.
function cardHtml(p) {
  const solved = p.yourBest != null;
  const over = overScramble(p);
  return (
    `<div class="card${solved ? " solved" : ""}" data-name="${esc(p.name)}" tabindex="0" role="button">` +
      `<div class="card-top"><span class="lvl">${esc(p.name)}</span>` +
      (p.pinned ? `<span class="pin-badge" title="featured">★</span>` : "") +
      `<span class="dot" title="${solved ? "solved" : "unsolved"}"></span></div>` +
      `<div class="card-mid muted">${p.numCubes} cubes · par ${p.par}</div>` +
      `<div class="card-stats">` +
        `<span>you <b>${dash(p.yourBest)}</b></span>` +
        `<span>world <b>${dash(p.worldBest)}</b></span>` +
        (p.attempts ? `<span class="muted" title="failure rate across all players">${pct(p.failRate)} fail</span>` : "") +
        (over != null ? `<span class="muted" title="world best over scramble length">+${over} over</span>` : "") +
      `</div>` +
      `<div class="card-actions">` +
        `<span class="play-hint">Play ▸</span>` +
        `<button class="lb-btn link-btn" type="button" data-name="${esc(p.name)}">Leaderboard</button>` +
      `</div>` +
    `</div>`
  );
}

// Render the catalogue split into a "Featured" group (pinned puzzles, in admin
// order) and an "All puzzles" group (the rest), each sorted by the active key.
// With nothing pinned, fall back to a single ungrouped grid.
function renderGrid() {
  const cmp = SORTS[state.sort];
  const sortGroup = (arr) => (cmp ? [...arr].sort(cmp) : arr);
  const grid = $("grid");

  const pinned = state.puzzles.filter((p) => p.pinned);
  const others = state.puzzles.filter((p) => !p.pinned);

  if (pinned.length === 0) {
    grid.classList.remove("grouped");
    grid.innerHTML = sortGroup(others).map(cardHtml).join("");
    return;
  }

  const group = (title, hint, items) =>
    `<section class="level-group">` +
      `<h3 class="group-head">${title}<span class="muted group-count">${items.length}</span>` +
      (hint ? `<span class="muted group-hint">${hint}</span>` : "") + `</h3>` +
      `<div class="grid">${items.map(cardHtml).join("")}</div>` +
    `</section>`;

  grid.classList.add("grouped");
  grid.innerHTML =
    group(`<span class="pin-badge">★</span> Featured`, "hand-picked", sortGroup(pinned)) +
    group("All puzzles", "", sortGroup(others));
}

function go(name) { location.href = `play.html?puzzle=${encodeURIComponent(name)}`; }

// Delegated grid clicks: the Leaderboard button opens the detail; anything else
// on a card starts that puzzle.
$("grid").addEventListener("click", (e) => {
  const lb = e.target.closest(".lb-btn");
  if (lb) { e.stopPropagation(); openDetail(lb.dataset.name); return; }
  const card = e.target.closest(".card");
  if (card) go(card.dataset.name);
});
$("grid").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest(".card");
  if (card) { e.preventDefault(); go(card.dataset.name); }
});

/* --- per-puzzle detail (leaderboard + difficulty) --------------------------- */

async function openDetail(name) {
  const body = $("detailBody");
  body.innerHTML = `<h2>${esc(name)}</h2><p class="muted">Loading…</p>`;
  $("detail").classList.remove("hidden");

  const info = state.online ? await api.getPuzzle(name) : null;
  if (!info) {
    body.innerHTML =
      `<h2>${esc(name)}</h2>` +
      `<p class="muted">Leaderboards &amp; difficulty stats will load once the ` +
      `server is reachable again. You can still play the puzzle now.</p>` +
      `<button class="primary" type="button" id="detailPlay">Play ${esc(name)}</button>`;
    $("detailPlay").addEventListener("click", () => go(name));
    return;
  }

  const st = info.stats || {};
  const rows = (info.leaderboard || []).map((r, i) =>
    `<tr${r.you ? ' class="me"' : ""}>` +
    `<td>${i + 1}</td><td>${avatar(r.username)}@${esc(r.username)}</td>` +
    `<td>${r.best}</td><td>${fmtMs(r.durationMs)}</td><td>${dash(r.attempts)}</td></tr>`
  ).join("");

  const diff = [
    ["Players", dash(st.players)],
    ["Attempts", dash(st.attempts)],
    ["Solves", dash(st.solves)],
    ["Win rate", st.attempts ? pct(st.winRate) : "–"],
    ["Failure rate", st.attempts ? pct(st.failRate) : "–"],
    ["Scramble length", dash(info.scramble)],
    ["World best", dash(info.worldBest)],
    ["Avg winning moves", st.avgMoves == null ? "–" : st.avgMoves.toFixed(1)],
    ["Avg attempts to first solve", st.avgAttemptsToSolve == null ? "–" : st.avgAttemptsToSolve.toFixed(1)],
    ["Avg attempts to personal best", st.avgAttemptsToBest == null ? "–" : st.avgAttemptsToBest.toFixed(1)],
    ["Avg solve time", fmtMs(st.avgDurationMs)],
  ];

  body.innerHTML =
    `<h2>${esc(info.name)} <span class="muted">· ${dash(info.numCubes)} cubes · par ${dash(info.par)}</span></h2>` +
    `<div class="chips small">` +
    diff.map(([k, v]) => `<div class="chip"><span class="k">${k}</span><span class="v">${v}</span></div>`).join("") +
    `</div>` +
    `<h3>Leaderboard</h3>` +
    (rows
      ? `<table class="lb"><thead><tr><th>#</th><th>player</th><th>moves</th><th>time</th><th>tries</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="muted">No solves yet — be the first.</p>`) +
    `<button class="primary" type="button" id="detailPlay">Play ${esc(info.name)}</button>`;
  $("detailPlay").addEventListener("click", () => go(info.name));
}

function closeDetail() { $("detail").classList.add("hidden"); }
$("detailClose").addEventListener("click", closeDetail);
$("detail").addEventListener("click", (e) => { if (e.target.id === "detail") closeDetail(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

$("sortBy").addEventListener("change", (e) => {
  state.sort = e.target.value;
  renderGrid();
});

/* --- boot ------------------------------------------------------------------- */

async function boot() {
  state.online = await api.probe();
  $("offline").classList.toggle("hidden", state.online);
  state.user = state.online ? await api.me() : null;
  renderAccount();
  await Promise.all([loadGrid(), renderMyStats()]);
}

boot();
