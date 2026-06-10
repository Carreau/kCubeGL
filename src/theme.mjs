const KEY = 'kcube.theme';

function preferred() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function initTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  if (cur) return cur;
  const theme = localStorage.getItem(KEY) || preferred();
  document.documentElement.setAttribute('data-theme', theme);
  return theme;
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || preferred();
  const next = cur === 'light' ? 'dark' : 'light';
  localStorage.setItem(KEY, next);
  document.documentElement.setAttribute('data-theme', next);
  document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  return next;
}

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || preferred();
}

export function bindThemeBtn(btn) {
  function update(theme) {
    btn.textContent = theme === 'light' ? 'Dark' : 'Light';
    btn.title = theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
  }
  update(currentTheme());
  btn.addEventListener('click', () => update(toggleTheme()));
  document.addEventListener('themechange', e => update(e.detail.theme));
}
