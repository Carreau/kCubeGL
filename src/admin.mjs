import * as api from './api.mjs';
import { setupTheme } from './theme.mjs';
import { $, esc, dash, pct, fmtDate, renderAccountWidget } from './ui.mjs';

let currentUser = null;

function renderAccount() {
  renderAccountWidget($('account'), currentUser, {
    levelsLink: true,
    onSignOut: () => { api.clearToken(); location.href = 'login.html'; },
  });
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
      <td>${u.hasPassword ? '<span class="pw-badge">pw</span>' : '–'}</td>
      <td class="actions-cell">
        ${!isSelf ? `<button class="link-btn toggle-admin-btn" data-uid="${u.id}" data-admin="${u.isAdmin ? '1' : '0'}" type="button">${u.isAdmin ? 'Remove admin' : 'Make admin'}</button>` : ''}
        ${!isSelf ? `<button class="link-btn reset-pw-btn" data-uid="${u.id}" data-name="${esc(u.username)}" data-haspw="${u.hasPassword ? '1' : '0'}" type="button">Reset password</button>` : ''}
        ${!isSelf ? `<button class="link-btn danger-btn delete-btn" data-uid="${u.id}" data-name="${esc(u.username)}" type="button">Delete</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML =
    `<table class="admin-table">
      <thead><tr><th>ID</th><th>Username</th><th>Joined</th><th>Role</th><th>Passkeys</th><th>Password</th><th>Actions</th></tr></thead>
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

  // Inline password-reset form (never window.prompt — that would echo the new
  // password as cleartext). Built via DOM so the username needs no escaping.
  wrap.querySelectorAll('.reset-pw-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const open = wrap.querySelector('.pw-reset-row');
      if (open) {
        const wasMine = open.dataset.uid === btn.dataset.uid;
        open.remove();
        if (wasMine) return; // second click toggles the form closed
      }
      const uid = Number(btn.dataset.uid);
      const hasPw = btn.dataset.haspw === '1';

      const tr = document.createElement('tr');
      tr.className = 'pw-reset-row';
      tr.dataset.uid = btn.dataset.uid;
      const td = document.createElement('td');
      td.colSpan = 7;

      const form = document.createElement('form');
      form.className = 'pw-reset-form';
      const label = document.createElement('label');
      label.textContent = hasPw
        ? `New password for @${btn.dataset.name} (blank clears it):`
        : `Set a password for @${btn.dataset.name} (min 8 chars):`;
      const input = document.createElement('input');
      input.type = 'password';
      input.autocomplete = 'new-password';
      input.placeholder = hasPw ? 'leave blank to clear' : 'minimum 8 characters';
      label.append(input);
      const save = document.createElement('button');
      save.type = 'submit';
      save.className = 'primary';
      save.textContent = 'Save';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'link-btn';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => tr.remove());
      const msg = document.createElement('span');
      msg.className = 'auth-err';
      form.append(label, save, cancel, msg);

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const newPw = input.value;
        if (newPw && newPw.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; return; }
        save.disabled = true;
        try {
          await api.adminResetUserPassword(uid, newPw || null);
          await loadUsers(); // re-render reflects the new pw badge
        } catch (err) {
          msg.textContent = `Failed: ${err.message}`;
          save.disabled = false;
        }
      });

      td.append(form);
      tr.append(td);
      btn.closest('tr').after(tr);
      input.focus();
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

let puzzles = [];
let featured = [];
let savedFeatured = [];
let dragId = null;
let solverRunning = false;

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

// Colour palette matching FACE_AXES in main.js (0=white … 5=green).
const COLOR_META = [
  { key: 'W', label: 'white',  hex: '#d0d4de', dark: true  },
  { key: 'Y', label: 'yellow', hex: '#ffd23f', dark: true  },
  { key: 'R', label: 'red',    hex: '#e5484d', dark: false },
  { key: 'O', label: 'orange', hex: '#ff7a1a', dark: false },
  { key: 'B', label: 'blue',   hex: '#3aa0ff', dark: false },
  { key: 'G', label: 'green',  hex: '#3ecf6b', dark: true  },
];

function colorBeamCell(colorBeams, colorIdx, solved) {
  const cm = COLOR_META[colorIdx];
  if (!solved) {
    return `<td class="cb-cell"><span class="cb-chip cb-unsolved" title="beam not run yet">?</span></td>`;
  }
  const v = colorBeams ? colorBeams[colorIdx] : null;
  const text = v == null ? '–' : v;
  const txtClass = cm.dark ? 'cb-dark' : 'cb-light';
  return `<td class="cb-cell"><span class="cb-chip ${txtClass}" style="background:${cm.hex}" title="beam moves for ${cm.label} target">${text}</span></td>`;
}

