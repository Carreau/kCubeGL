/* Headless end-to-end smoke test for kCube.
 *
 * Boots the real backend (server/server.mjs) against an in-memory DB, then in a
 * headless browser: loads the landing page, signs in, picks a level, plays a
 * few rolls, rotates the view and plays back the solution. It fails if the page
 * logged any error, threw, or a script/asset (including the Three.js CDN module)
 * failed to load — and it checks that starting a level recorded an attempt in
 * the database, so the front-to-back wiring is covered too.
 */
import pw from "playwright";
import { startServer } from "../server/server.mjs";

const { chromium } = pw;
const fail = (msg) => { console.error("✗ " + msg); process.exitCode = 1; };

const { url, db, close } = await startServer({ dbPath: ":memory:", port: 0 });
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 900, height: 700 } });
const page = await ctx.newPage();

const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });
page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText || ""}`));

try {
  // --- Landing page: grid renders, and we can sign in. ---
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector(".card", { timeout: 15000 });

  // Navigate to the login page and register. The post-register step offers a
  // passkey only when one can actually be created (secure context + a platform
  // authenticator); headless browsers have none, so registration continues
  // straight to index. Handle both: skip the passkey prompt if it appears.
  await page.goto(new URL("login.html", url).href, { waitUntil: "networkidle", timeout: 15000 });
  await page.fill("#usernameInput", "tester");
  await page.click("button#registerBtn");
  const passkeyPrompt = await page
    .waitForSelector("#addPasskeyArea", { state: "visible", timeout: 5000 })
    .catch(() => null);
  if (passkeyPrompt) await page.click("#skipPasskeyBtn");
  await page.waitForSelector(".who-pill", { timeout: 15000 });
  const who = await page.$eval(".who-pill", (e) => e.textContent);
  if (!/tester/.test(who)) fail(`expected to be signed in as tester, saw "${who}"`);

  // --- Open the first puzzle and play. ---
  const firstName = await page.$eval(".card", (e) => e.getAttribute("data-name"));
  await page.click(`.card[data-name="${firstName}"]`);
  await page.waitForURL(/play\.html\?puzzle=/, { timeout: 10000 });
  await page.waitForTimeout(1500); // game init + Three.js from CDN

  // Open info panel to access cube count
  await page.click("#infoBtn");
  await page.waitForTimeout(200);

  const cubes = Number(await page.$eval("#info-cubes", (e) => e.textContent));
  const moves = Number(await page.$eval("#moves", (e) => e.textContent));
  if (!(cubes > 0)) fail(`expected cubes > 0, got ${cubes}`);
  if (!(moves > 0)) fail(`expected a move budget > 0, got ${moves}`);

  // Roll around, rotate the view, then play the solution back.
  for (const k of ["ArrowRight", "ArrowUp", "ArrowLeft", "ArrowDown", "KeyQ", "KeyE"]) {
    await page.keyboard.press(k);
    await page.waitForTimeout(150);
  }
  await page.keyboard.press("KeyS"); // show solution
  // Playback is intentionally slowed (debug instrumentation) and a catalogue
  // puzzle can have a long scramble, so wait generously for the end-of-solution
  // overlay rather than relying on a fixed delay.
  await page
    .waitForFunction(() => !document.getElementById("overlay").classList.contains("hidden"), undefined, { timeout: 90000 })
    .catch(() => {});

  const overlayVisible = await page.$eval("#overlay", (e) => !e.classList.contains("hidden"));
  if (!overlayVisible) fail("expected the solution overlay to be shown after playback");

  // --- Front-to-back: starting the puzzle recorded an attempt in the DB. ---
  const attempts = db.db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n;
  if (!(attempts >= 1)) fail(`expected an attempt to be recorded, got ${attempts}`);

  if (errors.length) for (const e of errors) fail(e);
} catch (e) {
  fail("threw: " + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  close();
}

if (process.exitCode) console.error("\nSmoke test FAILED.");
else console.log("✓ Smoke test passed (landing → play → solution, attempt recorded, no errors).");
