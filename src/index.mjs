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
import { buildCatalog } from "./shared.mjs";
import { setupTheme } from "./theme.mjs";
import { $, esc, dash, pct, fmt1, fmtMs, avatarHtml, renderAccountWidget } from "./ui.mjs";

const LOCAL_KEY = "kcube.v1"; // same store the game writes best scores to

const state = { online: false, user: null, puzzles: [], sort: "featured", sortDir: "desc" };

/* --- small helpers ---------------------------------------------------------- */

// Locally-saved best scores (keyed by puzzle name), the offline "your best".
// Values are coerced to finite numbers (anything else → null) so a tampered
// localStorage entry can never inject markup into the card HTML.
function readLocalBest() {
  try {
    const raw = (JSON.parse(localStorage.getItem(LOCAL_KEY)) || {}).best || {};
    const best = {};
    for (const [name, v] of Object.entries(raw)) {
      const n = Number(v);
      best[name] = Number.isFinite(n) ? n : null;
    }
    return best;
  } catch { return {}; }
}

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
  renderAccountWidget(box, state.user, {
    avatar: true,
    adminLink: true,
    settingsLink: true,
    onSignOut: () => { api.clearToken(); boot(); },
  });
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
    ["Avg moves over best-known", s.avgMovesOverOptimal == null ? "–" : "+" + fmt1(s.avgMovesOverOptimal)],
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

// Default direction for each sort key (null = no direction toggle, e.g. featured).
const SORT_DEFAULT_DIR = {
  featured: null, fail: "desc", over: "desc", effort: "desc",
  scramble: "desc", cubes: "desc", name: "asc",
};

// Null-last sentinels for ascending and descending numeric comparisons.
const nlD = (v) => (v == null ? -Infinity : v); // desc: nulls sort last
const nlA = (v) => (v == null ? Infinity : v);  // asc:  nulls sort last

// Return a comparator for the given sort key and direction.
function getSortFn(key, dir) {
  if (key === "featured") return null;
  const tb = (a, b) => a.name.localeCompare(b.name);
  if (dir === "desc") {
    switch (key) {
      case "fail":    return (a, b) => (b.failRate || 0) - (a.failRate || 0) || tb(a, b);
      case "over":    return (a, b) => nlD(overScramble(b)) - nlD(overScramble(a)) || tb(a, b);
      case "effort":  return (a, b) => {
        const av = a.minBeamWidth ?? null, bv = b.minBeamWidth ?? null;
        if (av === null && bv === null) return b.scramble - a.scramble || tb(a, b);
        if (av === null) return 1;
        if (bv === null) return -1;
        return bv - av || b.scramble - a.scramble || tb(a, b);
      };
      case "scramble": return (a, b) => b.scramble - a.scramble || tb(a, b);
      case "cubes":    return (a, b) => b.numCubes - a.numCubes || tb(a, b);
      case "name":     return (a, b) => b.name.localeCompare(a.name);
    }
  } else {
    switch (key) {
      case "fail":    return (a, b) => (a.failRate || 0) - (b.failRate || 0) || tb(a, b);
      case "over":    return (a, b) => nlA(overScramble(a)) - nlA(overScramble(b)) || tb(a, b);
      case "effort":  return (a, b) => {
        const av = a.minBeamWidth ?? null, bv = b.minBeamWidth ?? null;
        if (av === null && bv === null) return a.scramble - b.scramble || tb(a, b);
        if (av === null) return 1;
        if (bv === null) return -1;
        return av - bv || a.scramble - b.scramble || tb(a, b);
      };
      case "scramble": return (a, b) => a.scramble - b.scramble || tb(a, b);
      case "cubes":    return (a, b) => a.numCubes - b.numCubes || tb(a, b);
      case "name":     return tb;
    }
  }
  return null;
}

async function loadGrid() {
  let puzzles = state.online ? await api.listPuzzles() : null;
  if (!Array.isArray(puzzles)) puzzles = cachedCatalog();
  state.puzzles = puzzles;
  renderGrid();
}

