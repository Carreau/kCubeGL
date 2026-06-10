/* Worker-thread entry for the admin solver step.
 *
 * solveCatalogPuzzle (src/catalog-solve.mjs) is pure and dependency-free but
 * can take seconds of CPU on the hardest boards; running it here keeps the
 * HTTP server's event loop responsive. workerData is the puzzle config
 * { seed, numCubes, scramble }; the result is posted back to the parent.
 */
import { parentPort, workerData } from "node:worker_threads";
import { solveCatalogPuzzle } from "../src/catalog-solve.mjs";

parentPort.postMessage(solveCatalogPuzzle(workerData));
