/* ============================================================================
 * webauthn-utils.mjs — base64url <-> ArrayBuffer helpers for the WebAuthn
 * (passkey) ceremonies, plus the generic credential -> JSON packing sent to
 * the /api/auth/passkey/* endpoints. Browser-only (atob/btoa), no DOM.
 * ========================================================================== */

export function b64uToAb(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob(padded);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

export function abToB64u(ab) {
  const bytes = new Uint8Array(ab);
  let raw = '';
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Pack a PublicKeyCredential (registration attestation or login assertion)
// into the plain-JSON shape the server's verify endpoints expect.
export function credToJson(cred) {
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
