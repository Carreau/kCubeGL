import * as api from './api.mjs';

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

let currentUser = null;

function renderAccount() {
  const box = $('account');
  if (!currentUser) {
    box.innerHTML = `<a href="login.html" class="primary" style="text-decoration:none;font-size:13px;padding:8px 18px">Sign In</a>`;
    return;
  }
  box.innerHTML =
    `<span class="who-pill">@${esc(currentUser.username)}</span>` +
    `<a href="index.html" class="link-btn" style="text-decoration:none">Levels</a>` +
    `<button id="signout" class="link-btn" type="button">Sign out</button>`;
  $('signout').addEventListener('click', () => { api.clearToken(); location.href = 'login.html'; });
}

async function loadUsers() {
  const wrap = $('userTableWrap');
  const users = await api.adminListUsers();
  if (!users) {
    wrap.innerHTML = '<p class="muted">Could not load users. Are you an admin?</p>';
    return;
  }
  if (users.length === 0) {
    wrap.innerHTML = '<p class="muted">No users yet.</p>';
    return;
  }

  const rows = users.map(u => {
    const isSelf = currentUser && u.id === currentUser.id;
    return `<tr data-uid="${u.id}">
      <td>${u.id}</td>
      <td>@${esc(u.username)}${isSelf ? ' <span class="you-badge">you</span>' : ''}</td>
      <td>${fmtDate(u.createdAt)}</td>
      <td class="admin-cell">${u.isAdmin ? '<span class="admin-badge">admin</span>' : '–'}</td>
      <td>${u.passkeyCount}</td>
      <td class="actions-cell">
        ${!isSelf ? `<button class="link-btn toggle-admin-btn" data-uid="${u.id}" data-admin="${u.isAdmin ? '1' : '0'}" type="button">${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>` : ''}
        ${!isSelf ? `<button class="link-btn danger-btn delete-btn" data-uid="${u.id}" data-name="${esc(u.username)}" type="button">Delete</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML =
    `<table class="admin-table">
      <thead><tr><th>ID</th><th>Username</th><th>Joined</th><th>Role</th><th>Passkeys</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  wrap.querySelectorAll('.toggle-admin-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = Number(btn.dataset.uid);
      const makeAdmin = btn.dataset.admin === '0';
      try {
        await api.adminUpdateUser(uid, { isAdmin: makeAdmin });
        await loadUsers();
      } catch (e) {
        alert(`Failed: ${e.message}`);
      }
    });
  });

  wrap.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete user @${btn.dataset.name}? This cannot be undone.`)) return;
      try {
        await api.adminDeleteUser(Number(btn.dataset.uid));
        await loadUsers();
      } catch (e) {
        alert(`Failed: ${e.message}`);
      }
    });
  });
}

/* --- Featured puzzles: pin + order ----------------------------------------- */

// Working copy of the pinned order (an array of puzzle ids), edited locally and
// persisted with "Save order". `puzzles` is the full catalogue (server order);
// `savedFeatured` is the pinned order as the server currently has it, so we can
// tell when the working copy has unsaved edits.
let puzzles = [];
let featured = [];
let savedFeatured = [];
let dragId = null; // id of the row being dragged (drag-to-reorder)
let solverRunning = false; // guards the (slow) solver run from re-entry

const pct = (v) => (v == null ? '–' : Math.round(v * 100) + '%');
const dash = (v) => (v == null ? '–' : v);

const sameOrder = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const isDirty = () => !sameOrder(featured, savedFeatured);

async function loadPuzzles() {
  const wrap = $('puzzleAdminWrap');
  puzzles = await api.adminListPuzzles();
  if (!Array.isArray(puzzles)) {
    wrap.innerHTML = '<p class="muted">Could not load puzzles.</p>';
    return;
  }
  featured = puzzles.filter((p) => p.pinned).map((p) => p.id);
  savedFeatured = featured.slice();
  renderPuzzles();
}

function byId(id) { return puzzles.find((p) => p.id === id); }

