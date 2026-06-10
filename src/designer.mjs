/* ============================================================================
 * designer.mjs — level designer for kCube tutorials (admin-only).
 *
 * Three modes:
 *   Place  — click the 5×5 HTML grid to add / remove cubes (identity quat).
 *   Orient — click a cube in the 3D view to select it; arrow keys spin it in
 *            place (applies the roll rotation to the quat, no position change).
 *   Record — normal gameplay; every move is logged; after each move an
 *            annotation panel lets the admin type the hint text for that step.
 *
 * Save: PUT /api/admin/tutorials/:name (creates or replaces).
 * Export: triggers the admin export endpoint download.
 * ========================================================================== */

import * as THREE from "three";
import { DIRS as GEN_DIRS } from "./level-gen.mjs";
import { inBounds, cubeAt, BOARD } from "./shared.mjs";
import { GameScene, Cube, cellX, cellZ, HALF, S, easeInOut } from "./scene.mjs";
import {
  me, adminSaveTutorial, adminCreateTutorial, getTutorial, adminTutorialExportUrl,
} from "./api.mjs";
import { setupTheme } from "./theme.mjs";

const ROLL_MS = 170;
const CURSOR_HOP_MS = 80;

const DIRS = Object.fromEntries(Object.entries(GEN_DIRS).map(([k, d]) => [k, {
  dr: d.dr, dc: d.dc,
  axis: new THREE.Vector3(...d.axis), angle: d.angle,
  edgeOffset: new THREE.Vector3(d.dc * HALF, -HALF, d.dr * HALF),
}]));

/* --- DOM -------------------------------------------------------------------- */

const canvas       = document.getElementById("scene");
const btnPlace     = document.getElementById("btn-place");
const btnOrient    = document.getElementById("btn-orient");
const btnRecord    = document.getElementById("btn-record");
const modeLabel    = document.getElementById("mode-label");
const placeGrid    = document.getElementById("place-grid");
const orientHint   = document.getElementById("orient-hint");
const annotPanel   = document.getElementById("annotate-panel");
const annotInput   = document.getElementById("annotate-input");
const annGuided    = document.getElementById("ann-guided");
const annotCommit  = document.getElementById("annotate-commit");
const stepList     = document.getElementById("step-list");
const stepCount    = document.getElementById("step-count");
const metaName     = document.getElementById("meta-name");
const metaTitle    = document.getElementById("meta-title");
const metaMode     = document.getElementById("meta-mode");
const btnClearSteps = document.getElementById("btn-clear-steps");
const btnSave      = document.getElementById("btn-save");
const btnExport    = document.getElementById("btn-export");
const btnLoad      = document.getElementById("btn-load");
const btnTest      = document.getElementById("btn-test");
const toast        = document.getElementById("status-toast");

setupTheme();

/* --- State ------------------------------------------------------------------ */

const gs      = new GameScene(canvas);
const cursor  = gs.createCursor();
cursor.visible = false;

let cubes      = [];         // Cube[]
let cursorIdx  = 0;          // selected cube index
let mode       = "place";    // "place" | "orient" | "record"
let selectedOrientIdx = -1;  // cube selected in orient mode
let anim       = null;       // active roll animation (record mode)
let walk       = null;       // active cursor walk animation (record mode)
let steps      = [];         // [{hint, required, highlightCell}]
let pendingStep = null;       // step waiting for annotation { key, type:"roll"|"switch" }
let annotating  = false;

// Highlight material for selected cube in orient mode
const hlMat = new THREE.MeshStandardMaterial({
  color: 0x6ee7ff, transparent: true, opacity: 0.25, depthTest: false,
});

/* --- Toast ------------------------------------------------------------------ */

let toastTimer = null;
function showToast(msg, isErr = false) {
  toast.textContent = msg;
  toast.className   = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = ""; }, 3000);
}

/* --- Mode switching --------------------------------------------------------- */

function setMode(m) {
  mode = m;
  [btnPlace, btnOrient, btnRecord].forEach((b) => b.classList.remove("active"));
  placeGrid.classList.remove("visible");
  orientHint.classList.remove("visible");
  annotPanel.classList.remove("visible");
  annotating = false;
  pendingStep = null;
  selectedOrientIdx = -1;

  if (m === "place") {
    btnPlace.classList.add("active");
    modeLabel.textContent = "Click grid cells to add / remove cubes";
    cursor.visible = false;
    placeGrid.classList.add("visible");
    refreshPlaceGrid();
  } else if (m === "orient") {
    btnOrient.classList.add("active");
    modeLabel.textContent = "Click a cube, then use arrow keys to spin its orientation";
    cursor.visible = false;
    orientHint.classList.add("visible");
  } else {
    btnRecord.classList.add("active");
    modeLabel.textContent = "Play normally — each move becomes a step";
    cursor.visible = true;
    snapCursor();
  }
}

