import assert from "node:assert/strict";
import test from "node:test";
import {
  bookSearchQuery,
  cleanTitleText,
  decideAutoApply,
  formatAuthors,
  isPlaceholderAuthor,
  lookupQuery,
  needsMetadataLookup,
  normalizeTitleKey,
  titleLooksLikeFileName,
} from "../lib/book-metadata.ts";
import type { BookMetadataCandidate } from "../lib/book-metadata-types.ts";
import type { Book } from "../lib/types.ts";

function book(overrides: Partial<Book> = {}): Book {
  return {
    id: "book_1",
    title: "三国演义",
    author: "罗贯中",
    format: "epub",
    fileName: "三国演义.epub",
    accent: "#8a6d3b",
    status: "ready",
    createdAt: 0,
    updatedAt: 0,
    lastOpenedAt: 0,
    chapters: [],
    sentenceCount: 0,
    characterCount: 0,
    ...overrides,
  };
}

function candidate(overrides: Partial<BookMetadataCandidate> = {}): BookMetadataCandidate {
  return {
    volumeId: "vol_1",
    title: "三国演义",
    authors: ["罗贯中"],
    publishedDate: null,
    description: null,
    categories: [],
    coverUrl: null,
    language: null,
    infoLink: null,
    rating: 890,
    ratingCount: 12000,
    ratingLabel: "好评如潮",
    ...overrides,
  };
}

test("书名指纹抹掉盗版噪声，但不会把不同的书抹成同一本", () => {
  assert.equal(normalizeTitleKey("三国演义(完整版)@某某书屋"), "三国演义");
  assert.equal(normalizeTitleKey("《三国演义》"), "三国演义");
  assert.equal(normalizeTitleKey("三国演义.epub"), "三国演义");
  assert.notEqual(normalizeTitleKey("三国演义"), normalizeTitleKey("水浒传"));
  assert.equal(cleanTitleText("活着【精校版】"), "活着");
  // 微信读书常见的版本后缀，清洗后要能跟本地书名对上。
  assert.equal(normalizeTitleKey("三国演义（人民文学版）"), "三国演义");
});

test("占位作者与文件名书名能被认出来", () => {
  assert.equal(isPlaceholderAuthor("未知作者"), true);
  assert.equal(isPlaceholderAuthor("  "), true);
  assert.equal(isPlaceholderAuthor("余华"), false);
  assert.equal(
    titleLooksLikeFileName(book({ title: "活着 余华", fileName: "活着 余华.txt" })),
    true
  );
  assert.equal(
    titleLooksLikeFileName(book({ title: "活着", fileName: "yu-hua-to-live.epub" })),
    false
  );
});

test("上游脏作者字段被清理成一行可读的署名", () => {
  assert.equal(formatAuthors(["加西亚. 马克斯", "于娜 (翻译 )"]), "加西亚. 马克斯 · 于娜");
  assert.equal(formatAuthors(["刘慈欣", "刘慈欣"]), "刘慈欣");
  assert.equal(formatAuthors([]), "");
  // 微信读书的作者带国别方括号，方括号不是我们要剥的噪声，得原样留着。
  assert.equal(formatAuthors(["[哥]加西亚•马尔克斯"]), "[哥]加西亚•马尔克斯");
});

test("「去找这本书」的查询词带上作者，国别方括号要剥掉", () => {
  // 展示时保留国别（formatAuthors），当搜索词时它是噪声。
  assert.equal(
    bookSearchQuery("简·奥斯汀小说全集（果麦经典）", "[英]简·奥斯汀"),
    "简·奥斯汀小说全集 简·奥斯汀"
  );
  // 合著只取第一个人，第二个作者反而会把结果搜没。
  assert.equal(
    bookSearchQuery("体验派人生", "[美]布里奇特·希尔顿 [美]乔·哈夫著"),
    "体验派人生 布里奇特·希尔顿"
  );
  assert.equal(bookSearchQuery("尼采金句100则", "[德]尼采 大咸鱼编"), "尼采金句100则 尼采");
  // 西文名里的空格是名字的一部分，不能按空格切。
  assert.equal(bookSearchQuery("Sapiens", "Yuval Noah Harari"), "Sapiens Yuval Noah Harari");
  // 没有作者就只发书名，不要留下一个尾巴空格。
  assert.equal(bookSearchQuery("活着", ""), "活着");
});

