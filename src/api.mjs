/* ============================================================================
 * Browser ⇄ backend API client.
 *
 * Thin wrapper over fetch for the optional kCube backend (server/server.mjs).
 * EVERY call is offline-safe: if the server isn't there (e.g. the game is
 * served as plain static files, or hosting is down), calls resolve to null
 * instead of throwing, so the game keeps working on localStorage alone. The
 * only call that surfaces errors is createUser, because the UI needs to tell
 * the player "that name is taken".
 *
 * Auth is a bearer token: createUser() mints one and stores it; every later
 * call sends it as `Authorization: Bearer <token>`.
 * ========================================================================== */

const BASE = "/api";
const TOKEN_KEY = "kcube.token";

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}
function setToken(t) {
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

// Register a username and store the returned token. Throws ApiError so the
// caller can react to 409 (name taken) / offline.
export async function createUser(username) {
  const data = await request("POST", "/users", { username });
  if (data && data.token) setToken(data.token);
  return data;
}

// Who am I (per stored token)? null if not logged in / offline / token stale.
export async function me() {
  if (!getToken()) return null;
  return tryReq("GET", "/me");
}

export function myStats() { return tryReq("GET", "/me/stats"); }

/* --- Levels ----------------------------------------------------------------- */

// Level grid for the landing page: metadata + your best + world best per level.
export function listLevels(count = 12) { return tryReq("GET", `/levels?count=${count}`); }

// One level's detail: metadata, leaderboard, difficulty stats, your best.
export function getLevel(level) { return tryReq("GET", `/levels/${level}`); }

/* --- Attempts --------------------------------------------------------------- */

// Record that the player has started a fresh attempt at a level. The client
// supplies the (deterministic) metadata so the server can register an unplayed
// level without running the game engine. Returns { attemptId } or null offline.
export function startAttempt({ level, numCubes, par, optimal }) {
  return tryReq("POST", "/attempts", { level, numCubes, par, optimal });
}

// Finalise an attempt with its outcome and score. Returns { best, isRecord,
// worldBest } or null offline.
export function finishAttempt(id, { outcome, movesUsed, durationMs }) {
  if (!id) return Promise.resolve(null);
  return tryReq("PATCH", `/attempts/${id}`, { outcome, movesUsed, durationMs });
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
