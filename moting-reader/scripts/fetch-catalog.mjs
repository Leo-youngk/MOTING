/**
 * 把书城各分类的书目抓成静态 JSON，放进 public/catalog/。
 *
 * 为什么要离线
 * ------------
 * 榜单原来是「拿分类词去搜索、翻 N 页攒池」，一次请求就扇出 N 个上游搜索。
 * 分类一多、切换一勤，量就上去了——实测连着取十几个分类之后 Agent API 直接 403 封掉密钥。
 * 而分类书目本来就不需要实时：推荐值和在读人数是慢变量，一个月重抓一次都算勤快。
 * 抓成文件之后书城读的是本地 JSON，零上游请求、零延迟，风控也就跟线上没关系了。
 *
 * 数据从哪来
 * ----------
 * weread.qq.com 的分类页是 Vue SSR，整页数据内嵌在 `__INITIAL_STATE__` 里，
 * **匿名就能取，不用 API key**。一页固定给 20 本，加 ?maxIdx 之类的参数也翻不动
 * （试过，回的还是头 20 本），所以只能广度优先：把官方所有一级/二级分类页和榜单页
 * 各抓一页，攒成一个大池子，再按每本书自带的 `category` 字段分到墨听的分类里去。
 *
 * 这条路是爬页面不是调接口，页面改版就会断——但断的是这个脚本，不是线上功能：
 * 线上读的是已经抓好的文件，最坏情况是书目停在上一次抓取的那天。
 *
 * 跑法（在 moting-reader/ 下）：
 *   node scripts/fetch-catalog.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";

const ORIGIN = "https://weread.qq.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 每个分类最多留多少本。够不到就有多少写多少，不拿别的分类的书凑数。 */
const PER_CATEGORY = 150;
const GAP_MS = 350;
const RETRIES = 3;
const RETRY_BACKOFF_MS = 2500;

/** 官方榜单页，一样是一页 20 本。它们的书质量高，抓来按 category 散进各分类。 */
const RANK_PAGES = [
  "all",
  "rising",
  "newbook",
  "hot_search",
  "general_novel_rising",
  "newrating_publish",
  "newrating_potential_publish",
];

/**
 * 墨听的分类 → 官方 category 字段的前缀。
 *
 * 书自带的 category 长这样：「精品小说-科幻小说」「男生小说-东方玄幻」，
 * 拿前缀分组比按「书是从哪个页面抓来的」准——官方的分类页里本来就混着别处的书。
 * 网文（男生小说 / 女生小说）整个排除掉，要的是出版书。
 */
const TARGETS = [
  { name: "小说", slug: "novel", prefixes: ["精品小说"] },
  { name: "文学", slug: "literature", prefixes: ["文学"] },
  { name: "历史", slug: "history", prefixes: ["历史"] },
  { name: "传记", slug: "biography", prefixes: ["人物传记"] },
  { name: "哲学", slug: "philosophy", prefixes: ["哲学宗教"] },
  { name: "心理", slug: "psychology", prefixes: ["心理"] },
  { name: "个人成长", slug: "growth", prefixes: ["个人成长"] },
  // 官方「经济理财」只有四个二级分类，书凑不够，把传记里的财经人物算进来。
  { name: "经济理财", slug: "finance", prefixes: ["经济理财"], also: ["人物传记-财经人物"] },
  // 同理，社会话题把政治军事一起算上。
  { name: "社会", slug: "society", prefixes: ["社会文化", "政治军事"] },
  { name: "科幻", slug: "scifi", exact: ["精品小说-科幻小说"] },
  { name: "旅行", slug: "travel", exact: ["生活百科-旅游"] },
];

/** 网文不要——用户要的是出版书。 */
const WEB_NOVEL = ["男生小说", "女生小说"];

/**
 * 分类页一页只给 20 本，有些分类的二级分类少，凑不够数。
 * 网页版搜索 /web/search/books 同样是 SSR、同样不用 key，一次给 40 本，拿它来补。
 *
 * 补进来的书按两道闸过：`ispub === 1`（正式出版书，挡掉自出版和网文）、
 * 评分人数 >= 500（有口碑的）。宁可某个分类只有几十本，也不拿小众书把数字凑到 150。
 * 搜索结果不带 category 字段，所以归类只能按「这本书是搜哪个词搜出来的」。
 */
