/**
 * 把 ECDICT 英汉词典裁成「点词释义」用的小词典：public/dict/<版本>/a.json … z.json。
 *
 * 为什么是本地词典
 * ----------------
 * 读英文书时点一个不认识的词，要的是马上出来、离线也能查、不用填 API Key。ECDICT 是 MIT
 * 协议的开源英汉词典，77 万词条里绝大多数是专业词和词组；这里只留有词频排名、考试标签、
 * 柯林斯星级或牛津核心标记的单词（约 5.8 万），释义每个词性一行、只留前几个义项，
 * 够在点词卡里扫一眼。按首字母拆开，点到哪个字母才下载哪一片。
 *
 * 变形词（went、studies、stopped）
 * --------------------------------
 * 不单独收释义：查词时按词尾规则还原原形（lib/dictionary.ts 的 stemCandidates）。
 * 这里拿 ECDICT 自带的变形表逐个核对，规则还原不对的（went → go、hoped 被猜成 hop）
 * 才写进每片的 forms，查词时 forms 先于规则。
 *
 * 跑法（在 moting-reader/ 下）：
 *   node --experimental-strip-types scripts/build-dictionary.mjs [本地 ecdict.csv]
 * 不给路径就从 GitHub 下载下面固定的那一版。数据有变化要把 lib/dictionary.ts 里
 * DICTIONARY_PATH 的版本号加一：service worker 对静态文件缓存优先，同一路径永远读旧的。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  DICTIONARY_PATH,
  resolveWord,
  shardKey,
} from "../lib/dictionary.ts";

const ECDICT_COMMIT = "bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b";
const ECDICT_BASE = `https://raw.githubusercontent.com/skywind3000/ECDICT/${ECDICT_COMMIT}`;

/** 每个词最多几行（一个词性一行），每行义项攒到多长就停：手机上一行半左右，扫一眼就够。 */
const MAX_LINES = 3;
const MAX_LINE_CHARS = 20;

const WORD_SHAPE = /^[A-Za-z][A-Za-z'.-]*$/;
const POS_ALIAS = new Map([
  ["a.", "adj."],
  ["ad.", "adv."],
]);
const INFLECTION = "的\\S*?(?:式|分词|复数|比较级|最高级|人称)";
/** 「hold的过去式和过去分词」「be的现在式第三人称」这种整行只是在指原形，原形另有说明，不当释义。 */
const INFLECTION_LINE = new RegExp(`^[A-Za-z' -]+${INFLECTION}`);
/** 「学业（study的复数）」里括着的那截。 */
const INFLECTION_NOTE = new RegExp(`[（(][A-Za-z' -]+${INFLECTION}[^）)]*[）)]`, "g");
const TYPE_LABELS = new Map([
  ["p", "过去式"],
  ["d", "过去分词"],
  ["i", "现在分词"],
  ["s", "复数"],
  ["3", "第三人称单数"],
  ["r", "比较级"],
  ["t", "最高级"],
]);

/** RFC 4180：引号包着的字段里可以有逗号、换行，两个引号表示一个引号。 */
function* parseCsv(text) {
  let row = [];
  let index = 0;
  while (index < text.length) {
    let field;
    if (text[index] === '"') {
      let end = index + 1;
      field = "";
      while (true) {
        const quote = text.indexOf('"', end);
        if (quote < 0) throw new Error("CSV 引号没有闭合");
        field += text.slice(end, quote);
        if (text[quote + 1] === '"') {
          field += '"';
          end = quote + 2;
        } else {
          index = quote + 1;
          break;
        }
      }
    } else {
      let end = index;
      while (end < text.length && text[end] !== "," && text[end] !== "\n" && text[end] !== "\r") {
        end += 1;
      }
      field = text.slice(index, end);
      index = end;
    }
    row.push(field);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] === "\r") index += 1;
    if (text[index] === "\n" || index >= text.length) {
      index += 1;
      yield row;
      row = [];
    }
  }
}

