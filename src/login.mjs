import * as api from './api.mjs';
import { setupTheme } from './theme.mjs';
import { $, setStatus, clearStatus } from './ui.mjs';
import { b64uToAb, credToJson } from './webauthn-utils.mjs';

/* --- helpers ---------------------------------------------------------------- */

function returnUrl() {
  const p = new URLSearchParams(location.search).get('return');
  // Same-origin paths only: must start with '/' but not '//' or '/\', both of
  // which browsers treat as protocol-relative URLs (an open-redirect vector).
  return (p && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\'))
    ? p : 'index.html';
}

// Passkeys (WebAuthn) only work in a "secure context": HTTPS, or a loopback
// host (localhost / 127.0.0.1 / [::1]). On a plain-HTTP dev server reached
// over the network the browser throws a SecurityError, so we check this up
// front rather than letting navigator.credentials.* fail mysteriously.
function secureContextOk() {
  if (typeof window !== 'undefined' && 'isSecureContext' in window) return window.isSecureContext;
  return location.protocol === 'https:' ||
    ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
}

// Whether THIS device has a platform authenticator — used only for the
// post-registration "Add Passkey" nudge. The sign-in button is shown more
// broadly (see boot): roaming/cross-device passkeys (security keys, phone
// hybrid) work without a platform authenticator.
async function passkeyAvailable() {
  if (!secureContextOk()) return false;
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

const INSECURE_MSG =
  'Passkeys need a secure connection — open the site over https:// or on http://localhost.';

/* --- passkey login ---------------------------------------------------------- */

async function doPasskeyLogin() {
  clearStatus('authStatus');
  if (!secureContextOk()) { setStatus('authStatus', INSECURE_MSG, true); return; }
  try {
    const options = await api.getPasskeyLoginOptions();
    if (!options) { setStatus('authStatus', 'Could not reach server.', true); return; }

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: b64uToAb(options.challenge),
        timeout: options.timeout,
        rpId: options.rpId,
        userVerification: options.userVerification || 'preferred',
        allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: b64uToAb(c.id) })),
      },
    });
    if (!assertion) { setStatus('authStatus', 'Passkey sign-in cancelled.', true); return; }

    const result = await api.verifyPasskeyLogin(credToJson(assertion));
    if (!result?.token) { setStatus('authStatus', 'Passkey verification failed.', true); return; }

    // api.verifyPasskeyLogin stored the token (like createUser/passwordLogin).
    location.href = returnUrl();
  } catch (e) {
    let msg;
    if (e?.name === 'NotAllowedError') msg = 'Passkey sign-in was cancelled.';
    else if (e?.name === 'SecurityError') msg = INSECURE_MSG;
    else msg = `Passkey sign-in failed: ${e?.message || e}`;
    setStatus('authStatus', msg, true);
  }
}

/* --- admin token toggle ----------------------------------------------------- */

let adminMode = false;

function toggleAdminMode() {
  adminMode = !adminMode;
  $('adminTokenArea').classList.toggle('hidden', !adminMode);
  $('registerBtn').textContent = adminMode ? 'Create Admin Account' : 'Create Account';
  $('adminToggleBtn').textContent = adminMode ? 'Cancel admin setup' : 'Set up admin account';
  if (!adminMode) $('adminTokenInput').value = '';
}

/* --- password login --------------------------------------------------------- */

async function doPasswordLogin(e) {
  e.preventDefault();
  const username = $('loginUsernameInput').value.trim();
  const password = $('loginPasswordInput').value;
  const errEl = $('loginErr');
  errEl.classList.add('hidden');
  if (!username || !password) {
    errEl.textContent = 'Enter your username and password.';
    errEl.classList.remove('hidden');
    return;
  }
  $('passwordLoginBtn').disabled = true;
  try {
    await api.passwordLogin(username, password);
    location.href = returnUrl();
  } catch (ex) {
    errEl.textContent =
      ex?.status === 401 ? 'Invalid username or password.'
      : ex?.status === 400 ? (ex.message || 'Check your details.')
      : "Sign-in failed. Is the server running?";
    errEl.classList.remove('hidden');
    $('passwordLoginBtn').disabled = false;
  }
}

/* --- registration ----------------------------------------------------------- */