const FILL_WORDS = {
  novel: ["长篇小说", "中篇小说", "短篇小说集", "世界名著"],
  literature: ["散文集", "诗集", "文学评论", "随笔"],
  history: ["通史", "断代史", "考古", "史学"],
  biography: ["传记", "自传", "回忆录", "评传"],
  philosophy: ["哲学入门", "思想史", "伦理学", "形而上学"],
  psychology: ["心理学", "认知科学", "精神分析", "情绪管理"],
  growth: ["自我提升", "习惯养成", "时间管理", "学习方法"],
  finance: ["投资", "经济学", "商业史", "财务自由"],
  society: ["社会学", "人类学", "城市研究", "田野调查"],
  scifi: ["科幻小说", "世界科幻大师", "赛博朋克", "太空歌剧", "末世", "时间旅行", "外星文明"],
  travel: ["旅行文学", "游记", "徒步", "自驾", "背包客", "人文地理", "旅居"],
};
/** 补进来的书至少要这么多人打过分。 */
const FILL_MIN_RATING_COUNT = 500;

const outDir = new URL("../public/catalog/", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml(path) {
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}${path}`, {
        headers: { "User-Agent": UA, accept: "text/html" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt === RETRIES) throw error;
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new Error("unreachable");
}

/** 从 SSR 页面里挖出 `__INITIAL_STATE__`。 */
function readState(html) {
  const at = html.indexOf("__INITIAL_STATE__=");
  if (at < 0) throw new Error("页面里没有 __INITIAL_STATE__，多半是改版了");
  const tail = html.slice(at + "__INITIAL_STATE__=".length);
  let end = tail.indexOf(";(function");
  if (end < 0) end = tail.indexOf("</script>");
  if (end < 0) throw new Error("__INITIAL_STATE__ 没有收尾，多半是改版了");
  return JSON.parse(tail.slice(0, end));
}

const text = (value, max) => {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw ? raw.slice(0, max) : null;
};
const num = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** 封面只认微信读书自己的两个图床，别把别的地址写进仓库。 */
function coverLink(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw.replace(/^http:/i, "https:"));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const ok = url.hostname === "cdn.weread.qq.com" || url.hostname.endsWith(".image.myqcloud.com");
  return ok ? url.toString() : null;
}

/**
 * 分类页里的一本书。
 * 简介不存——列表用不上，详情页会去查 /book/info，存进来白白让文件大三倍。
 */
function normalizeBook(entry) {
  const info = entry?.bookInfo ?? entry;
  const bookId = text(info?.bookId, 32);
  const title = text(info?.title, 300);
  if (!bookId || !title) return null;
  return {
    bookId,
    title,
    author: text(info?.author, 200) ?? "",
    translator: text(info?.translator, 200),
    coverUrl: coverLink(info?.cover),
    category: text(info?.category, 100),
    rating: num(info?.newRating),
    ratingCount: num(info?.newRatingCount),
    ratingLabel: text(info?.newRatingDetail?.title, 40),
    readingCount: num(entry?.readingCount ?? info?.readingCount),
  };
}

async function searchBooks(keyword) {
  const state = readState(await fetchHtml(`/web/search/books?keyword=${encodeURIComponent(keyword)}`));
  const list = state?.searchBooksStoreModule?.bookInfos ?? [];
  return list
    .filter((entry) => (entry?.bookInfo ?? entry)?.ispub === 1)
    .map(normalizeBook)
    .filter((book) => book && (book.ratingCount ?? 0) >= FILL_MIN_RATING_COUNT);
}

async function fetchPage(categoryId) {
  const state = readState(await fetchHtml(`/web/category/${categoryId}`));
  return (state?.categoryStoreModule?.categoryBookList ?? []).map(normalizeBook).filter(Boolean);
}

// ---- 1. 分类树 ----
console.log("读分类树…");
const tree = readState(await fetchHtml("/web/category/100000"))?.homeStoreModule?.categories ?? [];
if (!tree.length) throw new Error("没读到分类树，页面多半改版了");

const pages = [];
for (const top of tree) {
  pages.push({ id: top.CategoryId, label: top.title });
  for (const sub of top.sublist ?? []) pages.push({ id: sub.CategoryId, label: `${top.title}/${sub.title}` });
}
for (const id of RANK_PAGES) pages.push({ id, label: `榜单/${id}` });
console.log(`  ${tree.length} 个一级分类，连二级和榜单一共 ${pages.length} 页要抓\n`);

// ---- 2. 广度抓一遍，攒成一个池子 ----
const pool = new Map();
let done = 0;
for (const { id, label } of pages) {
  try {
    for (const book of await fetchPage(id)) {
      // 同一本书会出现在好几个页面上，先到先得，后面的不覆盖。
      if (!pool.has(book.bookId)) pool.set(book.bookId, book);
    }
  } catch (error) {
    console.log(`\n  ⚠ ${label} 抓不到（${error.message}），跳过`);
  }
  done += 1;
  process.stdout.write(`\r  ${done}/${pages.length} 页，池子 ${pool.size} 本   `);
  await sleep(GAP_MS);
}
console.log(`\r  抓完 ${done} 页，去重后 ${pool.size} 本\n`);

// ---- 3. 按 category 分到各个分类 ----
const all = [...pool.values()];
const webNovel = all.filter((b) => WEB_NOVEL.some((p) => b.category?.startsWith(`${p}-`))).length;
console.log(`  其中网文 ${webNovel} 本，不要（你要的是出版书）\n`);

await mkdir(outDir, { recursive: true });
const index = [];

for (const target of TARGETS) {
  const picked = all.filter((book) => {
    const category = book.category ?? "";
    if (WEB_NOVEL.some((p) => category.startsWith(`${p}-`))) return false;
    if (target.exact?.includes(category)) return true;
    if (target.also?.includes(category)) return true;
    return (target.prefixes ?? []).some((p) => category === p || category.startsWith(`${p}-`));
  });

  // 按在读人数排：官方分类页本来就是这个顺序，「全部」那一栏跟着它走最自然。
  // 榜是前端另按推荐值排的，两种看法各管各的。
  picked.sort((a, b) => (b.readingCount ?? 0) - (a.readingCount ?? 0));
  const chosen = new Map(picked.slice(0, PER_CATEGORY).map((b) => [b.bookId, b]));
  const fromPages = chosen.size;

  // 分类页给不够就用搜索补，补进来的已经过了「正式出版 + 500 人评分」两道闸。
  for (const word of FILL_WORDS[target.slug] ?? []) {
    if (chosen.size >= PER_CATEGORY) break;
    try {
      for (const book of await searchBooks(word)) {
        if (chosen.size >= PER_CATEGORY) break;
        if (!chosen.has(book.bookId)) chosen.set(book.bookId, book);
      }
    } catch (error) {
      console.log(`\n  ⚠ ${target.name} 补「${word}」失败（${error.message}）`);
    }
    process.stdout.write(`\r  ${target.name}：补「${word}」→ ${chosen.size} 本        `);
    await sleep(GAP_MS);
  }

  const books = [...chosen.values()];
  const filled = books.length - fromPages;
  const rated = books.filter((b) => b.rating !== null && (b.ratingCount ?? 0) >= 500).length;

  await writeFile(
    new URL(`${target.slug}.json`, outDir),
    JSON.stringify({
      category: target.name,
      slug: target.slug,
      generatedAt: new Date().toISOString().slice(0, 10),
      books,
    }),
    "utf8"
  );
  index.push({ name: target.name, slug: target.slug, count: books.length, rated });
  console.log(
    `\r  ${target.name}：${books.length} 本（分类页 ${fromPages}` +
      `${filled ? ` + 搜索补 ${filled}` : ""}，${rated} 本评分人数够上榜）        `
  );
}

await writeFile(
  new URL("index.json", outDir),
  JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), categories: index }),
  "utf8"
);

const total = index.reduce((sum, c) => sum + c.count, 0);
console.log(`\n写完了：${index.length} 个分类、${total} 本书 → public/catalog/`);
for (const c of index) {
  if (c.count < PER_CATEGORY) {
    console.log(`  ⚠ ${c.name} 只有 ${c.count} 本——官方这个分类下的出版书就这么多，没拿别处的凑`);
  }
}
