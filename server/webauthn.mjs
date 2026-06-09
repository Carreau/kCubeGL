/* ============================================================================
 * WebAuthn utilities — node:crypto only (no npm packages).
 * Supports ES256 (alg=-7, P-256) credentials with "none" attestation.
 * ========================================================================== */

import { createHash, createVerify, createPublicKey, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Minimal CBOR decoder
// Handles uint (mt=0), negint (mt=1), bstr (mt=2), tstr (mt=3),
// array (mt=4), map (mt=5) with lengths up to 4 bytes.
// ---------------------------------------------------------------------------
function decodeCBOR(buf, pos = 0) {
  const b = buf[pos++];
  const mt = b >> 5;
  const ai = b & 0x1f;
  let len;
  if (ai < 24) len = ai;
  else if (ai === 24) len = buf[pos++];
  else if (ai === 25) { len = (buf[pos] << 8) | buf[pos + 1]; pos += 2; }
  else if (ai === 26) { len = buf.readUInt32BE(pos); pos += 4; }
  else throw new Error(`CBOR: unsupported ai=${ai}`);

  if (mt === 0) return { v: len, pos };
  if (mt === 1) return { v: -(len + 1), pos };
  if (mt === 2) return { v: buf.slice(pos, pos + len), pos: pos + len };
  if (mt === 3) return { v: buf.slice(pos, pos + len).toString('utf8'), pos: pos + len };
  if (mt === 4) {
    const arr = [];
    for (let i = 0; i < len; i++) { const x = decodeCBOR(buf, pos); arr.push(x.v); pos = x.pos; }
    return { v: arr, pos };
  }
  if (mt === 5) {
    const map = new Map();
    for (let i = 0; i < len; i++) {
      const k = decodeCBOR(buf, pos); pos = k.pos;
      const v = decodeCBOR(buf, pos); pos = v.pos;
      map.set(k.v, v.v);
    }
    return { v: map, pos };
  }
  throw new Error(`CBOR: unsupported major type ${mt}`);
}

// ---------------------------------------------------------------------------
// Parse authenticatorData binary structure
// rpIdHash 32B | flags 1B | signCount 4B | [attested credential data …]
// ---------------------------------------------------------------------------
function parseAuthData(buf) {
  if (buf.length < 37) throw new Error('authData too short');
  const rpIdHash = buf.slice(0, 32);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  const UP = (flags & 0x01) !== 0;
  const UV = (flags & 0x04) !== 0;
  const AT = (flags & 0x40) !== 0;
  if (!AT || buf.length <= 37) return { rpIdHash, flags, signCount, UP, UV, AT };
  let pos = 37;
  pos += 16; // skip AAGUID
  const credIdLen = buf.readUInt16BE(pos); pos += 2;
  const credentialId = buf.slice(pos, pos + credIdLen); pos += credIdLen;
  const { v: coseKey } = decodeCBOR(buf, pos);
  return { rpIdHash, flags, signCount, UP, UV, AT, credentialId, coseKey };
}

const b64u = (buf) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64url');
const fromb64u = (s) => Buffer.from(s, 'base64url');

function challengesMatch(a, b) {
  try { return fromb64u(a).equals(fromb64u(b)); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function generateChallenge() {
  return randomBytes(32).toString('base64url');
}

export function verifyRegistration(credential, expectedChallenge, expectedOrigin, rpId) {
  const clientDataJSON = fromb64u(credential.response.clientDataJSON);
  const clientData = JSON.parse(clientDataJSON.toString('utf8'));
  if (clientData.type !== 'webauthn.create') throw new Error('wrong clientData type');
  if (!challengesMatch(clientData.challenge, expectedChallenge)) throw new Error('challenge mismatch');
  if (clientData.origin !== expectedOrigin) throw new Error(`origin mismatch: got ${clientData.origin}`);

  const attObjBuf = fromb64u(credential.response.attestationObject);
  const { v: attObj } = decodeCBOR(attObjBuf);
  const authDataRaw = attObj.get('authData');
  if (!authDataRaw) throw new Error('missing authData');
  const authData = Buffer.isBuffer(authDataRaw) ? authDataRaw : Buffer.from(authDataRaw);
  const parsed = parseAuthData(authData);

  const expectedRpIdHash = createHash('sha256').update(rpId).digest();
  if (!parsed.rpIdHash.equals(expectedRpIdHash)) throw new Error('rpId hash mismatch');
  if (!parsed.UP) throw new Error('user not present');
  if (!parsed.AT || !parsed.credentialId || !parsed.coseKey) throw new Error('no attested credential data');

  const coseKey = parsed.coseKey;
  if (coseKey.get(1) !== 2) throw new Error(`unsupported kty=${coseKey.get(1)}`);
  if (coseKey.get(3) !== -7) throw new Error(`unsupported alg=${coseKey.get(3)}`);
  if (coseKey.get(-1) !== 1) throw new Error(`unsupported crv=${coseKey.get(-1)}`);
  const x = coseKey.get(-2);
  const y = coseKey.get(-3);
  if (!x || !y) throw new Error('missing public key coordinates');

  return {
    credentialId: b64u(parsed.credentialId),
    publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) }),
    counter: parsed.signCount,
  };
}

export function verifyAssertion(assertion, storedPublicKeyJson, storedCounter, expectedChallenge, expectedOrigin, rpId) {
  const clientDataJSON = fromb64u(assertion.response.clientDataJSON);
  const clientData = JSON.parse(clientDataJSON.toString('utf8'));
  if (clientData.type !== 'webauthn.get') throw new Error('wrong clientData type');
  if (!challengesMatch(clientData.challenge, expectedChallenge)) throw new Error('challenge mismatch');
  if (clientData.origin !== expectedOrigin) throw new Error(`origin mismatch: got ${clientData.origin}`);

  const authData = fromb64u(assertion.response.authenticatorData);
  const parsed = parseAuthData(authData);
  const expectedRpIdHash = createHash('sha256').update(rpId).digest();
  if (!parsed.rpIdHash.equals(expectedRpIdHash)) throw new Error('rpId hash mismatch');
  if (!parsed.UP) throw new Error('user not present');

  if (storedCounter > 0 && parsed.signCount !== 0 && parsed.signCount <= storedCounter) {
    throw new Error('counter did not increase (possible cloned authenticator)');
  }

  const clientDataHash = createHash('sha256').update(clientDataJSON).digest();
  const signedData = Buffer.concat([authData, clientDataHash]);
  const pubKey = createPublicKey({ key: JSON.parse(storedPublicKeyJson), format: 'jwk' });
  const sig = fromb64u(assertion.response.signature);
  const verifier = createVerify('SHA256');
  verifier.update(signedData);
  if (!verifier.verify(pubKey, sig)) throw new Error('signature verification failed');

  return { counter: parsed.signCount };
}