async function doRegister(e) {
  e.preventDefault();
  const name = $('usernameInput').value.trim();
  const errEl = $('registerErr');
  errEl.classList.add('hidden');
  if (!name) { errEl.textContent = 'Enter a username.'; errEl.classList.remove('hidden'); return; }

  const adminToken = adminMode ? $('adminTokenInput').value.trim() : '';
  if (adminMode && !adminToken) {
    errEl.textContent = 'Enter the admin token, or cancel admin setup.';
    errEl.classList.remove('hidden');
    return;
  }

  const password = $('regPasswordInput').value;
  if (password && password.length < 8) {
    errEl.textContent = 'Password must be at least 8 characters, or leave it blank.';
    errEl.classList.remove('hidden');
    return;
  }

  $('registerBtn').disabled = true;
  try {
    await api.createUser(name, {
      adminToken: adminToken || undefined,
      password: password || undefined,
    });
    // The account now exists and api.createUser() has stored its session token,
    // so the player is already signed in. Only offer the passkey step when it
    // can actually work; on a dev server without a secure context we'd just be
    // dangling a button that throws, so continue straight into the session.
    $('registerForm').classList.add('hidden');
    $('passwordLoginArea').classList.add('hidden');
    $('passkeyLoginArea').classList.add('hidden');
    $('adminToggleArea').classList.add('hidden');
    if (await passkeyAvailable()) {
      $('addPasskeyArea').classList.remove('hidden');
    } else {
      location.href = returnUrl();
    }
  } catch (ex) {
    errEl.textContent =
      ex?.status === 409 ? 'Name taken — try another.'
      : ex?.status === 400 ? (ex.message || 'Check your details and try again.')
      : "Couldn't create account. Is the server running?";
    errEl.classList.remove('hidden');
    $('registerBtn').disabled = false;
  }
}

/* --- passkey registration (after account creation) ------------------------- */

async function doAddPasskey() {
  clearStatus('authStatus');
  if (!secureContextOk()) { setStatus('authStatus', INSECURE_MSG, true); return; }
  try {
    const options = await api.getPasskeyRegisterOptions();
    if (!options) { setStatus('authStatus', 'Could not get passkey options from server.', true); return; }

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: b64uToAb(options.challenge),
        rp: options.rp,
        user: {
          id: b64uToAb(options.user.id),
          name: options.user.name,
          displayName: options.user.displayName,
        },
        pubKeyCredParams: options.pubKeyCredParams,
        timeout: options.timeout,
        attestation: options.attestation || 'none',
        authenticatorSelection: options.authenticatorSelection,
      },
    });
    if (!credential) { setStatus('authStatus', 'Passkey creation cancelled.', true); return; }

    await api.verifyPasskeyRegistration(credToJson(credential));
    setStatus('authStatus', 'Passkey added! Redirecting…');
    setTimeout(() => { location.href = returnUrl(); }, 800);
  } catch (e) {
    if (e?.name === 'NotAllowedError') {
      setStatus('authStatus', 'Passkey creation was cancelled.', true);
    } else if (e?.name === 'SecurityError') {
      setStatus('authStatus', INSECURE_MSG, true);
    } else if (e?.status) {
      setStatus('authStatus', `Passkey error: ${e.message}`, true);
    } else {
      setStatus('authStatus', `Passkey creation failed: ${e?.message || e}`, true);
    }
  }
}

/* --- boot ------------------------------------------------------------------- */

async function boot() {
  const online = await api.probe();
  if (online) {
    const me = await api.me();
    if (me) { location.href = returnUrl(); return; }
  }

  if (online) {
    $('passwordLoginArea').classList.remove('hidden');
    $('passwordLoginForm').addEventListener('submit', doPasswordLogin);

    // Offer passkey sign-in whenever the browser supports WebAuthn in a secure
    // context — roaming authenticators (security keys, phone hybrid) work even
    // without a platform authenticator on this device.
    if (secureContextOk() && typeof PublicKeyCredential !== 'undefined') {
      $('passkeyLoginArea').classList.remove('hidden');
      $('passkeyLoginBtn').addEventListener('click', doPasskeyLogin);
    } else if (!secureContextOk() && typeof PublicKeyCredential !== 'undefined') {
      // The device supports passkeys but this origin can't use them — tell the
      // player why the passkey button is missing instead of leaving them stuck.
      setStatus('authStatus', INSECURE_MSG, true);
    }
  }

  $('registerForm').addEventListener('submit', doRegister);
  $('adminToggleBtn').addEventListener('click', toggleAdminMode);
  $('addPasskeyBtn').addEventListener('click', doAddPasskey);
  $('skipPasskeyBtn').addEventListener('click', () => { location.href = returnUrl(); });
}

setupTheme();
boot();
