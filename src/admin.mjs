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
// persisted with "Save order". `puzzles` is the full catalogue (server order).
let puzzles = [];
let featured = [];

const pct = (v) => (v == null ? '–' : Math.round(v * 100) + '%');

async function loadPuzzles() {
  const wrap = $('puzzleAdminWrap');
  puzzles = await api.adminListPuzzles();
  if (!Array.isArray(puzzles)) {
    wrap.innerHTML = '<p class="muted">Could not load puzzles.</p>';
    return;
  }
  featured = puzzles.filter((p) => p.pinned).map((p) => p.id);
  renderPuzzles();
}

function byId(id) { return puzzles.find((p) => p.id === id); }

function puzzleRow(p, opts = {}) {
  const meta = `${p.numCubes} cubes · scramble ${p.scramble} · ${pct(p.failRate)} fail` +
    (p.worldBest != null ? ` · world ${p.worldBest}` : '');
  return `<div class="puzzle-row" data-id="${p.id}">
    <span class="puzzle-name">${esc(p.name)}</span>
    <span class="muted puzzle-meta">${meta}</span>
    <span class="puzzle-actions">${opts.actions || ''}</span>
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
    return puzzleRow(p, { actions });
  }).join('');

  const others = puzzles.filter((p) => !featured.includes(p.id));
  const otherRows = others.map((p) =>
    puzzleRow(p, { actions: `<button class="link-btn pin-btn" data-id="${p.id}" type="button">Pin</button>` })
  ).join('');

  wrap.innerHTML =
    `<div class="puzzle-list">
       <h3>Featured (${featured.length})</h3>
       ${featuredRows || '<p class="muted">None pinned yet — pin a puzzle below.</p>'}
       <div class="puzzle-save">
         <button id="savePuzzleOrder" class="primary" type="button">Save order</button>
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

async function boot() {
  const online = await api.probe();
  if (!online) {
    $('userTableWrap').innerHTML = '<p class="muted">Server offline.</p>';
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