btnPlace.addEventListener("click",  () => setMode("place"));
btnOrient.addEventListener("click", () => setMode("orient"));
btnRecord.addEventListener("click", () => setMode("record"));

/* --- Place-mode grid -------------------------------------------------------- */

function refreshPlaceGrid() {
  placeGrid.innerHTML = "";
  for (let r = 0; r < BOARD; r++) {
    for (let c = 0; c < BOARD; c++) {
      const cell = document.createElement("div");
      cell.className = "grid-cell";
      const cube = cubeAt(cubes, r, c);
      if (cube) {
        cell.classList.add("occupied");
        if (cubes.indexOf(cube) === cursorIdx) cell.classList.add("cursor-here");
        cell.title = `Cube at (${r},${c}) — click to remove`;
      } else {
        cell.title = `Empty (${r},${c}) — click to add`;
      }
      cell.addEventListener("click", () => toggleCell(r, c));
      placeGrid.appendChild(cell);
    }
  }
}

function toggleCell(r, c) {
  const existing = cubeAt(cubes, r, c);
  if (existing) {
    const idx = cubes.indexOf(existing);
    existing.dispose();
    cubes.splice(idx, 1);
    if (cursorIdx >= cubes.length) cursorIdx = Math.max(0, cubes.length - 1);
  } else {
    const cube = gs.createCube(r, c);
    cubes.push(cube);
  }
  refreshPlaceGrid();
}

/* --- Orient mode ------------------------------------------------------------ */

canvas.addEventListener("click", (e) => {
  if (mode !== "orient") return;
  const hit = gs.rayCast(cubes, e.clientX, e.clientY);
  if (!hit) { selectedOrientIdx = -1; return; }
  selectedOrientIdx = cubes.indexOf(hit);
  orientHint.textContent = `Selected cube ${selectedOrientIdx} at (${hit.r},${hit.c}) — use arrow keys to spin`;
});

// In orient mode, arrow keys apply the roll rotation to the quat WITHOUT moving.
function applyOrientKey(key) {
  if (selectedOrientIdx < 0) return;
  const d = DIRS[key];
  if (!d) return;
  const cube = cubes[selectedOrientIdx];
  const rot = new THREE.Quaternion().setFromAxisAngle(d.axis, d.angle);
  cube.mesh.quaternion.premultiply(rot);
}

/* --- Record mode ------------------------------------------------------------ */

function snapCursor() {
  const c = cubes[cursorIdx];
  if (c) cursor.position.set(cellX(c.c), HALF + 0.5, cellZ(c.r));
}

function startRoll(cube, dir, nr, nc) {
  const center = cube.mesh.position.clone();
  const pivot  = center.clone().add(dir.edgeOffset);
  anim = {
    cube, dir, nr, nc, pivot,
    startPos:  center.clone().sub(pivot),
    startQuat: cube.mesh.quaternion.clone(),
    t: 0,
    key: Object.keys(DIRS).find((k) => DIRS[k] === dir),
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
    openAnnotation(a.key, "roll");
  }
}

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

function handleRecordKey(key) {
  if (anim || walk || annotating) return;
  const dir = DIRS[key];
  if (!dir) return;
  const cube = cubes[cursorIdx];
  if (!cube) return;
  const nr = cube.r + dir.dr, nc = cube.c + dir.dc;
  if (!inBounds(nr, nc)) return;
  const other = cubeAt(cubes, nr, nc);
  if (other) {
    const toIdx = cubes.indexOf(other);
    startWalk(toIdx, () => {
      cursorIdx = toIdx;
      openAnnotation(key, "switch");
    });
  } else {
    startRoll(cube, dir, nr, nc);
  }
}

/* --- Annotation panel ------------------------------------------------------- */

function openAnnotation(key, type) {
  pendingStep = { key, type };
  annotating  = true;
  annotInput.value = "";
  annGuided.checked = false;
  annotPanel.classList.add("visible");
  annotInput.focus();
}

function commitAnnotation() {
  if (!pendingStep) return;
  const hint     = annotInput.value.trim();
  const required = annGuided.checked ? pendingStep.key : null;
  steps.push({ hint, required, highlightCell: null });
  pendingStep = null;
  annotating  = false;
  annotPanel.classList.remove("visible");
  renderStepList();
}

annotCommit.addEventListener("click", commitAnnotation);
annotInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); commitAnnotation(); }
  e.stopPropagation(); // don't let arrow keys leak into game input
});

/* --- Step list ------------------------------------------------------------- */