function puzzleRow(p, opts = {}) {
  // Solver difficulty signals: the full (BFS) optimal and the beam-search
  // approximate roll counts — handy for judging how hard a puzzle really is when
  // ordering. "?" means the solver hasn't been run for this puzzle yet; "–"
  // means it ran but that solver found no solution within its budget.
  const solved = p.solvedAt != null;
  const solverMeta = solved
    ? `<span class="solver-meta" title="full solver (BFS-optimal) roll count">opt ${dash(p.fullOptimal)}</span>` +
      ` · <span class="solver-meta" title="beam-search approximate roll count">beam ${dash(p.beamMoves)}</span>`
    : `<span class="solver-meta unsolved" title="solver not run yet">opt ? · beam ?</span>`;
  const meta =
    `${p.numCubes} cubes · scramble ${p.scramble} · ${pct(p.failRate)} fail` +
    (p.worldBest != null ? ` · world ${p.worldBest}` : '') + ' · ' + solverMeta;
  const handle = opts.draggable ? '<span class="drag-handle" title="drag to reorder">⠿</span>' : '';
  const solveBtn =
    `<button class="link-btn solve-btn" data-id="${p.id}" type="button" title="run BFS + beam solvers">${solved ? 'Re-solve' : 'Solve'}</button>`;
  return `<div class="puzzle-row${opts.draggable ? ' draggable' : ''}" data-id="${p.id}"${opts.draggable ? ' draggable="true"' : ''}>
    ${handle}<span class="puzzle-name">${esc(p.name)}</span>
    <span class="muted puzzle-meta">${meta}</span>
    <span class="puzzle-actions">${solveBtn}${opts.actions || ''}</span>
  </div>`;
}

function renderPuzzles() {
  const wrap = $('puzzleAdminWrap');
  const featuredRows = featured.map((id, i) => {
    const p = byId(id);
    if (!p) return '';
    const actions =
      `<button class="link-btn move-btn" data-id="${id}" data-dir="-1" type="button" ${i === 0 ? 'disabled' : ''}>↑</button>` +
      `<button class="link-btn move-btn" data-id="${id}" data-dir="1" type="button" ${i === featured.length - 1 ? 'disabled' : ''}>↓</button>` +
      `<button class="link-btn unpin-btn" data-id="${id}" type="button">Unpin</button>`;
    return puzzleRow(p, { actions, draggable: true });
  }).join('');

  const others = puzzles.filter((p) => !featured.includes(p.id));
  const otherRows = others.map((p) =>
    puzzleRow(p, { actions: `<button class="link-btn pin-btn" data-id="${p.id}" type="button">Pin</button>` })
  ).join('');

  const dirty = isDirty();
  const status = dirty
    ? '<span class="unsaved-badge">● Unsaved changes</span>'
    : '<span class="muted">All changes saved</span>';

  // Solver run toolbar: how many puzzles have solver values, plus a button to
  // run the (slow) BFS + beam solvers for any that don't yet.
  const total = puzzles.length;
  const solvedCount = puzzles.filter((p) => p.solvedAt != null).length;
  const pending = total - solvedCount;
  const runLabel = solverRunning
    ? 'Running solver…'
    : (pending > 0 ? `Run solver (${pending} pending)` : 'Re-run solver (all)');

  wrap.innerHTML =
    `<div class="puzzle-list${dirty ? ' dirty' : ''}">
       <div class="solver-bar">
         <button id="runSolver" class="primary" type="button" ${solverRunning ? 'disabled' : ''}>${runLabel}</button>
         <span class="muted">${solvedCount}/${total} solved</span>
         <span id="solverStatus" class="muted"></span>
       </div>
       <h3>Featured (${featured.length})${dirty ? ' <span class="unsaved-dot" title="unsaved changes">●</span>' : ''}</h3>
       <p class="muted drag-hint">Drag rows (or use ↑/↓) to reorder featured puzzles.</p>
       ${featuredRows || '<p class="muted">None pinned yet — pin a puzzle below.</p>'}
       <div class="puzzle-save">
         <button id="savePuzzleOrder" class="primary" type="button" ${dirty ? '' : 'disabled'}>Save order</button>
         <button id="resetPuzzleOrder" class="link-btn" type="button" ${dirty ? '' : 'disabled'}>Discard</button>
         <span id="puzzleSaveStatus">${status}</span>
         <span id="puzzleSaveMsg" class="muted"></span>
       </div>
       <h3>All puzzles</h3>
       ${otherRows || '<p class="muted">All puzzles are featured.</p>'}
     </div>`;

  wrap.querySelectorAll('.pin-btn').forEach((b) =>
    b.addEventListener('click', () => { featured.push(Number(b.dataset.id)); renderPuzzles(); }));
  wrap.querySelectorAll('.unpin-btn').forEach((b) =>
    b.addEventListener('click', () => { featured = featured.filter((id) => id !== Number(b.dataset.id)); renderPuzzles(); }));
  wrap.querySelectorAll('.move-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const id = Number(b.dataset.id);
      const dir = Number(b.dataset.dir);
      const i = featured.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= featured.length) return;
      [featured[i], featured[j]] = [featured[j], featured[i]];
      renderPuzzles();
    }));

  wireDragReorder(wrap);

  wrap.querySelectorAll('.solve-btn').forEach((b) =>
    b.addEventListener('click', () => runSolver([Number(b.dataset.id)])));
  $('runSolver').addEventListener('click', () => {
    // Solve everything still pending; if all are solved, re-run the whole set.
    const targets = pending > 0
      ? puzzles.filter((p) => p.solvedAt == null).map((p) => p.id)
      : puzzles.map((p) => p.id);
    runSolver(targets);
  });

  $('resetPuzzleOrder').addEventListener('click', () => {
    featured = savedFeatured.slice();
    renderPuzzles();
  });
  $('savePuzzleOrder').addEventListener('click', async () => {
    const msg = $('puzzleSaveMsg');
    msg.textContent = 'Saving…';
    try {
      await api.adminReorderPuzzles(featured);
      await loadPuzzles();
      $('puzzleSaveMsg').textContent = 'Saved.';
    } catch (e) {
      msg.textContent = `Failed: ${e.message}`;
    }
  });
}