// Colour palette matching FACE_AXES order (0=white … 5=green).
const COLOR_META = [
  { label: "white",  hex: "#d0d4de", dark: true  },
  { label: "yellow", hex: "#ffd23f", dark: true  },
  { label: "red",    hex: "#e5484d", dark: false },
  { label: "orange", hex: "#ff7a1a", dark: false },
  { label: "blue",   hex: "#3aa0ff", dark: false },
  { label: "green",  hex: "#3ecf6b", dark: true  },
];

function colorCell(colorBeams, i) {
  const cm = COLOR_META[i];
  const v = colorBeams ? colorBeams[i] : null;
  if (v == null) {
    return `<td class="cb-cell"><span class="cb-chip cb-unsolved" title="beam not run for ${cm.label}">–</span></td>`;
  }
  const txtClass = cm.dark ? "cb-dark" : "cb-light";
  return `<td class="cb-cell"><span class="cb-chip ${txtClass}" style="background:${cm.hex}" title="beam moves — ${cm.label} target">${v}</span></td>`;
}

// One puzzle list row.
function rowHtml(p) {
  const solved = p.yourBest != null;
  const colorCells = COLOR_META.map((_, i) => colorCell(p.colorBeams, i)).join("");
  return (
    `<tr class="puzzle-row${solved ? " solved" : ""}" data-name="${esc(p.name)}" tabindex="0">` +
    `<td class="pl-dot-cell"><span class="row-dot${solved ? " row-dot-solved" : ""}" title="${solved ? "solved" : "unsolved"}"></span></td>` +
    `<td class="pl-name-cell">${esc(p.name)}${p.pinned ? ` <span class="pin-badge" title="featured">★</span>` : ""}</td>` +
    `<td class="pl-num-cell">${p.numCubes}</td>` +
    `<td class="pl-num-cell">${p.par}</td>` +
    `<td class="pl-num-cell">${p.minBeamWidth != null ? `<span class="effort-val">w${p.minBeamWidth}</span>` : `<span class="muted">–</span>`}</td>` +
    `<td class="pl-num-cell">${p.attempts ? pct(p.failRate) : `<span class="muted">–</span>`}</td>` +
    `<td class="pl-num-cell">${dash(p.worldBest)}</td>` +
    `<td class="pl-num-cell">${dash(p.yourBest)}</td>` +
    colorCells +
    `<td class="pl-act-cell">` +
      `<span class="play-hint">Play ▸</span>` +
      `<button class="lb-btn link-btn" type="button" data-name="${esc(p.name)}">Scores</button>` +
    `</td>` +
    `</tr>`
  );
}

const COLOR_HEADS = COLOR_META.map(
  (cm) => `<th class="cb-cell" title="beam moves — ${cm.label} target">` +
    `<span class="cb-header-dot" style="background:${cm.hex}"></span></th>`
).join("");

function tableHtml(items) {
  return (
    `<div class="puzzle-list-wrap">` +
    `<table class="puzzle-list">` +
    `<thead><tr>` +
    `<th class="pl-dot-col" aria-label="Solved"></th>` +
    `<th class="pl-name-col">Name</th>` +
    `<th class="pl-num-col">Cubes</th>` +
    `<th class="pl-num-col">Par</th>` +
    `<th class="pl-num-col">Effort</th>` +
    `<th class="pl-num-col">Fail&nbsp;%</th>` +
    `<th class="pl-num-col">World</th>` +
    `<th class="pl-num-col">You</th>` +
    COLOR_HEADS +
    `<th class="pl-act-col"></th>` +
    `</tr></thead>` +
    `<tbody>${items.map(rowHtml).join("")}</tbody>` +
    `</table>` +
    `</div>`
  );
}

// Render the catalogue split into a "Featured" group (pinned puzzles, in admin
// order) and an "All puzzles" group (the rest), each sorted by the active key.
// With nothing pinned, fall back to a single ungrouped grid.
// Human-readable sort labels for the announced status line.
const SORT_LABELS = {
  featured: "featured", fail: "fail rate", over: "moves gap", effort: "effort",
  scramble: "scramble", cubes: "cubes", name: "name",
};

// One short aria-live status line ("40 puzzles · sorted by fail rate") instead
// of announcing the whole grid — screen readers shouldn't be flooded on resort.
function updateGridStatus() {
  const el = $("gridStatus");
  if (!el) return;
  const n = state.puzzles.length;
  const label = SORT_LABELS[state.sort] || state.sort;
  el.textContent = `${n} puzzle${n === 1 ? "" : "s"} · sorted by ${label}`;
}

