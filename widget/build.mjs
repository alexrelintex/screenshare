// Bundle the widget into a single self-contained IIFE.
//
// IIFE, not ESM: the whole promise of a drop-in widget is one <script> tag on a
// page that may predate modules. IIFE also guarantees nothing leaks to window,
// since there is no global name assigned.

import { build } from "esbuild";
import { mkdirSync, statSync } from "node:fs";

mkdirSync("dist", { recursive: true });

const shared = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "iife",
  target: ["chrome109", "firefox115", "safari16"],
  platform: "browser",
  logLevel: "warning",
};

await build({ ...shared, outfile: "dist/screenshare.js", minify: true, sourcemap: true });
await build({ ...shared, outfile: "dist/screenshare.dev.js", minify: false });

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`dist/screenshare.js      ${kb("dist/screenshare.js")} KB (minified)`);
console.log(`dist/screenshare.dev.js  ${kb("dist/screenshare.dev.js")} KB (readable)`);

// A drop-in widget that costs a page 100 KB is not drop-in. Fail the build
// rather than let the bundle grow unnoticed.
const LIMIT_KB = 25;
const actual = Number(kb("dist/screenshare.js"));
if (actual > LIMIT_KB) {
  console.error(`\nbundle budget exceeded: ${actual} KB > ${LIMIT_KB} KB`);
  process.exit(1);
}
