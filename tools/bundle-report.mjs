// Prints (and writes to dist/bundle-report.md) the size of every built chunk
// with gzip and brotli figures, so a change in chunking can be judged from a
// terminal. Run after `pnpm build:web`.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";

const dist = resolve(new URL("../dist", import.meta.url).pathname);
const REPORTED = /\.(js|css|html|webmanifest)$/u;

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1).padStart(7)} kB`;
}

function files() {
  const entries = [];
  const scan = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) {
        scan(full, `${prefix}${name}/`);
      } else if (REPORTED.test(name)) {
        entries.push({ path: `${prefix}${name}`, full });
      }
    }
  };
  scan(dist, "");
  return entries;
}

const rows = files().map(({ path, full }) => {
  const bytes = readFileSync(full);
  return {
    path,
    raw: bytes.length,
    gzip: gzipSync(bytes, { level: 9 }).length,
    brotli: brotliCompressSync(bytes).length,
  };
});
rows.sort((a, b) => b.raw - a.raw);
const total = rows.reduce(
  (sum, row) => ({
    raw: sum.raw + row.raw,
    gzip: sum.gzip + row.gzip,
    brotli: sum.brotli + row.brotli,
  }),
  { raw: 0, gzip: 0, brotli: 0 }
);

const lines = [
  "| File | Raw | gzip | brotli |",
  "| --- | ---: | ---: | ---: |",
  ...rows.map(
    (row) =>
      `| ${row.path} | ${kb(row.raw)} | ${kb(row.gzip)} | ${kb(row.brotli)} |`
  ),
  `| **total** | ${kb(total.raw)} | ${kb(total.gzip)} | ${kb(total.brotli)} |`,
];
const report = `# Bundle report\n\n${lines.join("\n")}\n`;
writeFileSync(join(dist, "bundle-report.md"), report);
console.log(report);