function puzzleTr(p, opts = {}) {
  const solved = p.solvedAt != null;
  const dragCell = opts.draggable
    ? `<td class="drag-cell"><span class="drag-handle" title="drag to reorder">⠿</span></td>`
    : `<td class="drag-cell"></td>`;

  const solveLabel = solved ? 'Re-solve' : 'Solve';
  const solveBtn = `<button class="link-btn solve-btn" data-id="${p.id}" type="button">${solveLabel}</button>`;

  const colorCells = COLOR_META.map((_, i) => colorBeamCell(p.colorBeams, i, solved)).join('');

  const bfsCell = solved
    ? `<td class="num-cell" title="BFS-optimal roll count">${dash(p.fullOptimal)}</td>`
    : `<td class="num-cell muted" title="not run yet">?</td>`;
  const beamCell = solved
    ? `<td class="num-cell" title="beam-search roll count">${dash(p.beamMoves)}</td>`
    : `<td class="num-cell muted" title="not run yet">?</td>`;
  const effortCell = solved
    ? `<td class="num-cell effort-cell" title="min beam width to solve (search effort; 1=easy)">${dash(p.minBeamWidth)}</td>`
    : `<td class="num-cell muted" title="not run yet">?</td>`;

  const attrs = opts.draggable ? ` class="puzzle-tr draggable" draggable="true" data-id="${p.id}"` : ` class="puzzle-tr" data-id="${p.id}"`;

  return `<tr${attrs}>
    ${dragCell}
    <td class="name-cell">${esc(p.name)}</td>
    <td class="num-cell">${p.numCubes}</td>
    <td class="num-cell">${p.scramble}</td>
    <td class="num-cell">${pct(p.failRate)}</td>
    <td class="num-cell">${p.worldBest != null ? p.worldBest : '–'}</td>
    ${bfsCell}${beamCell}${effortCell}
    ${colorCells}
    <td class="actions-cell">${solveBtn}${opts.actions || ''}</td>
  </tr>`;
}

// Shared table header used by both featured and all-puzzles sections.
const TABLE_HEAD = `<thead>
  <tr class="puzzle-th-row">
    <th class="drag-cell" title="drag to reorder"></th>
    <th>Puzzle</th>
    <th class="num-cell" title="number of cubes">Cubes</th>
    <th class="num-cell" title="scramble depth">Scr</th>
    <th class="num-cell" title="failure rate across all attempts">Fail%</th>
    <th class="num-cell" title="world-best move count">World</th>
    <th class="num-cell" title="BFS-optimal roll count">Opt</th>
    <th class="num-cell" title="beam-search roll count">Beam</th>
    <th class="num-cell" title="min beam width to solve — search effort (1=easy)">Eff</th>
    ${COLOR_META.map(cm =>
      `<th class="cb-cell" title="beam moves for ${cm.label} target">
         <span class="cb-header-dot" style="background:${cm.hex}"></span>
       </th>`
    ).join('')}
    <th>Actions</th>
  </tr>
</thead>`;