// HTML5 drag-and-drop to reorder featured rows. The dragged id is moved to the
// drop target's position; the list re-renders (which marks it unsaved).
function wireDragReorder(wrap) {
  wrap.querySelectorAll('.puzzle-row.draggable').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      dragId = Number(row.dataset.id);
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Some browsers require data to be set for the drag to start.
      try { e.dataTransfer.setData('text/plain', String(dragId)); } catch { /* ignore */ }
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      wrap.querySelectorAll('.puzzle-row').forEach((r) => r.classList.remove('dragging', 'drop-target'));
    });
    row.addEventListener('dragover', (e) => {
      if (dragId == null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (Number(row.dataset.id) !== dragId) row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const targetId = Number(row.dataset.id);
      if (dragId == null || targetId === dragId) return;
      const from = featured.indexOf(dragId);
      const to = featured.indexOf(targetId);
      if (from < 0 || to < 0) return;
      featured.splice(from, 1);
      featured.splice(to, 0, dragId);
      dragId = null;
      renderPuzzles();
    });
  });
}

// Run the BFS + beam solvers for the given puzzle ids, one request at a time
// (each can take a few seconds), folding each result back into the local
// catalogue and refreshing the rows + progress as we go.
async function runSolver(ids) {
  if (solverRunning || !ids.length) return;
  solverRunning = true;
  renderPuzzles();
  const status = $('solverStatus');
  let done = 0, failed = 0;
  for (const id of ids) {
    const p = byId(id);
    if (status) status.textContent = `Solving ${p ? p.name : id}… (${done}/${ids.length})`;
    try {
      const r = await api.adminSolvePuzzle(id);
      if (p) { p.fullOptimal = r.fullOptimal; p.beamMoves = r.beamMoves; p.solvedAt = r.solvedAt; }
    } catch {
      failed++;
    }
    done++;
  }
  solverRunning = false;
  renderPuzzles();
  const note = $('solverStatus');
  if (note) note.textContent = failed ? `Done — ${failed} failed.` : 'Done.';
}

async function boot() {
  const online = await api.probe();
  if (!online) {
    $('userTableWrap').innerHTML = "<p class=\"muted\">Can't reach the server right now — admin needs it running.</p>";
    return;
  }
  currentUser = await api.me();
  renderAccount();
  if (!currentUser?.isAdmin) {
    $('userTableWrap').innerHTML = '<p class="muted">You must be an admin to view this page. <a href="login.html" style="color:var(--accent)">Sign in</a>.</p>';
    $('puzzleAdminWrap').innerHTML = '';
    return;
  }
  await Promise.all([loadUsers(), loadPuzzles()]);
}

boot();
