/**
 * 英文书的点词释义：本地英汉词典的查词逻辑。
 *
 * 数据是从 ECDICT（MIT）裁出来的常用词，按首字母拆成 26 个 JSON 放在 public/dict/ 下，
 * 由 scripts/build-dictionary.mjs 生成。点到哪个字母才取哪个文件，取过一次 service worker
 * 就存住了，之后离线也能查。不走 AI：点一个词要的是马上出来，不能等模型，也不该要 API Key。
 */

/** 数据目录带版本号：service worker 对静态文件是缓存优先，换数据必须换路径。 */
export const DICTIONARY_PATH = "/dict/en-zh-1";

/**
 * 一个词条：[音标, 释义（一个词性一行）, 原形?, 变形说明?]。
 * 后两项只有「left」这种自己有意思、同时又是别的词变形的才有。
 */
export type DictEntry = [phonetic: string, gloss: string, base?: string, label?: string];

/** 规则推不出原形的变形（went → go）：[原形, 变形说明, 音标?]。 */
export type DictForm = [base: string, label: string, phonetic?: string];

export interface DictShard {
  entries: Record<string, DictEntry>;
  forms: Record<string, DictForm>;
}

export interface DictionaryAccess {
  entry(key: string): DictEntry | undefined;
  form(key: string): DictForm | undefined;
}

/** 在词典里落到了哪儿：直接是个词条，或者是某个词条的变形。 */
export type WordHit =
  | { kind: "entry"; key: string }
  | { kind: "form"; surface: string; base: string; label: string; phonetic?: string };

export interface WordGloss {
  /** 释义卡上的标题：词典里的写法，变形就是用户点的那个形式。 */
  word: string;
  phonetic: string;
  /** 释义，一个词性一行。查不到时是空的。 */
  lines: string[];
  /** 经变形还原才查到的：「go 的过去式」；句中大写开头的提醒一句可能是名字。 */
  note?: string;
  /**
   * 自己有意思、同时也是别的词的变形（found、left、rose）：正文里多半是后一种，
   * 所以原形那一义也得摆出来，不能只给「建立」「左边的」「玫瑰」。
   */
  also?: { title: string; line: string };
}

const APOSTROPHES = /[\u2018\u2019\u02bc\u2032]/g;
const WORD_SHAPE = /^[A-Za-z][A-Za-z'.-]*$/;

/**
 * 分词器给的词 → 查词用的写法。弯引号统一成直的，去掉首尾的引号、标点；
 * 不是英文词（带数字、夹着别的文字）就返回 null，调用方当没点到词。
 */
export function normalizeToken(raw: string): string | null {
  const token = raw
    .replace(APOSTROPHES, "'")
    .replace(/\u00ad/g, "")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[^A-Za-z0-9]+$/, "");
  return token && WORD_SHAPE.test(token) ? token : null;
}

/** 句子里的一截：点词时要查的词和它在句内的起止（画底色用）。 */
export interface WordSpan {
  start: number;
  end: number;
  token: string;
}

const ALNUM = /[A-Za-z0-9]/;

function spanOf(text: string, start: number, end: number): WordSpan | null {
  while (start < end && !ALNUM.test(text[start])) start += 1;
  while (end > start && !ALNUM.test(text[end - 1])) end -= 1;
  const token = normalizeToken(text.slice(start, end));
  return token ? { start, end, token } : null;
}

/**
 * 点中的词要查哪几种切法。分词器会把 well-known 切成 well / - / known，
 * 所以先给整个连字符复合词（词典里有就用它），再给点中的那一个词。不是英文词就是空的。
 */
