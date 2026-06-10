/* Pre-paint theme: applies the saved (or OS-preferred) theme before first
 * render. Loaded as a plain render-blocking <script> in every page's <head>,
 * before the stylesheet, so there is never a flash of the wrong theme.
 * NOTE: the 'kcube.theme' localStorage key must stay in sync with src/theme.mjs. */
(function () {
  var t = localStorage.getItem('kcube.theme') ||
    (matchMedia('(prefers-color-scheme:light)').matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', t);
})();
