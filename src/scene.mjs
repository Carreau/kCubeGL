/* ============================================================================
 * scene.mjs — shared Three.js rendering for tutorial.mjs and designer.mjs.
 *
 * Exports GameScene (renderer + camera + lights + board + face materials) and
 * Cube (a single bevelled die mesh). main.js keeps its own rendering loop so
 * we don't risk a regression there; this module serves only the new pages.
 * ========================================================================== */

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { BOARD, COLORS } from "./shared.mjs";
import { FACE_AXES as GEN_FACE_AXES, quatToFaces } from "./level-gen.mjs";
import { initTheme } from "./theme.mjs";

export const S = 1.0;
export const HALF = S / 2;
export const cellX = (col) => (col - (BOARD - 1) / 2) * S;
export const cellZ = (row) => (row - (BOARD - 1) / 2) * S;
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

export const SCENE_THEME = {
  dark: {
    clear: 0x0b0d14, base: 0x161a26, tileA: 0x313952, tileB: 0x222838, faceBg: "#0c0e16",
    sheen: 0.18, key: 1.15, fill: 0x88aaff, fillIntensity: 0.35,
  },
  light: {
    clear: 0xdce4f0, base: 0xc3ccdc, tileA: 0xedf1f8, tileB: 0xdfe6f0,
    faceBg: "#475066",
    sheen: 0.10, key: 1.3, fill: 0xdfe8ff, fillIntensity: 0.3,
    faces: {
      white: 0xffffff, yellow: 0xffe838, red: 0xe8323c,
      orange: 0xff8a1f, blue: 0x2f8fff, green: 0x2dc965,
    },
  },
};

export const FACE_AXES = GEN_FACE_AXES.map((f) => ({ v: new THREE.Vector3(...f.v), color: f.color }));

export function faceHex(colorIdx, t) {
  return (t.faces && t.faces[COLORS[colorIdx].name]) ?? COLORS[colorIdx].hex;
}

