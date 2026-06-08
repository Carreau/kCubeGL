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
    return;
  }
  await loadUsers();
}

boot();
