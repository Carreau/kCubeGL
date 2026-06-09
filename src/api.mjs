/* ============================================================================
 * Browser ⇄ backend API client.
 *
 * Thin wrapper over fetch for the kCube backend (server/server.mjs), the source
 * of truth for accounts, the catalogue, leaderboards and difficulty stats.
 * Calls are resilient rather than offline-first: if the server is briefly
 * unreachable they resolve to null instead of throwing, so the UI can fall back
 * to a cold-start cache and the player keeps moving until it's back. The only
 * call that surfaces errors is createUser, because the UI needs to tell the
 * player "that name is taken".
 *
 * Auth is a bearer token: createUser() mints one and stores it; every later
 * call sends it as `Authorization: Bearer <token>`.
 * ========================================================================== */

const BASE = "/api";
const TOKEN_KEY = "kcube.token";

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}
export function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* ignore */ }
}
export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

// Has a reachable backend been seen this session? null = unknown yet.
export let available = null;

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Core request. Returns parsed JSON, or throws ApiError(status) on an HTTP
// error, or throws a plain Error on a network failure (caller decides whether
// to swallow it). Marks `available` based on whether the server answered.
async function request(method, path, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    available = false; // network/connection failure ⇒ treat as offline
    throw e;
  }
  available = true;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText);
  return data;
}

// Best-effort GET/POST/PATCH: swallow any failure and return `fallback`
// (default null) so callers can stay terse and the game tolerates no backend.
async function tryReq(method, path, body, fallback = null) {
  try { return await request(method, path, body); }
  catch { return fallback; }
}

/* --- Health / identity ------------------------------------------------------ */

// Ping the backend so the UI can branch on online vs offline. Never throws.
export async function probe() {
  const ok = await tryReq("GET", "/health");
  return ok !== null;
}

// Register a username (and optional Gravatar email) and store the returned
// token. Throws ApiError so the caller can react to 409 (name taken) / offline.
export async function createUser(username, email) {
  const data = await request("POST", "/users", { username, email });
  if (data && data.token) setToken(data.token);
  return data;
}

// Who am I (per stored token)? null if not logged in / offline / token stale.
export async function me() {
  if (!getToken()) return null;
  return tryReq("GET", "/me");
}

// Set/update/clear my Gravatar email. Returns the updated identity or null
// offline. Pass "" or null to clear it.
export function updateEmail(email) {
  return tryReq("PATCH", "/me", { email });
}

export function myStats() { return tryReq("GET", "/me/stats"); }

/* --- Puzzles ---------------------------------------------------------------- */

// The whole catalogue for the landing page: per-puzzle metadata, difficulty
// signals (winRate/failRate, avgMoves…), your best + world best.
export function listPuzzles() { return tryReq("GET", "/puzzles"); }

// One puzzle's detail: metadata, leaderboard, difficulty stats, your best.
export function getPuzzle(name) { return tryReq("GET", `/puzzles/${encodeURIComponent(name)}`); }

/* --- Attempts --------------------------------------------------------------- */

// Record that the player has started a fresh attempt at a puzzle (by name).
// `optimal` lets the client report a shortest-known solve. Returns { attemptId }
// or null offline.
export function startAttempt({ puzzle, optimal }) {
  return tryReq("POST", "/attempts", { puzzle, optimal });
}

// Finalise an attempt with its outcome and score. `moveSeq` is the player's
// recorded cursor path (R/L/U/D string), stored for replay/analysis. Returns
// { best, isRecord, worldBest } or null offline.
export function finishAttempt(id, { outcome, movesUsed, durationMs, moveSeq }) {
  if (!id) return Promise.resolve(null);
  return tryReq("PATCH", `/attempts/${id}`, { outcome, movesUsed, durationMs, moveSeq });
}

// Mark an in-progress attempt abandoned on page unload. Uses sendBeacon, which
// can't set an Authorization header, so the token rides in the body.
export function abandonBeacon(id, { movesUsed, durationMs }) {
  if (!id || typeof navigator === "undefined" || !navigator.sendBeacon) return;
  const payload = JSON.stringify({ token: getToken(), movesUsed, durationMs });
  try {
    navigator.sendBeacon(BASE + `/attempts/${id}/abandon`, new Blob([payload], { type: "application/json" }));
  } catch { /* ignore */ }
}

/* --- Passkeys ---------------------------------------------------------------- */

export function getPasskeyRegisterOptions() {
  return tryReq('POST', '/auth/passkey/register/options');
}

export async function verifyPasskeyRegistration(credential) {
  return request('POST', '/auth/passkey/register/verify', { credential });
}

export function getPasskeyLoginOptions() {
  return tryReq('POST', '/auth/passkey/login/options');
}

export async function verifyPasskeyLogin(assertion) {
  return request('POST', '/auth/passkey/login/verify', { assertion });
}

/* --- Admin ------------------------------------------------------------------ */

export function adminListUsers() {
  return tryReq('GET', '/admin/users');
}

export async function adminUpdateUser(id, data) {
  return request('PATCH', `/admin/users/${id}`, data);
}

export async function adminDeleteUser(id) {
  return request('DELETE', `/admin/users/${id}`, {});
}

export function adminListPuzzles() {
  return tryReq('GET', '/admin/puzzles');
}

// Set the exact pinned order (and which puzzles are pinned) from a list of ids.
export async function adminReorderPuzzles(ids) {
  return request('PUT', '/admin/puzzles/order', { ids });
}

// Run the full (BFS) + beam solvers for one puzzle server-side and store the
// results. Returns { fullOptimal, beamMoves, solvedAt }.
export async function adminSolvePuzzle(id) {
  return request('POST', `/admin/puzzles/${id}/solve`, {});
}
