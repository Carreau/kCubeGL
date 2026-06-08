import * as api from './api.mjs';

const $ = (id) => document.getElementById(id);

/* --- base64url <-> ArrayBuffer helpers -------------------------------------- */

function b64uToAb(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob(padded);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

function abToB64u(ab) {
  const bytes = new Uint8Array(ab);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function credToJson(cred) {
  const r = cred.response;
  return {
    id: cred.id,
    rawId: abToB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: abToB64u(r.clientDataJSON),
      ...(r.attestationObject ? { attestationObject: abToB64u(r.attestationObject) } : {}),
      ...(r.authenticatorData ? { authenticatorData: abToB64u(r.authenticatorData) } : {}),
      ...(r.signature        ? { signature:         abToB64u(r.signature)         } : {}),
      ...(r.userHandle && r.userHandle.byteLength > 0 ? { userHandle: abToB64u(r.userHandle) } : {}),
    },
  };
}

/* --- helpers ---------------------------------------------------------------- */

function returnUrl() {
  const p = new URLSearchParams(location.search).get('return');
  return (p && p.startsWith('/')) ? p : 'index.html';
}

function setStatus(msg, isErr = false) {
  const el = $('authStatus');
  el.textContent = msg;
  el.className = 'auth-status' + (isErr ? ' auth-err' : '');
  el.classList.remove('hidden');
}

function clearStatus() { $('authStatus').classList.add('hidden'); }

async function passkeyAvailable() {
  if (typeof PublicKeyCredential === 'undefined') return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch { return false; }
}

/* --- passkey login ---------------------------------------------------------- */

async function doPasskeyLogin() {
  clearStatus();
  try {
    const options = await api.getPasskeyLoginOptions();
    if (!options) { setStatus('Could not reach server.', true); return; }

    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: b64uToAb(options.challenge),
        timeout: options.timeout,
        rpId: options.rpId,
        userVerification: options.userVerification || 'preferred',
        allowCredentials: (options.allowCredentials || []).map(c => ({ ...c, id: b64uToAb(c.id) })),
      },
    });
    if (!assertion) { setStatus('Passkey sign-in cancelled.', true); return; }

    const result = await api.verifyPasskeyLogin(credToJson(assertion));
    if (!result?.token) { setStatus('Passkey verification failed.', true); return; }

    api.setToken(result.token);
    location.href = returnUrl();
  } catch (e) {
    setStatus(e?.name === 'NotAllowedError' ? 'Passkey sign-in was cancelled.' : `Passkey sign-in failed: ${e?.message || e}`, true);
  }
}

/* --- registration ----------------------------------------------------------- */

async function doRegister(e) {
  e.preventDefault();
  const name = $('usernameInput').value.trim();
  const errEl = $('registerErr');
  errEl.classList.add('hidden');
  if (!name) { errEl.textContent = 'Enter a username.'; errEl.classList.remove('hidden'); return; }

  $('registerBtn').disabled = true;
  try {
    await api.createUser(name);
    $('registerForm').classList.add('hidden');
    $('addPasskeyArea').classList.remove('hidden');
  } catch (ex) {
    errEl.textContent = ex?.status === 409 ? 'Name taken — try another.' : "Couldn't create account. Is the server running?";
    errEl.classList.remove('hidden');
    $('registerBtn').disabled = false;
  }
}

/* --- passkey registration (after account creation) ------------------------- */

async function doAddPasskey() {
  clearStatus();
  try {
    const options = await api.getPasskeyRegisterOptions();
    if (!options) { setStatus('Could not get passkey options from server.', true); return; }

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
    if (!credential) { setStatus('Passkey creation cancelled.', true); return; }

    await api.verifyPasskeyRegistration(credToJson(credential));
    setStatus('Passkey added! Redirecting…');
    setTimeout(() => { location.href = returnUrl(); }, 800);
  } catch (e) {
    if (e?.name === 'NotAllowedError') {
      setStatus('Passkey creation was cancelled.', true);
    } else if (e?.status) {
      setStatus(`Passkey error: ${e.message}`, true);
    } else {
      setStatus(`Passkey creation failed: ${e?.message || e}`, true);
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

  if (online && await passkeyAvailable()) {
    $('passkeyLoginArea').classList.remove('hidden');
    $('passkeyLoginBtn').addEventListener('click', doPasskeyLogin);
  }

  $('registerForm').addEventListener('submit', doRegister);
  $('addPasskeyBtn').addEventListener('click', doAddPasskey);
  $('skipPasskeyBtn').addEventListener('click', () => { location.href = returnUrl(); });
}

boot();
