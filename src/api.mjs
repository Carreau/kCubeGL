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

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Core request. Returns parsed JSON, or throws ApiError(status) on an HTTP
// error, or throws a plain Error on a network failure (caller decides whether
// to swallow it).
// Resilience only holds if failures are FAST: a server that accepts the TCP
// connection but never answers (overloaded proxy, half-dead container) would
// otherwise hang every await forever and the cold-start fallback would never
// be reached. 10s is generous for a JSON API on the same origin.
const TIMEOUT_MS = 10_000;

async function request(method, path, body, { keepalive = false } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = "Bearer " + token;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    keepalive,
    signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch {
      // Non-JSON body (e.g. a proxy's HTML error page): synthesize an error
      // that still carries the HTTP status instead of a bare SyntaxError.
      throw new ApiError(res.status, res.statusText || `HTTP ${res.status}`);
    }
  }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || res.statusText);
  return data;
}

// Best-effort GET/POST/PATCH: swallow any failure and return `fallback`
// (default null) so callers can stay terse and the game tolerates no backend.
async function tryReq(method, path, body, fallback = null, opts) {
  try { return await request(method, path, body, opts); }
  catch { return fallback; }
}

/* --- Health / identity ------------------------------------------------------ */

// Ping the backend so the UI can branch on online vs offline. Never throws.
export async function probe() {
  const ok = await tryReq("GET", "/health");
  return ok !== null;
}

// Register a username and store the returned token. Throws ApiError so the
// caller can react to 409 (name taken) / offline.
// Pass adminToken to claim admin rights when KCUBE_ADMIN_TOKEN matches.
// Pass password (≥8 chars) to enable password-based login for this account.
export async function createUser(username, { email, adminToken, password } = {}) {
  const body = { username };
  if (email) body.email = email;
  if (adminToken) body.adminToken = adminToken;
  if (password) body.password = password;
  const data = await request("POST", "/users", body);
  if (data && data.token) setToken(data.token);
  return data;
}

// Sign in with username and password. Stores the token on success.
// Throws ApiError (401 = wrong credentials; 400 = missing fields).
export async function passwordLogin(username, password) {
  const data = await request("POST", "/auth/password/login", { username, password });
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
// Returns { attemptId } or null offline. (The server derives the puzzle's
// shortest-known solve itself; client claims are not accepted.)
export function startAttempt({ puzzle }) {
  return tryReq("POST", "/attempts", { puzzle });
}

// Finalise an attempt with its outcome and score. `moveSeq` is the player's
// recorded cursor path (R/L/U/D string), stored for replay/analysis. Returns
// { best, isRecord, worldBest } or null offline. `keepalive` lets the request
// outlive a same-instant navigation (e.g. abandoning via the "Puzzles" link),
// so the abandon isn't silently dropped when the page goes away.
export function finishAttempt(id, { outcome, movesUsed, durationMs, moveSeq }) {
  if (!id) return Promise.resolve(null);
  return tryReq("PATCH", `/attempts/${id}`, { outcome, movesUsed, durationMs, moveSeq }, null, { keepalive: true });
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

// Verify a passkey assertion. Stores the returned token on success, like
// createUser/passwordLogin.
export async function verifyPasskeyLogin(assertion) {
  const data = await request('POST', '/auth/passkey/login/verify', { assertion });
  if (data && data.token) setToken(data.token);
  return data;
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

// Set or clear a user's password. Pass null/empty to remove password login.
export async function adminResetUserPassword(id, newPassword) {
  return request('POST', `/admin/users/${id}/reset-password`, { newPassword: newPassword || null });
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

/* --- Tutorials --------------------------------------------------------------- */

// Fetch the public tutorial list (name, title, mode, sortOrder).
export function listTutorials() { return tryReq('GET', '/tutorials'); }

// Fetch full tutorial data for the player. Throws ApiError on failure.
export async function getTutorial(name) {
  return request('GET', `/tutorials/${encodeURIComponent(name)}`);
}

// Admin: list all tutorials.
export function adminListTutorials() { return tryReq('GET', '/admin/tutorials'); }

// Admin: create a new tutorial. Throws ApiError (409 = name taken).
export async function adminCreateTutorial(data) {
  return request('POST', '/admin/tutorials', data);
}

// Admin: full replace / save from designer.
export async function adminSaveTutorial(name, data) {
  return request('PUT', `/admin/tutorials/${encodeURIComponent(name)}`, data);
}

// Admin: delete a tutorial.
export async function adminDeleteTutorial(name) {
  return request('DELETE', `/admin/tutorials/${encodeURIComponent(name)}`, {});
}

// Admin: returns the export download URL (use as an <a href> or window.open).
export function adminTutorialExportUrl(name) {
  return `/api/admin/tutorials/${encodeURIComponent(name)}/export`;
}
