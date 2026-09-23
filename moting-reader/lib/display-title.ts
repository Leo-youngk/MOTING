/**
 * 书名、章名的显示规则。存储里永远是原始值，只在显示时处理；同步和书籍资料用原文。
 */

/**
 * 书架、列表、播放条里显示的书名：去掉书名后面一串营销括注（「（豆瓣8.7分…）」
 * 「(金爱烂作品集)」）和文件名带出来的「_【波兰】作者」尾巴。书籍资料页照旧显示完整书名。
 * 不用 cleanTitleText：那是给导入文件名去噪的，会把全角标点折成半角、把「全集」剥掉。
 */
export function displayTitle(title: string): string {
  const full = title.trim();
  let short = full.replace(/_[【[［].*$/, "");
  for (;;) {
    const next = short.replace(/\s*[（(][^（）()]*[）)]\s*$/, "");
    if (next === short || !next.trim()) break;
    short = next;
  }
  return short.trim() || full;
}

/**
 * EPUB 转换工具在没有章名时填的占位词。这种「章」多半是上一章的续页：章名页和正文
 * 拆成了两个文件，目录里只登记了章名页。
 */
const PLACEHOLDER_TITLE = /^(?:未知|未命名|无标题|unknown|untitled)$/i;

export function isPlaceholderTitle(title: string | undefined): boolean {
  const trimmed = title?.trim() ?? "";
  return !trimmed || PLACEHOLDER_TITLE.test(trimmed);
}

/** 书开头、第一个有名字的章之前的那段（版权页、献词）。 */
export const FRONT_MATTER_TITLE = "卷首";

type Titled = { title: string };

/** 第 index 章该叫什么：自己没有名字就算前面最近一个有名字的章的续页。 */
export function chapterLabel(outline: readonly Titled[], index: number): string {
  for (let i = Math.min(index, outline.length - 1); i >= 0; i--) {
    if (!isPlaceholderTitle(outline[i].title)) return outline[i].title.trim();
  }
  return outline.length ? FRONT_MATTER_TITLE : "正文";
}

/** 手里只有章对象（AI 面板）时按 id 找它在目录里的位置再取名字。 */
export function chapterLabelFor(
  outline: readonly (Titled & { id: string })[],
  chapterId: string
): string {
  const index = outline.findIndex((chapter) => chapter.id === chapterId);
  return index >= 0 ? chapterLabel(outline, index) : "正文";
}

/**
 * 目录里列出哪几章（返回章下标）：有名字的章，外加开头没名字的那段，
 * 不然书的开头在目录里点不到。续页并进前一项，不单列。
 */
export function tocIndexes(outline: readonly Titled[]): number[] {
  return outline.flatMap((chapter, index) =>
    index === 0 || !isPlaceholderTitle(chapter.title) ? [index] : []
  );
}

/** 读到第 index 章时，目录里该高亮哪一项：往前找最近一个列出来的。 */
export function tocIndexFor(indexes: readonly number[], index: number): number {
  let found = indexes[0] ?? 0;
  for (const candidate of indexes) {
    if (candidate > index) break;
    found = candidate;
  }
  return found;
}