test("资料齐全的书不查询，缺封面或缺作者的才查", () => {
  assert.equal(
    needsMetadataLookup(book({ coverDataUrl: "data:image/webp;base64,x" })),
    false,
    "书名跟文件名一样是正常现象，不能因此就去查"
  );
  assert.equal(
    needsMetadataLookup(
      book({ title: "三国演义(完整版)", coverDataUrl: "data:image/webp;base64,x" })
    ),
    true,
    "书名带噪声才算脏"
  );
  assert.equal(needsMetadataLookup(book()), true, "没有封面就该查");
  assert.equal(
    needsMetadataLookup(book({ author: "未知作者", coverDataUrl: "data:image/webp;base64,x" })),
    true
  );
  assert.equal(needsMetadataLookup(book({ format: "demo" })), false);
  assert.equal(needsMetadataLookup(book({ status: "parsing" })), false);
});

test("书名指纹对不上就一个字段都不套用", () => {
  const dirty = book({ title: "水浒传", author: "未知作者" });
  assert.equal(decideAutoApply(dirty, [candidate()]), null);
});

test("只补脏字段：EPUB 里正确的书名作者封面一律不碰", () => {
  const clean = book({ coverDataUrl: "data:image/webp;base64,x" });
  assert.equal(
    decideAutoApply(clean, [candidate({ title: "三国演义", authors: ["罗贯中 校注版"] })]),
    null,
    "全都齐全时不该产生任何改动"
  );

  const dirty = book({
    title: "三国演义(完整版)@某某书屋",
    author: "未知作者",
    fileName: "三国演义(完整版)@某某书屋.txt",
  });
  const decision = decideAutoApply(dirty, [
    candidate({ coverUrl: "https://cdn.weread.qq.com/x.jpg" }),
  ]);
  assert.ok(decision);
  assert.equal(decision.title, "三国演义");
  assert.equal(decision.author, "罗贯中");
  assert.equal(decision.wantCover, true);
});

test("候选没有作者时不拿它的封面——上游有一批标题对、封面错的记录", () => {
  const dirty = book({
    title: "三体(精校版)",
    author: "未知作者",
    fileName: "三体(精校版).txt",
  });
  const noAuthor = candidate({
    volumeId: "vol_bad",
    title: "三体",
    authors: [],
    coverUrl: "https://cdn.weread.qq.com/bad.jpg",
  });
  const decision = decideAutoApply(dirty, [noAuthor]);
  assert.ok(decision);
  assert.equal(decision.title, "三体");
  assert.equal(decision.author, undefined);
  assert.equal(decision.wantCover, false, "没有作者背书的记录，封面不能信");

  const withAuthor = candidate({
    title: "三体",
    authors: ["刘慈欣"],
    coverUrl: "https://cdn.weread.qq.com/good.jpg",
  });
  assert.equal(decideAutoApply(dirty, [withAuthor])?.wantCover, true);
});

test("书名脏但作者本来就对时，只换书名不动作者", () => {
  const dirty = book({
    title: "三国演义(完整版)",
    author: "罗贯中",
    fileName: "三国演义(完整版).txt",
    coverDataUrl: "data:image/webp;base64,x",
  });
  const decision = decideAutoApply(dirty, [candidate({ authors: ["罗贯中 等"] })]);
  assert.ok(decision);
  assert.equal(decision.title, "三国演义");
  assert.equal(decision.author, undefined);
  assert.equal(decision.wantCover, false);
});

test("查询词去掉噪声，作者是占位值时不参与查询", () => {
  assert.deepEqual(
    lookupQuery(book({ title: "活着【精校版】", author: "未知作者" })),
    { title: "活着", author: "" }
  );
  assert.deepEqual(lookupQuery(book({ title: "活着", author: "余华" })), {
    title: "活着",
    author: "余华",
  });
});
