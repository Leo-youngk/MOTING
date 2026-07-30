/**
 * 把 Noto Serif SC 的 woff2 分片抓到 public/fonts/ 并生成本地 @font-face。
 * Google 已经按字频把字体切成上百个 unicode-range 片段，浏览器只会下正文用到的那几片，
 * 所以仓库里体积大，实际传输很小。字体是 SIL OFL 1.1。
 */
import { mkdir, writeFile } from "node:fs/promises";

const CSS_URL =
  "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;700&display=swap";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const outDir = new URL("../public/fonts/", import.meta.url);
await mkdir(outDir, { recursive: true });

const css = await fetch(CSS_URL, { headers: { "User-Agent": UA } }).then((r) =>
  r.text()
);

// 汉字分片的 URL 自带 `.<序号>.woff2`，latin/cyrillic 这些命名分片没有序号，
// 只能从紧挨着的 /* 注释 */ 里取名字，否则它们会撞成同一个文件名。
const faces = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?@font-face\s*\{([^}]+)\}/g)].map(
  ([, label, body]) => ({ label, body })
);
const read = (body, key) =>
  body.match(new RegExp(`${key}:\\s*([^;]+);`))?.[1].trim() ?? "";

let bytes = 0;
const blocks = [];

const names = new Set();

for (const { label, body } of faces) {
  const weight = read(body, "font-weight");
  const range = read(body, "unicode-range");
  const url = read(body, "src").match(/url\(([^)]+)\)/)?.[1];
  if (!url || !range) continue;

  const slice = url.match(/\.(\d+)\.woff2$/)?.[1] ?? label;
  const name = `noto-serif-sc-${weight}-${slice}.woff2`;
  if (!slice || names.has(name)) {
    throw new Error(`分片名冲突或缺失：${name} （${url}）`);
  }
  names.add(name);
  const data = new Uint8Array(
    await fetch(url, { headers: { "User-Agent": UA } }).then((r) =>
      r.arrayBuffer()
    )
  );
  bytes += data.byteLength;
  await writeFile(new URL(name, outDir), data);

  blocks.push(
    [
      "@font-face {",
      '  font-family: "Noto Serif SC";',
      "  font-style: normal;",
      `  font-weight: ${weight};`,
      "  font-display: swap;",
      `  src: url("/fonts/${name}") format("woff2");`,
      `  unicode-range: ${range};`,
      "}",
    ].join("\n")
  );
}

await writeFile(
  new URL("../app/fonts.css", import.meta.url),
  `/* 由 scripts/fetch-cjk-font.mjs 生成，不要手改。Noto Serif SC，SIL OFL 1.1。 */\n\n${blocks.join(
    "\n\n"
  )}\n`
);

console.log(
  `wrote ${blocks.length} slices, ${(bytes / 1024 / 1024).toFixed(1)} MB total`
);
