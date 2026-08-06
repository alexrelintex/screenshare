// Bundle the widget into a single self-contained IIFE.
//
// IIFE, not ESM: the whole promise of a drop-in widget is one <script> tag on a
// page that may predate modules. IIFE also guarantees nothing leaks to window,
// since there is no global name assigned.

import { build, transform } from "esbuild";
import { mkdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";

mkdirSync("dist", { recursive: true });

let cssBefore = 0;
let cssAfter = 0;

/**
 * Minify the widget's stylesheet.
 *
 * STYLES is a template literal, so the bundler treats it as an opaque string:
 * every indent and every explanatory comment we wrote ships to every embedding
 * page. It was 28% of the bundle.
 *
 * esbuild's own CSS parser does the work rather than a regex, which would be
 * guessing at where whitespace is significant. It passes `${...}` through
 * untouched, so the one interpolated constant survives — and it is the reason
 * a naive numeric placeholder would have been wrong, since the minifier
 * rewrites `1600ms` to `1.6s`.
 */
const minifyStyles = {
  name: "minify-styles",
  setup(b) {
    b.onLoad({ filter: /src\/element\.ts$/ }, async (args) => {
      const source = await readFile(args.path, "utf8");
      const match = source.match(/const STYLES = `([\s\S]*?)`;/);
      if (!match) {
        // Loud, because the failure mode otherwise is a bundle that quietly
        // grows by 3 KB and a build that still says it succeeded.
        throw new Error("minify-styles: STYLES template not found in element.ts");
      }
      const { code } = await transform(match[1], { loader: "css", minify: true });
      cssBefore = match[1].length;
      cssAfter = code.trim().length;
      return {
        // Replacer function, not a string: `$` sequences in a string
        // replacement are substitution patterns, and the CSS contains `${`.
        contents: source.replace(match[0], () => `const STYLES = \`${code.trim()}\`;`),
        loader: "ts",
      };
    });
  },
};

await build({
  ...shared_(),
  outfile: "dist/screenshare.js",
  minify: true,
  sourcemap: true,
  plugins: [minifyStyles],
});
// The dev bundle keeps the stylesheet readable — it exists to be read.
await build({ ...shared_(), outfile: "dist/screenshare.dev.js", minify: false });

function shared_() {
  return {
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "iife",
    target: ["chrome109", "firefox115", "safari16"],
    platform: "browser",
    logLevel: "warning",
  };
}

const kb = (p) => (statSync(p).size / 1024).toFixed(1);
console.log(`dist/screenshare.js      ${kb("dist/screenshare.js")} KB (minified)`);
console.log(`dist/screenshare.dev.js  ${kb("dist/screenshare.dev.js")} KB (readable)`);
console.log(`  stylesheet             ${cssBefore} -> ${cssAfter} b (-${cssBefore - cssAfter})`);

// A drop-in widget that costs a page 100 KB is not drop-in. Fail the build
// rather than let the bundle grow unnoticed.
const LIMIT_KB = 25;
const actual = Number(kb("dist/screenshare.js"));
if (actual > LIMIT_KB) {
  console.error(`\nbundle budget exceeded: ${actual} KB > ${LIMIT_KB} KB`);
  process.exit(1);
}