/** 按顶层的逗号、分号切义项：「使(马,鹰等)戴头罩」括号里的逗号不能切。 */
function senses(body) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of body) {
    if ("(（[【".includes(char)) depth += 1;
    if (")）]】".includes(char)) depth = Math.max(0, depth - 1);
    if (depth === 0 && ",，;；".includes(char)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** 「vi. 去, 走, 达到, 运转, 查阅, 消失, …」→「vi. 去，走，达到，运转，查阅」。 */
function shortenLine(line) {
  const match = /^([a-z]+\.)\s*/.exec(line);
  const pos = match ? (POS_ALIAS.get(match[1]) ?? match[1]) : "";
  let text = "";
  for (const sense of senses(match ? line.slice(match[0].length) : line)) {
    const next = text ? `${text}，${sense}` : sense;
    if (text && next.length > MAX_LINE_CHARS) break;
    text = next;
  }
  if (!text) return "";
  return pos ? `${pos} ${text}` : text;
}

/** 专业领域（[医]、[计]）的行不要；只有网络释义的词才退回用它。 */
function cleanGloss(translation) {
  const general = [];
  const web = [];
  for (const raw of translation.split("\\n")) {
    const line = raw.replace(INFLECTION_NOTE, "").trim();
    if (!line || INFLECTION_LINE.test(line)) continue;
    if (line.startsWith("[网络]")) web.push(line.replace(/^\[网络\]\s*/, ""));
    else if (!/^\[[^\]]*\]/.test(line)) general.push(line);
  }
  return (general.length ? general : web.slice(0, 1))
    .map(shortenLine)
    .filter(Boolean)
    .slice(0, MAX_LINES);
}

/** ECDICT 的音标沿用金山的字形：ә 是西里尔字母、^ 代表 ɡ、句点和逗号是次重音。 */
function cleanPhonetic(raw) {
  const first = raw.split(";")[0].replace(/[[\]]/g, "").trim();
  if (!first || /[^a-zæðŋɑɒɔəɚɛɜɝɡɪʃʊʌʒθεєәˈˊˌː':.,()^ -]/i.test(first)) return "";
  return first
    .replace(/ә/g, "ə")
    .replace(/[εє]/g, "ɛ")
    .replace(/\^/g, "ɡ")
    .replace(/['ˊ]/g, "ˈ")
    .replace(/[.,]/g, "ˌ")
    .replace(/:/g, "ː")
    .replace(/\s+/g, "");
}

function exchangeOf(row) {
  return new Map(
    row.exchange
      .split("/")
      .map((part) => part.split(":"))
      .filter(([type, value]) => type && value)
  );
}

function typeLabel(types) {
  return [...TYPE_LABELS.keys()]
    .filter((type) => types.includes(type))
    .map((type) => TYPE_LABELS.get(type))
    .join("、");
}

function count(value) {
  return Number.parseInt(value, 10) || 0;
}

const source = process.argv[2];
const csv = source
  ? await readFile(source, "utf8")
  : await fetch(`${ECDICT_BASE}/ecdict.csv`).then((response) => {
      if (!response.ok) throw new Error(`下载 ECDICT 失败：${response.status}`);
      return response.text();
    });
const license = await fetch(`${ECDICT_BASE}/LICENSE`).then((response) => {
  if (!response.ok) throw new Error(`下载 ECDICT 许可证失败：${response.status}`);
  return response.text();
});

const rows = parseCsv(csv);
const header = rows.next().value;
const all = new Map();
for (const values of rows) {
  const row = Object.fromEntries(header.map((name, index) => [name, values[index] ?? ""]));
  if (!all.has(row.word)) all.set(row.word, row);
}

const common = (row) =>
  count(row.bnc) > 0 ||
  count(row.frq) > 0 ||
  row.tag.trim() !== "" ||
  count(row.collins) > 0 ||
  count(row.oxford) > 0;

/** 收进来的词：音标、释义行。 */
const entries = new Map();
for (const row of all.values()) {
  if (!WORD_SHAPE.test(row.word) || !common(row)) continue;
  const lines = cleanGloss(row.translation);
  entries.set(row.word, { phonetic: cleanPhonetic(row.phonetic), lines });
}

/** 变形 → 原形。两个来源：变形自己那条的 0:，原形那条列出的各个变形。 */
const inflections = new Map();
const noteInflection = (form, base, types) => {
  if (form === base || !WORD_SHAPE.test(form) || !entries.has(base)) return;
  const known = inflections.get(form);
  if (!known) inflections.set(form, { base, types });
  else if (known.base === base && !known.types.includes(types)) known.types += types;
};
for (const row of all.values()) {
  const exchange = exchangeOf(row);
  if (exchange.has("0")) noteInflection(row.word, exchange.get("0"), exchange.get("1") ?? "");
  if (!entries.has(row.word)) continue;
  for (const [type, form] of exchange) {
    if (TYPE_LABELS.has(type)) noteInflection(form, row.word, type);
  }
}

// be 的变形 ECDICT 记得乱：am 只有大写的 AM（还混着「调幅」），are 是面积单位「公亩」，
// was 的释义是英文。这几个读书时最常点，手工指回 be。
for (const [form, label] of [
  ["am", "现在式（第一人称单数）"],
  ["is", "现在式（第三人称单数）"],
  ["are", "现在式（复数、第二人称）"],
  ["was", "过去式（第一、三人称单数）"],
  ["were", "过去式（复数、第二人称）"],
  ["been", "过去分词"],
]) {
  entries.delete(form);
  inflections.set(form, { base: "be", types: "", label });
}
// 变形表里漏掉的常见不规则变形。
for (const [form, base] of [
  ["gotten", "get"],
  ["bitten", "bite"],
]) {
  inflections.set(form, { base, types: "d" });
}

// 释义只剩「go的过去式」的（went、held）不算词条，按变形处理。
for (const [word, entry] of entries) {
  if (!entry.lines.length) entries.delete(word);
}
for (const [form, inflection] of inflections) {
  if (!entries.has(inflection.base)) inflections.delete(form);
}

const shards = new Map();
const shardOf = (word) => {
  const key = shardKey(word);
  if (!/^[a-z]$/.test(key)) throw new Error(`首字母不是 a-z：${word}`);
  if (!shards.has(key)) shards.set(key, { entries: new Map(), forms: new Map() });
  return shards.get(key);
};

for (const [word, entry] of entries) {
  const record = [entry.phonetic, entry.lines.join("\n")];
  // 自己有释义、同时又是别的词的变形（left、saw、better）：顺带记下原形。
  const inflection = inflections.get(word);
  if (inflection) record.push(inflection.base, inflection.label ?? typeLabel(inflection.types));
  shardOf(word).entries.set(word, record);
}

// 规则能还原对的变形不用写；查词时 forms 先于规则，所以只补规则还原不对的。
const dictionary = {
  entry: (key) => (entries.has(key) ? [entries.get(key).phonetic, entries.get(key).lines.join("\n")] : undefined),
  form: () => undefined,
};
let derived = 0;
for (const [form, inflection] of inflections) {
  if (entries.has(form)) continue;
  const hit = resolveWord(form, dictionary);
  if (hit?.kind === "form" && hit.base === inflection.base) {
    derived += 1;
    continue;
  }
  const record = [inflection.base, inflection.label ?? typeLabel(inflection.types)];
  const phonetic = cleanPhonetic(all.get(form)?.phonetic ?? "");
  if (phonetic) record.push(phonetic);
  shardOf(form).forms.set(form, record);
}

const sorted = (map) =>
  Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

const outDir = new URL(`../public${DICTIONARY_PATH}/`, import.meta.url);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
let bytes = 0;
let forms = 0;
for (const [key, shard] of [...shards].sort()) {
  const json = JSON.stringify({ entries: sorted(shard.entries), forms: sorted(shard.forms) });
  bytes += Buffer.byteLength(json);
  forms += shard.forms.size;
  await writeFile(new URL(`${key}.json`, outDir), json);
}
await writeFile(
  new URL("../public/dict/ECDICT-LICENSE.txt", import.meta.url),
  `墨听的点词释义数据裁自 ECDICT（https://github.com/skywind3000/ECDICT，${ECDICT_COMMIT}）。\n\n${license}`
);

console.log(
  `词条 ${entries.size}，单列的变形 ${forms}（规则能还原的另有 ${derived}），` +
    `${shards.size} 个文件共 ${(bytes / 1024 / 1024).toFixed(2)} MB → public${DICTIONARY_PATH}/`
);
