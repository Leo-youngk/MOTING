const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:\s|$)/;
const INDENTED = /^[ \t]/;
/** 引用式链接、脚注的定义（`[1]: https://…`、`[^1]: …`）。 */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/m;

/**
 * 把 Markdown 按顶层的块切开（空行分隔）。流式输出时前面写完的块内容不再变，
 * 渲染端按块缓存，每来一小段字只重新解析最后一块，不用整篇重来。
 *
 * 只在「切开和不切渲染结果一样」的地方切：
 * - 代码围栏里的空行不算分隔；
 * - 空行后面是缩进行（列表的续行、缩进代码）不切；
 * - 列表中间的空行（松散列表）不切，否则一张列表会断成两张、编号从头来；
 * - 有引用式链接或脚注定义时整篇不切：定义和用到它的地方会落进不同的块。
 */
export function markdownBlocks(markdown: string): string[] {
  if (DEFINITION.test(markdown)) return [markdown];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  let inList = false;
  let afterBlank = false;

  const flush = () => {
    const text = current.join("\n").replace(/\s+$/, "");
    if (text) blocks.push(text);
    current = [];
    inList = false;
  };

  for (const line of markdown.split("\n")) {
    if (fence) {
      current.push(line);
      const close = line.match(FENCE_CLOSE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    if (!line.trim()) {
      afterBlank = true;
      current.push(line);
      continue;
    }
    if (afterBlank && !INDENTED.test(line) && !(inList && LIST_ITEM.test(line))) flush();
    afterBlank = false;
    current.push(line);
    const open = line.match(FENCE_OPEN);
    if (open) fence = open[1];
    else if (LIST_ITEM.test(line)) inList = true;
  }
  flush();
  return blocks;
}
