import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

import {
  DICTIONARY_PATH,
  isEnglishText,
  isMidSentence,
  lookupWord,
  normalizeToken,
  resolveWord,
  shardKey,
  type DictShard,
} from "../lib/dictionary.ts";

/** 手搭的几片小词典，规则相关的用例不依赖生成出来的数据。 */
const fixture: Record<string, DictShard> = {
  b: { entries: { be: ["biː", "v. 是，在"] }, forms: {} },
  f: {
    entries: {
      find: ["faind", "n. 发现\nvt. 找到，发现"],
      found: ["faund", "vt. 建立，创立", "find", "过去式、过去分词"],
    },
    forms: {},
  },
  g: { entries: { go: ["ɡəʊ", "n. 尝试\nvi. 去，走"] }, forms: {} },
  h: {
    entries: {
      happy: ["ˈhæpi", "adj. 快乐的"],
      harry: ["ˈhæri", "vt. 掠夺，折磨"],
      hop: ["hɒp", "vi. 单脚跳"],
      hope: ["həʊp", "n. 希望\nv. 希望，期望"],
    },
    forms: {},
  },
  l: { entries: { London: ["ˈlʌndən", "n. 伦敦"] }, forms: {} },
  n: { entries: { North: ["nɔːθ", "n. 北方"] }, forms: {} },
  s: {
    entries: { stop: ["stɒp", "n. 车站\nv. 停止"], study: ["ˈstʌdi", "n. 学习\nv. 学习，研究"] },
    forms: {},
  },
  t: { entries: { the: ["ðə", "art. 这，那"], tooth: ["tuːθ", "n. 牙齿"] }, forms: {} },
  w: { entries: { wolf: ["wʊlf", "n. 狼\nvt. 狼吞虎咽"] }, forms: { went: ["go", "过去式", "went"] } },
};

const loads: string[] = [];
const load = async (letter: string) => {
  loads.push(letter);
  return fixture[letter] ?? { entries: {}, forms: {} };
};

function access(letter: string) {
  const shard = fixture[letter] ?? { entries: {}, forms: {} };
  return {
    entry: (key: string) => (Object.hasOwn(shard.entries, key) ? shard.entries[key] : undefined),
    form: (key: string) => (Object.hasOwn(shard.forms, key) ? shard.forms[key] : undefined),
  };
}

test("分词结果去掉引号和标点，弯引号统一成直的，不是英文词就不查", () => {
  assert.equal(normalizeToken("“Hello"), "Hello");
  assert.equal(normalizeToken("world!”"), "world");
  assert.equal(normalizeToken("don’t"), "don't");
  assert.equal(normalizeToken("co\u00adoperate"), "cooperate");
  assert.equal(normalizeToken("1984"), null);
  assert.equal(normalizeToken("MP3"), null);
  assert.equal(normalizeToken("你好"), null);
});

test("大小写：句首的 The、全大写的 LONDON、只收了大写的 North 都能查到", () => {
  assert.deepEqual(resolveWord("The", access("t")), { kind: "entry", key: "the" });
  assert.deepEqual(resolveWord("LONDON", access("l")), { kind: "entry", key: "London" });
  assert.deepEqual(resolveWord("north", access("n")), { kind: "entry", key: "North" });
});

test("变形：不规则的走 forms，规则的按词尾还原，还要对得上词性", () => {
  assert.deepEqual(resolveWord("went", access("w")), {
    kind: "form",
    surface: "went",
    base: "go",
    label: "过去式",
    phonetic: "went",
  });
  assert.deepEqual(resolveWord("stopped", access("s")), {
    kind: "form",
    surface: "stopped",
    base: "stop",
    label: "过去式、过去分词",
  });
  assert.equal((resolveWord("studies", access("s")) as { base: string }).base, "study");
  assert.equal((resolveWord("happier", access("h")) as { label: string }).label, "比较级");
  // hoped 先碰到的 hop 也是动词，但 -ed 先试「去 d」：hope 排在 hop 前面。
  assert.equal((resolveWord("hoped", access("h")) as { base: string }).base, "hope");
  // 名词原形不接受过去式：teethed 不会还原成 tooth。
  assert.equal(resolveWord("toothed", access("t")), null);
});

test("缩写和所有格查不到时退回前面的词；原型链上的名字不算词", () => {
  assert.equal((resolveWord("Harry's", access("h")) as { key: string }).key, "harry");
  for (const word of ["constructor", "toString", "hasOwnProperty"]) {
    assert.equal(resolveWord(word, access(word[0])), null);
  }
});

test("变形词给原形的释义，按变形把相关词性排前面；原形在另一片词典时再取一片", async () => {
  loads.length = 0;
  const gloss = await lookupWord("went", { load });
  assert.deepEqual(gloss, {
    word: "went",
    phonetic: "went",
    lines: ["vi. 去，走", "n. 尝试"],
    note: "go 的过去式",
  });
  assert.deepEqual(loads, ["w", "g"]);
});

