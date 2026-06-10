/* ============================================================================
 * tutorial.mjs — step-by-step tutorial player.
 *
 * Loads a tutorial by name (?t=<name>) from the API, renders the 3D board
 * using scene.mjs, and walks the player through annotated steps.
 *
 * Mode "guided": only the required move at each step is accepted.
 * Mode "hint":   any valid move advances the step (required is just the hint).
 * ========================================================================== */

import * as THREE from "three";
import { DIRS as GEN_DIRS } from "./level-gen.mjs";
import { inBounds, cubeAt } from "./shared.mjs";
import { GameScene, Cube, cellX, cellZ, HALF, S, easeInOut } from "./scene.mjs";
import { getTutorial } from "./api.mjs";
import { setupTheme } from "./theme.mjs";

const ROLL_MS = 170;
const CURSOR_HOP_MS = 80;

// Arrow directions with Three.js vectors
const DIRS = Object.fromEntries(Object.entries(GEN_DIRS).map(([k, d]) => [k, {
  dr: d.dr, dc: d.dc,
  axis: new THREE.Vector3(...d.axis), angle: d.angle,
  edgeOffset: new THREE.Vector3(d.dc * HALF, -HALF, d.dr * HALF),
}]));

/* --- DOM -------------------------------------------------------------------- */

const canvas    = document.getElementById("scene");
const titleEl   = document.getElementById("tut-title");
const modeBadge = document.getElementById("mode-badge");
const stepEl    = document.getElementById("step-counter");
const hintEl    = document.getElementById("hint-box");
const overlayEl = document.getElementById("overlay");
const oTitle    = document.getElementById("overlay-title");
const oBody     = document.getElementById("overlay-body");
const oBtn      = document.getElementById("overlay-btn");

setupTheme();
oBtn.addEventListener("click", () => { location.href = "index.html"; });

/* --- State ------------------------------------------------------------------ */

const gs = new GameScene(canvas);
const cursor = gs.createCursor();

let tutorial  = null;
let cubes     = [];
let cursorIdx = 0;
let stepIdx   = 0;
let anim      = null;
let walk      = null;
let finished  = false;

/* --- Init ------------------------------------------------------------------- */

async function init() {
  const name = new URLSearchParams(location.search).get("t");
  if (!name) { showError("No tutorial specified. Add ?t=name to the URL."); return; }

  try {
    tutorial = await getTutorial(name);
  } catch {
    showError(`Tutorial "${name}" not found.`);
    return;
  }

  titleEl.textContent   = tutorial.title || tutorial.name;
  modeBadge.textContent = tutorial.mode === "guided" ? "Guided" : "Hint";
  document.title = `kCube — ${tutorial.title || tutorial.name}`;

  for (const def of tutorial.initialBoard) {
    const cube = gs.createCube(def.r, def.c);
    cube.mesh.quaternion.fromArray(def.q);
    cubes.push(cube);
  }

  cursorIdx = Math.min(tutorial.cursorIndex ?? 0, cubes.length - 1);
  snapCursor();
  showStep(0);
  requestAnimationFrame(loop);
}

/* --- Step management ------------------------------------------------------- */

function showStep(idx) {
  if (!tutorial.steps.length || idx >= tutorial.steps.length) {
    showComplete(); return;
  }
  stepIdx = idx;
  const step = tutorial.steps[idx];
  hintEl.textContent  = step.hint || "";
  stepEl.textContent  = `${idx + 1} / ${tutorial.steps.length}`;
}

function showComplete() {
  finished = true;
  hintEl.textContent = "";
  stepEl.textContent = "";
  oTitle.textContent = "Tutorial complete!";
  oBody.textContent  = `You finished "${tutorial.title || tutorial.name}".`;
  oBtn.textContent   = "Back to puzzles";
  overlayEl.classList.remove("hidden");
}

function showError(msg) {
  oTitle.textContent = "Error";
  oBody.textContent  = msg;
  oBtn.textContent   = "Back";
  overlayEl.classList.remove("hidden");
}

/* --- Input ------------------------------------------------------------------ */