function renderStepList() {
  stepCount.textContent = `(${steps.length})`;
  stepList.innerHTML = steps.map((s, i) => `
    <li>
      <span class="step-num">${i + 1}.</span>
      <span class="step-hint">${s.hint || "<em class='muted'>no hint</em>"}${s.required ? ` <code>${s.required}</code>` : ""}</span>
      <button class="step-del" data-idx="${i}" type="button" title="Delete step">✕</button>
    </li>`).join("");
  stepList.querySelectorAll(".step-del").forEach((btn) => {
    btn.addEventListener("click", () => {
      steps.splice(Number(btn.dataset.idx), 1);
      renderStepList();
    });
  });
}

btnClearSteps.addEventListener("click", () => {
  if (steps.length && !confirm("Delete all recorded steps?")) return;
  steps = [];
  renderStepList();
});

/* --- Save / Export / Load / Test -------------------------------------------- */

function buildPayload() {
  const initialBoard = cubes.map((c) => ({
    r: c.r, c: c.c, q: Array.from(c.mesh.quaternion.toArray()),
  }));
  return {
    name:         metaName.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    title:        metaTitle.value.trim(),
    cursorIndex:  cursorIdx,
    initialBoard,
    steps,
    mode:         metaMode.value,
    sortOrder:    0,
  };
}

btnSave.addEventListener("click", async () => {
  const payload = buildPayload();
  if (!payload.name) { showToast("Enter a tutorial name first", true); return; }
  try {
    await adminSaveTutorial(payload.name, payload);
    // Update the name field to the cleaned version
    metaName.value = payload.name;
    showToast(`Saved "${payload.name}"`);
  } catch (e) {
    showToast(e.message || "Save failed", true);
  }
});

btnExport.addEventListener("click", () => {
  const name = metaName.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (name) {
    // Download from server (auth header from stored token)
    const a = document.createElement("a");
    a.href = adminTutorialExportUrl(name);
    a.download = `${name}.json`;
    a.click();
  } else {
    // Export current in-memory state as a JSON download (no round-trip needed)
    const payload = buildPayload();
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tutorial.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
});

btnLoad.addEventListener("click", async () => {
  const name = metaName.value.trim();
  if (!name) { showToast("Enter a tutorial name to load", true); return; }
  try {
    const t = await getTutorial(name);
    metaTitle.value = t.title || "";
    metaMode.value  = t.mode || "hint";
    steps = Array.isArray(t.steps) ? t.steps : [];

    for (const c of cubes) c.dispose();
    cubes = [];
    for (const def of t.initialBoard) {
      const cube = gs.createCube(def.r, def.c);
      cube.mesh.quaternion.fromArray(def.q);
      cubes.push(cube);
    }
    cursorIdx = Math.min(t.cursorIndex ?? 0, Math.max(0, cubes.length - 1));
    refreshPlaceGrid();
    renderStepList();
    snapCursor();
    showToast(`Loaded "${name}"`);
  } catch (e) {
    showToast(e.message || "Load failed", true);
  }
});

btnTest.addEventListener("click", () => {
  const name = metaName.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (!name) { showToast("Save or set a name first", true); return; }
  window.open(`tutorial.html?t=${encodeURIComponent(name)}`, "_blank");
});

/* --- Keyboard --------------------------------------------------------------- */

document.addEventListener("keydown", (e) => {
  if (annotating) return; // annotation input captures its own keydown
  if (e.key === "q" || e.key === "Q") { gs.rotateCameraBy(-Math.PI / 2); return; }
  if (e.key === "e" || e.key === "E") { gs.rotateCameraBy(Math.PI / 2);  return; }

  if (mode === "orient" && DIRS[e.key]) {
    e.preventDefault();
    applyOrientKey(e.key);
    return;
  }
  if (mode === "record" && DIRS[e.key]) {
    e.preventDefault();
    handleRecordKey(e.key);
  }
});

/* --- Render loop ------------------------------------------------------------ */

let lastTime = null;

function loop(time) {
  requestAnimationFrame(loop);
  const dt = lastTime ? Math.min(time - lastTime, 100) : 16;
  lastTime = time;

  if (mode === "record") {
    if (anim) tickRoll(dt);
    else if (walk) tickWalk(dt);
  }

  // Cursor
  if (mode === "record" && !anim && !walk) snapCursor();
  if (mode === "record") {
    cursor.position.y = HALF + 0.5;
    cursor.rotation.y = -gs.camYaw;
  }

  gs.resize();
  gs.render();
}

/* --- Boot ------------------------------------------------------------------- */

async function init() {
  const user = await me();
  if (!user?.isAdmin) {
    document.body.innerHTML =
      `<div style="padding:40px;font-family:sans-serif">
         <h2>Admin access required</h2>
         <p><a href="login.html">Sign in</a> as an admin to use the designer.</p>
       </div>`;
    return;
  }

  setMode("place");
  renderStepList();
  requestAnimationFrame(loop);
}

init();
