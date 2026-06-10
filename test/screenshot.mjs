/* Dev helper (not part of npm test): boots the server and captures play-page
 * screenshots in light and dark themes for visual review.
 * Usage: node test/screenshot.mjs [outDir]
 */
import pw from "playwright";
import { startServer } from "../server/server.mjs";

const { chromium } = pw;
const outDir = process.argv[2] || "/tmp/shots";
const { url, close } = await startServer({ dbPath: ":memory:", port: 0 });
let browser;
try {
  browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1100, height: 800 } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    page.on("console", (m) => { if (m.type() === "error") console.error("console:", m.text()); });
    page.on("requestfailed", (r) => console.error("requestfailed:", r.url(), r.failure()?.errorText));
    await page.addInitScript((t) => localStorage.setItem("kcube.theme", t), theme);
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForSelector(".card", { timeout: 15000 });
    const firstName = await page.$eval(".card", (e) => e.getAttribute("data-name"));
    await page.goto(new URL(`play.html?puzzle=${firstName}`, url).href, { timeout: 30000 });
    await page.waitForFunction(
      () => Number(document.getElementById("moves")?.textContent) > 0,
      undefined,
      { timeout: 30000 },
    );
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${outDir}/play-${theme}.png` });
    // a rotated view too, to see side faces
    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${outDir}/play-${theme}-rotated.png` });
    await ctx.close();
  }
} finally {
  await browser?.close();
  close();
}
console.log("screenshots written to " + outDir);