export function faceTexture(hex, bg = SCENE_THEME.dark.faceBg, sheen = SCENE_THEME.dark.sheen) {
  const size = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const ctx = cv.getContext("2d");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);
  const pad = 12, r = 22, w = size - pad * 2;
  ctx.fillStyle = "#" + hex.toString(16).padStart(6, "0");
  ctx.beginPath(); ctx.roundRect(pad, pad, w, w, r); ctx.fill();
  const grad = ctx.createLinearGradient(0, pad, 0, pad + w);
  grad.addColorStop(0, `rgba(255,255,255,${sheen})`);
  grad.addColorStop(0.5, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.roundRect(pad, pad, w, w, r); ctx.fill();
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function bevelledCubeGeometry(size, radius, segments) {
  const geo = new RoundedBoxGeometry(size, size, size, segments, radius);
  const pos = geo.attributes.position;
  const faceOf = (x, y, z) => {
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    if (ax >= ay && ax >= az) return x >= 0 ? 0 : 1;
    if (ay >= az) return y >= 0 ? 2 : 3;
    return z >= 0 ? 4 : 5;
  };
  geo.clearGroups();
  const tris = pos.count / 3;
  let runStart = 0, runMat = -1;
  for (let t = 0; t < tris; t++) {
    const i = t * 3;
    const x = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const y = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const z = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const m = faceOf(x, y, z);
    if (m !== runMat) {
      if (runMat !== -1) geo.addGroup(runStart * 3, (t - runStart) * 3, runMat);
      runStart = t; runMat = m;
    }
  }
  geo.addGroup(runStart * 3, (tris - runStart) * 3, runMat);
  return geo;
}

const CAM_R = 6.6, CAM_H = 7.4;

export class GameScene {
  constructor(canvas) {
    this._canvas = canvas;
    this._theme = initTheme() || "dark";

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.1, 100);
    this.camYaw = 0;
    this.camYawTarget = 0;
    this._applyCamera();

    const t = SCENE_THEME[this._theme];
    this.renderer.setClearColor(t.clear);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    this.keyLight = new THREE.DirectionalLight(0xffffff, t.key);
    this.keyLight.position.set(4, 9, 5);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1; this.keyLight.shadow.camera.far = 30;
    this.keyLight.shadow.camera.left = -6; this.keyLight.shadow.camera.right = 6;
    this.keyLight.shadow.camera.top = 6; this.keyLight.shadow.camera.bottom = -6;
    this.scene.add(this.keyLight);
    this.fillLight = new THREE.DirectionalLight(t.fill, t.fillIntensity);
    this.fillLight.position.set(-5, 4, -4);
    this.scene.add(this.fillLight);

    // Board base + checkerboard tiles
    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);
    const baseGeo = new THREE.BoxGeometry(BOARD * S + 0.5, 0.4, BOARD * S + 0.5);
    this.baseMat = new THREE.MeshStandardMaterial({ color: t.base, roughness: 0.9 });
    const base = new THREE.Mesh(baseGeo, this.baseMat);
    base.position.y = -0.2 - 0.001;
    base.receiveShadow = true;
    this.boardGroup.add(base);
    const tileGeo = new THREE.BoxGeometry(S * 0.94, 0.12, S * 0.94);
    this.tileMats = [];
    for (let r = 0; r < BOARD; r++) {
      for (let c = 0; c < BOARD; c++) {
        const dark = (r + c) % 2 === 1;
        const mat = new THREE.MeshStandardMaterial({ color: dark ? t.tileB : t.tileA, roughness: 0.85 });
        const tile = new THREE.Mesh(tileGeo, mat);
        tile.position.set(cellX(c), -0.06, cellZ(r));
        tile.receiveShadow = true;
        this.boardGroup.add(tile);
        this.tileMats.push({ mat, dark });
      }
    }

    // Shared cube geometry + per-face materials (all cubes on a page share these)
    this.cubeGeo = bevelledCubeGeometry(S, 0.08, 3);
    this.faceMaterials = FACE_AXES.map((f) =>
      new THREE.MeshStandardMaterial({
        map: faceTexture(faceHex(f.color, t), t.faceBg, t.sheen),
        roughness: 0.55, metalness: 0.05,
      })
    );

    document.addEventListener("themechange", ({ detail }) => this.applyTheme(detail.theme));
  }

  _applyCamera() {
    this.camera.position.set(Math.sin(this.camYaw) * CAM_R, CAM_H, Math.cos(this.camYaw) * CAM_R);
    this.camera.lookAt(0, 0, 0);
  }

  // Smooth-ease yaw toward target (call each frame when camYaw !== camYawTarget).
  tickCamera(dt) {
    if (Math.abs(this.camYawTarget - this.camYaw) > 0.0005) {
      this.camYaw += (this.camYawTarget - this.camYaw) * Math.min(1, dt / 120);
      this._applyCamera();
    }
  }

  rotateCameraBy(delta) {
    this.camYawTarget += delta;
    this.camYaw = this.camYawTarget; // snap for now (Q/E)
    this._applyCamera();
  }

  createCube(r, c) { return new Cube(r, c, this); }

  createCursor() {
    const cursor = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6ee7ff, emissive: 0x2a6f88, roughness: 0.3, metalness: 0.2, flatShading: true,
    });
    const tv = [0, 0.08, -0.40], bl = [-0.17, 0.04, 0.18], br = [0.17, 0.04, 0.18], dn = [0, -0.38, 0];
    const verts = new Float32Array([...tv, ...bl, ...br, ...tv, ...br, ...dn, ...tv, ...dn, ...bl, ...bl, ...dn, ...br]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    cursor.add(new THREE.Mesh(geo, mat));
    this.scene.add(cursor);
    return cursor;
  }

  applyTheme(theme) {
    this._theme = theme;
    const t = SCENE_THEME[theme] || SCENE_THEME.dark;
    this.renderer.setClearColor(t.clear);
    this.baseMat.color.set(t.base);
    this.keyLight.intensity = t.key;
    this.fillLight.color.set(t.fill);
    this.fillLight.intensity = t.fillIntensity;
    for (const { mat, dark } of this.tileMats) mat.color.set(dark ? t.tileB : t.tileA);
    this.faceMaterials.forEach((mat, i) => {
      mat.map?.dispose();
      mat.map = faceTexture(faceHex(FACE_AXES[i].color, t), t.faceBg, t.sheen);
      mat.needsUpdate = true;
    });
  }

  resize() {
    const c = this._canvas;
    const w = c.clientWidth, h = c.clientHeight;
    if (this.renderer.domElement.width !== w * devicePixelRatio ||
        this.renderer.domElement.height !== h * devicePixelRatio) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h || 1;
      this.camera.updateProjectionMatrix();
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }

  // Returns the closest Cube whose mesh the pointer (clientX/Y) hits, or null.
  rayCast(cubes, clientX, clientY) {
    const raycaster = new THREE.Raycaster();
    const rect = this._canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, this.camera);
    const meshes = cubes.map((c) => c.mesh);
    const hits = raycaster.intersectObjects(meshes);
    if (!hits.length) return null;
    return cubes[meshes.indexOf(hits[0].object)];
  }
}

export class Cube {
  constructor(r, c, gs) {
    this._gs = gs;
    this.r = r;
    this.c = c;
    this.mesh = new THREE.Mesh(gs.cubeGeo, gs.faceMaterials);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    gs.scene.add(this.mesh);
    this.mesh.quaternion.identity();
    this.syncMesh();
  }
  setCell(r, c) { this.r = r; this.c = c; }
  syncMesh() { this.mesh.position.set(cellX(this.c), HALF, cellZ(this.r)); }
  get topColor() { return quatToFaces(this.mesh.quaternion.toArray())[2]; }
  dispose() { this._gs.scene.remove(this.mesh); }
}
