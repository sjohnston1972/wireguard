// scripts/shots-diff.mjs   (npm run shots:diff -- <baseline dir> <new dir>)
//
// Plain English: compares two folders of screenshots from "npm run shots",
// file by file (paired by name), pixel by pixel. Prints each file that
// differs with how many pixels changed and where (x,y widthxheight), and
// exits 1 on any difference or any file present on one side only. Exit 0
// means every screen is exactly as it was.

import { diffDirs } from "./lib/pngdiff.mjs";

const [a, b, ...rest] = process.argv.slice(2);
if (!a || !b || rest.length) {
  console.error("Usage: npm run shots:diff -- <baseline dir> <new dir>");
  process.exit(2);
}

let r;
try {
  r = diffDirs(a, b);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
for (const f of r.files) {
  if (f.same) continue;
  if (f.box) console.log(`DIFF ${f.file}: ${f.count} pixel${f.count === 1 ? "" : "s"} differ in ${f.box.x},${f.box.y} ${f.box.width}x${f.box.height}`);
  else console.log(`DIFF ${f.file}: ${f.reason}`);
}
const same = r.files.filter((f) => f.same).length;
console.log(`${same}/${r.files.length} identical${r.files.length === 0 ? " (no PNG files found)" : ""}`);
process.exit(r.ok ? 0 : 1);
