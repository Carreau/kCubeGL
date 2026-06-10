import * as api from './api.mjs';
import { setupTheme } from './theme.mjs';
import { $, esc, avatarHtml, setStatus } from './ui.mjs';

function setMsg(text, isErr = false) {
  setStatus($('formMsg'), text, isErr);
}

function renderAvatar(user) {
  const box = $('avatarPreview');
  if (!user) { box.innerHTML = ''; return; }
  box.innerHTML =
    avatarHtml(user, 64, 'settings-avatar') +
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