document.addEventListener("keydown", (e) => {
  if (finished) return;
  if (e.key === "q" || e.key === "Q") { gs.rotateCameraBy(-Math.PI / 2); return; }
  if (e.key === "e" || e.key === "E") { gs.rotateCameraBy(Math.PI / 2);  return; }
  if (!DIRS[e.key]) return;
  e.preventDefault();
  handleMove(e.key);
});

function handleMove(key) {
  if (anim || walk || finished) return;

  const step = tutorial.steps[stepIdx];
  // Guided mode: block keys that don't match the required direction.
  if (tutorial.mode === "guided" && step?.required && key !== step.required) return;

  const cube = cubes[cursorIdx];
  if (!cube) return;
  const dir = DIRS[key];
  const nr = cube.r + dir.dr, nc = cube.c + dir.dc;
  if (!inBounds(nr, nc)) return;

  const other = cubeAt(cubes, nr, nc);
  if (other) {
    // Cursor switch — free move, still advances the step
    const toIdx = cubes.indexOf(other);
    startWalk(toIdx, () => { cursorIdx = toIdx; showStep(stepIdx + 1); });
  } else {
    // Roll the cube
    startRoll(cube, dir, nr, nc);
  }
}

/* --- Roll animation --------------------------------------------------------- */

function startRoll(cube, dir, nr, nc) {
  const center = cube.mesh.position.clone();
  const pivot  = center.clone().add(dir.edgeOffset);
  anim = {
    cube, dir, nr, nc, pivot,
    startPos:  center.clone().sub(pivot),
    startQuat: cube.mesh.quaternion.clone(),
    t: 0,
  };
}

function tickRoll(dt) {
  const a = anim;
  a.t = Math.min(1, a.t + dt / ROLL_MS);
  const e = easeInOut(a.t);
  const q = new THREE.Quaternion().setFromAxisAngle(a.dir.axis, a.dir.angle * e);
  a.cube.mesh.position.copy(a.startPos).applyQuaternion(q).add(a.pivot);
  a.cube.mesh.quaternion.copy(a.startQuat).premultiply(q);
  if (a.t >= 1) {
    const final = new THREE.Quaternion().setFromAxisAngle(a.dir.axis, a.dir.angle);
    a.cube.mesh.quaternion.copy(a.startQuat).premultiply(final);
    a.cube.setCell(a.nr, a.nc);
    a.cube.syncMesh();
    cursorIdx = cubes.indexOf(a.cube);
    anim = null;
    snapCursor();
    showStep(stepIdx + 1);
  }
}

/* --- Cursor walk animation -------------------------------------------------- */

function startWalk(toIdx, onDone) {
  const from = { x: cursor.position.x, z: cursor.position.z };
  const t    = cubes[toIdx];
  walk = { from, to: { x: cellX(t.c), z: cellZ(t.r) }, t: 0, onDone };
}

function tickWalk(dt) {
  const w = walk;
  w.t = Math.min(1, w.t + dt / CURSOR_HOP_MS);
  const e = easeInOut(w.t);
  cursor.position.x = w.from.x + (w.to.x - w.from.x) * e;
  cursor.position.z = w.from.z + (w.to.z - w.from.z) * e;
  if (w.t >= 1) { walk = null; w.onDone?.(); }
}

function snapCursor() {
  const c = cubes[cursorIdx];
  if (c) { cursor.position.set(cellX(c.c), HALF + 0.5, cellZ(c.r)); }
}

/* --- Render loop ------------------------------------------------------------ */

let lastTime = null;

function loop(time) {
  requestAnimationFrame(loop);
  const dt = lastTime ? Math.min(time - lastTime, 100) : 16;
  lastTime = time;

  if (anim) tickRoll(dt); else if (walk) tickWalk(dt);

  // Cursor floats above selected cube when idle
  if (!anim && !walk) {
    const c = cubes[cursorIdx];
    if (c) cursor.position.set(cellX(c.c), HALF + 0.5, cellZ(c.r));
  }
  cursor.position.y = HALF + 0.5;
  cursor.rotation.y = -gs.camYaw;

  gs.resize();
  gs.render();
}

init();