function renderGrid() {
  updateGridStatus();
  const cmp = getSortFn(state.sort, state.sortDir);
  const sortGroup = (arr) => (cmp ? [...arr].sort(cmp) : arr);
  const grid = $("grid");

  const pinned = state.puzzles.filter((p) => p.pinned);
  const others = state.puzzles.filter((p) => !p.pinned);

  if (pinned.length === 0) {
    grid.innerHTML = tableHtml(sortGroup(others));
    return;
  }

  const group = (title, hint, items) =>
    `<section class="level-group">` +
      `<h3 class="group-head">${title}<span class="muted group-count">${items.length}</span>` +
      (hint ? `<span class="muted group-hint">${hint}</span>` : "") + `</h3>` +
      tableHtml(items) +
    `</section>`;

  grid.innerHTML =
    group(`<span class="pin-badge">★</span> Featured`, "hand-picked", sortGroup(pinned)) +
    group("All puzzles", "", sortGroup(others));
}

function go(name) { location.href = `play.html?puzzle=${encodeURIComponent(name)}`; }

// Delegated grid clicks: the Scores button opens the detail; anything else
// on a row starts that puzzle.
$("grid").addEventListener("click", (e) => {
  const lb = e.target.closest(".lb-btn");
  if (lb) { openDetail(lb.dataset.name); return; }
  const row = e.target.closest(".puzzle-row");
  if (row) go(row.dataset.name);
});
$("grid").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  if (e.target.closest(".lb-btn")) return;
  const row = e.target.closest(".puzzle-row");
  if (row) { e.preventDefault(); go(row.dataset.name); }
});

/* --- per-puzzle detail (leaderboard + difficulty) --------------------------- */

// Generation counter: a slow response for an earlier dialog must never
// overwrite the one currently open.
let detailGen = 0;
// The element focused before the dialog opened, restored on close.
let detailReturnFocus = null;

async function openDetail(name) {
  const gen = ++detailGen;
  const body = $("detailBody");
  body.innerHTML = `<h2>${esc(name)}</h2><p class="muted">Loading…</p>`;
  if ($("detail").classList.contains("hidden")) {
    detailReturnFocus = document.activeElement;
    $("detail").classList.remove("hidden");
  }
  $("detailClose").focus();

  const info = state.online ? await api.getPuzzle(name) : null;
  if (gen !== detailGen) return; // a newer openDetail/close superseded this load
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
    `<td>${i + 1}</td><td>${avatarHtml(r)}@${esc(r.username)}</td>` +
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
    ["Avg winning moves", fmt1(st.avgMoves)],
    ["Avg attempts to first solve", fmt1(st.avgAttemptsToSolve)],
    ["Avg attempts to personal best", fmt1(st.avgAttemptsToBest)],
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

function closeDetail() {
  const d = $("detail");
  if (d.classList.contains("hidden")) return;
  detailGen++; // invalidate any in-flight load for the dialog we just closed
  d.classList.add("hidden");
  if (detailReturnFocus && typeof detailReturnFocus.focus === "function") {
    detailReturnFocus.focus();
  }
  detailReturnFocus = null;
}
$("detailClose").addEventListener("click", closeDetail);
$("detail").addEventListener("click", (e) => { if (e.target.id === "detail") closeDetail(); });
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

function updateSortChips() {
  document.querySelectorAll(".sort-chip").forEach((chip) => {
    const key = chip.dataset.sort;
    const active = key === state.sort;
    chip.classList.toggle("active", active);
    chip.setAttribute("aria-pressed", active ? "true" : "false");
    const dirEl = chip.querySelector(".sort-dir");
    if (dirEl) dirEl.textContent = state.sortDir === "desc" ? "↓" : "↑";
  });
}

$("sortBar").addEventListener("click", (e) => {
  const chip = e.target.closest(".sort-chip");
  if (!chip) return;
  const key = chip.dataset.sort;
  if (key === state.sort && SORT_DEFAULT_DIR[key] !== null) {
    state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
  } else {
    state.sort = key;
    state.sortDir = SORT_DEFAULT_DIR[key] ?? "desc";
  }
  updateSortChips();
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

setupTheme();
boot();
