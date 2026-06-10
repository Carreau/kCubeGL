import * as api from './api.mjs';
import { gravatarUrl, gravatarUrlForHash } from './shared.mjs';
import { setupTheme } from './theme.mjs';
import { $, esc } from './ui.mjs';

function setMsg(text, isErr = false) {
  const el = $('formMsg');
  el.textContent = text;
  el.className = 'auth-status' + (isErr ? ' auth-err' : '');
  el.classList.remove('hidden');
}

function renderAvatar(user) {
  const box = $('avatarPreview');
  if (!user) { box.innerHTML = ''; return; }
  const src = user.avatarHash
    ? gravatarUrlForHash(user.avatarHash, { size: 128 })
    : gravatarUrl(user.username, { size: 128 });
  box.innerHTML =
    `<img class="settings-avatar" src="${esc(src)}" alt="Your avatar" width="64" height="64" ` +
    `referrerpolicy="no-referrer" onerror="this.style.display='none'">` +
    `<span class="settings-avatar-name">@${esc(user.username)}</span>`;
  box.classList.remove('hidden');
}

async function save(e) {
  e.preventDefault();
  const email = $('emailInput').value.trim();
  if (!email) { setMsg('Enter an email address.', true); return; }
  $('saveBtn').disabled = true;
  const result = await api.updateEmail(email);
  $('saveBtn').disabled = false;
  if (!result) { setMsg('Could not reach server. Try again.', true); return; }
  renderAvatar({ ...state.user, avatarHash: result.avatarHash });
  state.user = { ...state.user, avatarHash: result.avatarHash };
  $('emailInput').value = '';
  setMsg('Avatar updated!');
}

async function clear() {
  $('clearBtn').disabled = true;
  const result = await api.updateEmail('');
  $('clearBtn').disabled = false;
  if (!result) { setMsg('Could not reach server. Try again.', true); return; }
  state.user = { ...state.user, avatarHash: null };
  renderAvatar(state.user);
  setMsg('Avatar removed.');
}

const state = { user: null };

async function boot() {
  const online = await api.probe();
  if (!online) {
    setMsg('Server is offline. Settings require a connection.', true);
    return;
  }
  const me = await api.me();
  if (!me) {
    location.href = 'login.html?return=/settings.html';
    return;
  }
  state.user = me;
  renderAvatar(me);
  $('gravatarForm').addEventListener('submit', save);
  $('clearBtn').addEventListener('click', clear);
}

setupTheme();
boot();