test("自己有意思的变形词把原形那一义也带上", async () => {
  const gloss = await lookupWord("found", { load });
  assert.deepEqual(gloss?.lines, ["vt. 建立，创立"]);
  assert.deepEqual(gloss?.also, { title: "find 的过去式、过去分词", line: "vt. 找到，发现" });
});

test("词典没收的英文词给空释义，章节号和单个字母当没点到词", async () => {
  assert.deepEqual(await lookupWord("Hermione", { load }), {
    word: "Hermione",
    phonetic: "",
    lines: [],
    note: undefined,
  });
  assert.equal(await lookupWord("XXIV", { load }), null);
  assert.equal(await lookupWord("F", { load }), null);
  assert.equal(await lookupWord("42", { load }), null);
});

test("句中大写开头、只查到小写普通词的，提醒可能是名字", async () => {
  const name = await lookupWord("Harry", { load, midSentence: true });
  assert.equal(name?.note, "大写开头，也可能是人名、地名");
  assert.equal(name?.word, "Harry");
  assert.deepEqual(name?.lines, ["vt. 掠夺，折磨"]);
  assert.equal((await lookupWord("Harry", { load }))?.note, undefined);
  // 词典里本来就是大写的专有名词不用提醒。
  assert.equal((await lookupWord("London", { load, midSentence: true }))?.note, undefined);
});

test("句首判断：句末标点、引号后面算句首，Mr. 后面算句中", () => {
  assert.equal(isMidSentence("Harry went home.", 0), false);
  assert.equal(isMidSentence("Then Harry went home.", 5), true);
  assert.equal(isMidSentence("He left. Harry stayed.", 9), false);
  assert.equal(isMidSentence("He said, “Harry is here.”", 10), false);
  assert.equal(isMidSentence("Then Mr. Darcy came.", 9), true);
});

test("英文段落才点词：中文里夹几个英文词不算，英文里夹个中文注释还算", () => {
  assert.equal(isEnglishText("It was the best of times, it was the worst of times."), true);
  assert.equal(isEnglishText("Li Bai (李白) was a famous poet of the Tang dynasty."), true);
  assert.equal(isEnglishText("他用 iPhone 拍了一张照片。"), false);
  assert.equal(isEnglishText("我们使用 React Native 开发了这个应用。"), false);
  assert.equal(isEnglishText("一九八四"), false);
  assert.equal(isEnglishText("1984"), false);
});

/** 生成出来的数据：每片都能解析，原形都在，常见词和变形都查得到。 */
const dataDir = new URL(`../public${DICTIONARY_PATH}/`, import.meta.url);

async function realShard(letter: string): Promise<DictShard> {
  return JSON.parse(await readFile(new URL(`${letter}.json`, dataDir), "utf8")) as DictShard;
}

test("词典数据：26 片齐全，变形指向的原形都收了", async () => {
  const files = (await readdir(dataDir)).filter((name) => name.endsWith(".json")).sort();
  assert.deepEqual(
    files,
    [..."abcdefghijklmnopqrstuvwxyz"].map((letter) => `${letter}.json`)
  );
  const shards = new Map<string, DictShard>();
  for (const file of files) shards.set(file[0], await realShard(file[0]));
  for (const [letter, shard] of shards) {
    for (const [word, entry] of Object.entries(shard.entries)) {
      assert.equal(shardKey(word), letter, word);
      assert.ok(entry[1].length > 0, `${word} 没有释义`);
      if (entry[2]) assert.ok(shards.get(shardKey(entry[2]))?.entries[entry[2]], `${word} → ${entry[2]}`);
    }
    for (const [word, form] of Object.entries(shard.forms)) {
      assert.equal(shardKey(word), letter, word);
      assert.ok(!Object.hasOwn(shard.entries, word), `${word} 既是词条又是变形`);
      assert.ok(shards.get(shardKey(form[0]))?.entries[form[0]], `${word} → ${form[0]}`);
    }
  }
});

test("词典数据：常见词、不规则变形、be 的各种形式都查得到", async () => {
  const cases: Array<[string, string]> = [
    ["apprehensive", "惴惴不安"],
    ["went", "go 的过去式"],
    ["children", "孩子"],
    ["mice", "mouse 的复数"],
    ["stopped", "停止"],
    ["am", "be 的现在式"],
    ["were", "be 的过去式"],
    ["north", "北"],
    ["don’t", "不要"],
    ["happier", "happy 的比较级"],
  ];
  for (const [word, expected] of cases) {
    const gloss = await lookupWord(word, { load: realShard });
    const text = [gloss?.note, ...(gloss?.lines ?? []), gloss?.also?.title, gloss?.also?.line].join(" ");
    assert.ok(text.includes(expected), `${word}: ${text}`);
  }
});
