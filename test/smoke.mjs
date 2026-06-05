/* Headless smoke test for kCube.
 *
 * Serves the repository over HTTP, loads the game in a real (headless) browser,
 * starts a level, performs a few rolls, rotates the view and plays back the
 * solution — then fails if the page logged any error, threw, or a script/asset
 * (including the Three.js CDN module) failed to load. This is enough to catch
 * module/import regressions and WebGL/runtime breakage without a build step.
 */
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import pw from "playwright";

const { chromium } = pw;
const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(req.url.split("?")[0]);
      if (path === "/" || path === "") path = "/index.html";
      // contain requests to the repo root
      const full = normalize(join(ROOT, path));
      if (!full.startsWith(ROOT)) { res.statusCode = 403; return res.end("forbidden"); }
      const ext = full.slice(full.lastIndexOf("."));
      const body = await readFile(full);
      res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const fail = (msg) => { console.error("✗ " + msg); process.exitCode = 1; };

const { server, url } = await startServer();
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 700 } });
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ""}`));

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);

  // Start the level from the menu.
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  const cubes = Number(await page.$eval("#cubes", (e) => e.textContent));
  const moves = Number(await page.$eval("#moves", (e) => e.textContent));
  if (!(cubes > 0)) fail(`expected cubes > 0, got ${cubes}`);
  if (!(moves > 0)) fail(`expected a move budget > 0, got ${moves}`);

  // Roll around, rotate the view, then play the solution back.
  for (const k of ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "KeyQ", "KeyE"]) {
    await page.keyboard.press(k);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("KeyS"); // show solution
  // Playback is intentionally slowed (debug instrumentation), so wait for the
  // end-of-solution overlay to appear rather than relying on a fixed delay.
  await page
    .waitForFunction(() => !document.getElementById("overlay").classList.contains("hidden"), { timeout: 30000 })
    .catch(() => {});

  const overlayVisible = await page.$eval("#overlay", (e) => !e.classList.contains("hidden"));
  if (!overlayVisible) fail("expected the solution overlay to be shown after playback");

  if (errors.length) {
    for (const e of errors) fail(e);
  }
} catch (e) {
  fail("threw: " + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  server.close();
}

if (process.exitCode) console.error("\nSmoke test FAILED.");
else console.log("✓ Smoke test passed (no console/page/network errors).");