function renderPuzzles() {
  const wrap = $('puzzleAdminWrap');
  const dirty = isDirty();

  const total = puzzles.length;
  const solvedCount = puzzles.filter((p) => p.solvedAt != null).length;
  const pending = total - solvedCount;
  const runLabel = solverRunning
    ? 'Running solver…'
    : (pending > 0 ? `Run solver (${pending} pending)` : 'Re-run solver (all)');

  const saveStatus = dirty
    ? '<span class="unsaved-badge">● Unsaved changes</span>'
    : '<span class="muted">All changes saved</span>';

  // Featured section (draggable rows).
  const featuredRows = featured.map((id, i) => {
    const p = byId(id);
    if (!p) return '';
    const actions =
      `<button class="link-btn move-btn" data-id="${id}" data-dir="-1" type="button" ${i === 0 ? 'disabled' : ''}>↑</button>` +
      `<button class="link-btn move-btn" data-id="${id}" data-dir="1" type="button" ${i === featured.length - 1 ? 'disabled' : ''}>↓</button>` +
      `<button class="link-btn unpin-btn" data-id="${id}" type="button">Unpin</button>`;
    return puzzleTr(p, { actions, draggable: true });
  }).join('');

  // Unpinned section.
  const others = puzzles.filter((p) => !featured.includes(p.id));
  const otherRows = others.map((p) =>
    puzzleTr(p, { actions: `<button class="link-btn pin-btn" data-id="${p.id}" type="button">Pin</button>` })
  ).join('');

  wrap.innerHTML = `
    <div class="puzzle-list${dirty ? ' dirty' : ''}">
      <div class="puzzle-panels">

        <div class="puzzle-panel">
          <div class="solver-bar">
            <button id="runSolver" class="primary" type="button" ${solverRunning ? 'disabled' : ''}>${runLabel}</button>
            <span class="muted">${solvedCount}/${total} solved</span>
            <span id="solverStatus" class="muted"></span>
          </div>
        </div>

        <div class="puzzle-panel">
          <div class="puzzle-panel-head">
            <h3>Featured (${featured.length})${dirty ? ' <span class="unsaved-dot" title="unsaved changes">●</span>' : ''}</h3>
            <div class="puzzle-save">
              <button id="savePuzzleOrder" class="primary" type="button" ${dirty ? '' : 'disabled'}>Save order</button>
              <button id="resetPuzzleOrder" class="link-btn" type="button" ${dirty ? '' : 'disabled'}>Discard</button>
              <span id="puzzleSaveStatus">${saveStatus}</span>
              <span id="puzzleSaveMsg" class="muted"></span>
            </div>
          </div>
          <p class="muted drag-hint">Drag rows (or use ↑/↓) to reorder. Pin puzzles from the section below.</p>
          <div class="puzzle-table-wrap">
            <table class="puzzle-table">
              ${TABLE_HEAD}
              <tbody id="featuredTbody">
                ${featuredRows || `<tr><td colspan="16" class="muted" style="padding:12px 10px">None pinned yet.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <div class="puzzle-panel">
          <h3>All puzzles</h3>
          <div class="puzzle-table-wrap">
            <table class="puzzle-table">
              ${TABLE_HEAD}
              <tbody id="unpinnedTbody">
                ${otherRows || `<tr><td colspan="16" class="muted" style="padding:12px 10px">All puzzles are featured.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

      </div>
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
      // loadPuzzles re-rendered the section; if the reload failed there is no
      // puzzleSaveMsg element any more, so don't throw on a detached node.
      const after = $('puzzleSaveMsg');
      if (after) {
        after.textContent = 'Saved.';
      } else {
        const note = document.createElement('p');
        note.className = 'muted';
        note.textContent = 'Saved, but reload failed — refresh to see the new order.';
        $('puzzleAdminWrap').prepend(note);
      }
    } catch (e) {
      msg.textContent = `Failed: ${e.message}`;
    }
  });
}

// HTML5 drag-and-drop on <tr> rows to reorder featured puzzles.
function wireDragReorder(wrap) {
  wrap.querySelectorAll('.puzzle-tr.draggable').forEach((row) => {
    row.addEventListener('dragstart', (e) => {
      dragId = Number(row.dataset.id);
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(dragId)); } catch { /* ignore */ }
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      wrap.querySelectorAll('.puzzle-tr').forEach((r) => r.classList.remove('dragging', 'drop-target'));
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

// Run the solvers for the given puzzle ids one at a time, updating the local
// catalogue and refreshing the table as each result comes back.
async function runSolver(ids) {
  if (solverRunning || !ids.length) return;
  solverRunning = true;
  renderPuzzles();
  let done = 0, failed = 0;
  for (const id of ids) {
    const p = byId(id);
    // renderPuzzles() replaces the DOM each iteration, so re-look-up the status node.
    const status = $('solverStatus');
    if (status) status.textContent = `Solving ${p ? p.name : id}… (${done}/${ids.length})`;
    try {
      const r = await api.adminSolvePuzzle(id);
      if (p) {
        p.fullOptimal = r.fullOptimal;
        p.beamMoves = r.beamMoves;
        p.minBeamWidth = r.minBeamWidth;
        p.colorBeams = r.colorBeams ?? null;
        p.solvedAt = r.solvedAt;
      }
    } catch (e) {
      failed++;
      const puzzleName = p ? p.name : id;
      console.error(`[kcube] failed to solve puzzle ${puzzleName}:`, e);
    }
    done++;
    renderPuzzles(); // show each result as it lands, not only at the end
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

setupTheme();
boot();