export function lookupSpans(text: string, start: number, end: number): WordSpan[] {
  const word = spanOf(text, start, end);
  if (!word) return [];
  let from = word.start;
  let to = word.end;
  while (from > 0 && /[A-Za-z'\u2019-]/.test(text[from - 1])) from -= 1;
  while (to < text.length && /[A-Za-z'\u2019-]/.test(text[to])) to += 1;
  const compound = spanOf(text, from, to);
  return compound && compound.token !== word.token && compound.token.includes("-")
    ? [compound, word]
    : [word];
}

export function shardKey(word: string): string {
  return word.charAt(0).toLowerCase();
}

/**
 * 原样，再试各种大小写：句首的 The 要找 the，全大写标题里的 LONDON 要找 London，
 * ECDICT 里 north 只收了 North 一条。最后是句点被分词器留在外面的缩写（St → St.、e.g → e.g.）。
 */
function exactKeys(token: string): string[] {
  const lower = token.toLowerCase();
  const title = lower.charAt(0).toUpperCase() + lower.slice(1);
  return [...new Set([token, lower, title, token.toUpperCase(), `${token}.`, `${lower}.`])];
}

const VERB = /(?:^|\n)(?:v|vt|vi|aux)\./;
const NOUN = /(?:^|\n)(?:n|pl)\./;
const ADJ = /(?:^|\n)(?:adj|adv)\./;
const TAGGED = /(?:^|\n)[a-z]+\./;

type Shape = "verb" | "plural" | "degree";

/** 规则猜出来的原形对不对得上词性：stopped 的原形得是动词，happier 的得是形容词。 */
function labelFor(shape: Shape, gloss: string, label: string): string | null {
  // 没标词性的释义（「阁下，先生」）没法判断，认它，只是不写变形说明。
  if (!TAGGED.test(gloss)) return "";
  if (shape === "verb") return VERB.test(gloss) ? label : null;
  if (shape === "degree") return ADJ.test(gloss) ? label : null;
  const noun = NOUN.test(gloss);
  const verb = VERB.test(gloss);
  if (noun && verb) return "复数、第三人称单数";
  if (noun) return "复数";
  if (verb) return "第三人称单数";
  return null;
}

export interface StemCandidate {
  base: string;
  shape: Shape;
  label: string;
}

/**
 * 按常见词尾猜原形，猜得最准的排前面。
 *
 * 规则总有猜错的（hoped 会先碰到 hop）：生成词典时拿 ECDICT 自带的变形表逐个核对，
 * 规则猜不对的写进 forms，查词时 forms 先于规则，所以这里只求「大多数对」。
 */
export function stemCandidates(word: string): StemCandidate[] {
  const out: StemCandidate[] = [];
  const add = (base: string, shape: Shape, label: string) => {
    if (base.length >= 2 && !out.some((item) => item.base === base)) {
      out.push({ base, shape, label });
    }
  };
  // stopp → stop、bigg → big：双写的辅音字母去掉一个。
  const undouble = (stem: string) =>
    stem.length >= 3 &&
    stem[stem.length - 1] === stem[stem.length - 2] &&
    !/[aeiouy]/.test(stem[stem.length - 1])
      ? stem.slice(0, -1)
      : null;

  if (/[^aeiou]ies$/.test(word)) add(`${word.slice(0, -3)}y`, "plural", "");
  if (/(?:s|x|z|ch|sh|o)es$/.test(word)) add(word.slice(0, -2), "plural", "");
  if (/ves$/.test(word)) {
    add(`${word.slice(0, -3)}f`, "plural", "");
    add(`${word.slice(0, -3)}fe`, "plural", "");
  }
  if (/[^su]s$/.test(word)) add(word.slice(0, -1), "plural", "");

  if (/[^aeiou]ied$/.test(word)) add(`${word.slice(0, -3)}y`, "verb", "过去式、过去分词");
  if (/ed$/.test(word)) {
    const stem = word.slice(0, -2);
    add(word.slice(0, -1), "verb", "过去式、过去分词");
    add(stem, "verb", "过去式、过去分词");
    const single = undouble(stem);
    if (single) add(single, "verb", "过去式、过去分词");
  }

  if (/ying$/.test(word)) add(`${word.slice(0, -4)}ie`, "verb", "现在分词");
  if (/ing$/.test(word)) {
    const stem = word.slice(0, -3);
    add(`${stem}e`, "verb", "现在分词");
    add(stem, "verb", "现在分词");
    const single = undouble(stem);
    if (single) add(single, "verb", "现在分词");
  }

  if (/[^aeiou]ier$/.test(word)) add(`${word.slice(0, -3)}y`, "degree", "比较级");
  if (/er$/.test(word)) {
    const stem = word.slice(0, -2);
    add(stem, "degree", "比较级");
    add(word.slice(0, -1), "degree", "比较级");
    const single = undouble(stem);
    if (single) add(single, "degree", "比较级");
  }
  if (/[^aeiou]iest$/.test(word)) add(`${word.slice(0, -4)}y`, "degree", "最高级");
  if (/est$/.test(word)) {
    const stem = word.slice(0, -3);
    add(stem, "degree", "最高级");
    add(word.slice(0, -2), "degree", "最高级");
    const single = undouble(stem);
    if (single) add(single, "degree", "最高级");
  }
  return out;
}

/** Harry's、dogs'、shouldn't：缩写和所有格查不到时退回前面那个词。 */
const CLITIC = /^(.+?)(?:'s|'re|'ve|'ll|'d|'m|n't|')$/i;

function resolveOnce(token: string, dict: DictionaryAccess): WordHit | null {
  for (const key of exactKeys(token)) {
    if (dict.entry(key)) return { kind: "entry", key };
    const form = dict.form(key);
    if (form) {
      return { kind: "form", surface: key, base: form[0], label: form[1], phonetic: form[2] };
    }
  }
  const lower = token.toLowerCase();
  for (const candidate of stemCandidates(lower)) {
    const entry = dict.entry(candidate.base);
    if (!entry) continue;
    const label = labelFor(candidate.shape, entry[1], candidate.label);
    if (label === null) continue;
    return { kind: "form", surface: lower, base: candidate.base, label };
  }
  return null;
}

/**
 * 一个词在词典里落到哪：先原样（含大小写变体），再查不规则变形表，再按词尾规则还原，
 * 最后去掉缩写、所有格再来一遍。都查不到就是 null。
 */
export function resolveWord(token: string, dict: DictionaryAccess): WordHit | null {
  const direct = resolveOnce(token, dict);
  if (direct) return direct;
  const clitic = CLITIC.exec(token);
  return clitic ? resolveOnce(clitic[1], dict) : null;
}

function accessOf(shard: DictShard): DictionaryAccess {
  return {
    entry: (key) => (Object.hasOwn(shard.entries, key) ? shard.entries[key] : undefined),
    form: (key) => (Object.hasOwn(shard.forms, key) ? shard.forms[key] : undefined),
  };
}

const shards = new Map<string, Promise<DictShard>>();

/** 按首字母取一片词典。同一片只取一次；取失败（离线又没缓存）就忘掉，下次点词再试。 */
export function loadShard(letter: string): Promise<DictShard> {
  let pending = shards.get(letter);
  if (!pending) {
    pending = fetch(`${DICTIONARY_PATH}/${letter}.json`).then((response) => {
      if (!response.ok) throw new Error(`词典加载失败（${response.status}）`);
      return response.json() as Promise<DictShard>;
    });
    shards.set(letter, pending);
    pending.catch(() => shards.delete(letter));
  }
  return pending;
}

/**
 * 原形的释义按变形挑词性排前面：ran 先给 run 的动词义、better 先给 good 的形容词义，
 * 不然排第一的常是不相干的名词义（good 第一行是「n. 善行」）。两可的（wolves 既像复数
 * 又像三单）照原顺序。
 */
function byRelevance(gloss: string, label: string): string[] {
  const lines = gloss.split("\n").filter(Boolean);
  const plural = label.includes("复数");
  const pos = /比较级|最高级/.test(label)
    ? ADJ
    : plural && label.includes("第三人称")
      ? null
      : plural
        ? NOUN
        : /过去|分词|第三人称/.test(label)
          ? VERB
          : null;
  if (!pos) return lines;
  return [...lines.filter((line) => pos.test(line)), ...lines.filter((line) => !pos.test(line))];
}

const NAME_HINT = "大写开头，也可能是人名、地名";

export interface LookupOptions {
  load?: (letter: string) => Promise<DictShard>;
  /** 这个词在句子中间却是大写开头：多半是人名、地名，查到的普通词义要提醒一句。 */
  midSentence?: boolean;
}

/**
 * 查一个词。不是英文词返回 null；是英文词但词典没收（人名、生僻词）返回 lines 为空的结果，
 * 释义卡据此写「未收录」。词典文件取不到时抛错。
 */
export async function lookupWord(
  raw: string,
  { load = loadShard, midSentence = false }: LookupOptions = {}
): Promise<WordGloss | null> {
  const token = normalizeToken(raw);
  if (!token) return null;
  // Harry 在句中查到的是 harry（掠夺），得说一句可能是名字；London 这种词典里本来就大写的不用。
  const named = (key: string) =>
    midSentence && /^[A-Z][a-z]/.test(token) && key !== token ? NAME_HINT : undefined;

  // 原样、小写、规则还原出来的候选首字母都一样，一片就够；原形跨了字母（went → go）再取一片。
  const dict = accessOf(await load(shardKey(token)));
  const hit = resolveWord(token, dict);
  if (!hit) {
    // 章节号（XXIV）、名字缩写（F. Scott）不是词，不弹「未收录」，当没点到词。
    if (token.length === 1 || /^[IVXLCDM]+$/.test(token)) return null;
    return { word: token, phonetic: "", lines: [], note: named("") };
  }

  if (hit.kind === "entry") {
    const [phonetic, gloss, base, label] = dict.entry(hit.key)!;
    const note = named(hit.key);
    const result: WordGloss = {
      // 疑似名字时标题保留原文的大写，下面给的是同拼写普通词的意思。
      word: note ? token : hit.key,
      phonetic,
      lines: gloss.split("\n").filter(Boolean),
      note,
    };
    if (base) {
      const baseEntry = accessOf(await load(shardKey(base))).entry(base);
      const line = baseEntry && byRelevance(baseEntry[1], label ?? "")[0];
      if (line) result.also = { title: `${base} 的${label || "变形"}`, line };
    }
    return result;
  }

  const baseEntry = accessOf(await load(shardKey(hit.base))).entry(hit.base);
  if (!baseEntry) return { word: token, phonetic: "", lines: [], note: named("") };
  return {
    word: hit.surface,
    phonetic: hit.phonetic ?? "",
    lines: byRelevance(baseEntry[1], hit.label),
    note: named(hit.surface) ?? (hit.label ? `${hit.base} 的${hit.label}` : `原形 ${hit.base}`),
  };
}

const TITLES = /\b(?:Mr|Mrs|Ms|Dr|St|Mt|Prof|Sr|Jr|Capt|Col|Gen|Lt|Sgt|Rev)\.$/;

/**
 * 句中第 start 个字符开始的这个词是不是在句子中间。前面没有字、或紧跟在句末标点、
 * 引号、破折号后面，就算句首——那里的大写只是语法，不说明是名字。Mr. 后面算句中。
 */
export function isMidSentence(text: string, start: number): boolean {
  const before = text.slice(0, start).trimEnd();
  if (!before) return false;
  if (TITLES.test(before)) return true;
  return !/[.!?:;"“”‘'(\[—–-]$/.test(before);
}

const LATIN = /[A-Za-z]/g;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;

/**
 * 这段是不是英文。点词只在英文段落里生效，中文书照旧「单击切沉浸」：
 * 中文里夹一两个英文词（iPhone、API）不算，英文里夹个中文人名注释还算英文。
 */
export function isEnglishText(text: string): boolean {
  const latin = text.match(LATIN)?.length ?? 0;
  if (!latin) return false;
  const cjk = text.match(CJK)?.length ?? 0;
  return cjk * 4 < latin;
}
