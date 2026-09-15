/**
 * 自定义选区的纯逻辑：位置比较、长按初选的词边界、跨句拆分。
 *
 * 选区一律用「章 + 句 + 句内字符偏移」记录，屏幕坐标只在画高亮和手柄时临时算。
 * 这样换字号、换字体、切分页模式之后选区还在原处，不会因为版式变了就飘走。
 */

export interface SelectionPlace {
  chapterIndex: number;
  sentenceIndex: number;
  sentenceId: string;
  /** 在这句话纯文本里的字符下标，和 sentence.text 对得上。 */
  offset: number;
}

export interface TextSelection {
  /** 长按落点，拖手柄时不动的那一端。 */
  anchor: SelectionPlace;
  /** 正在拖的那一端。 */
  focus: SelectionPlace;
}

export interface SelectionSentence {
  chapterIndex: number;
  sentenceIndex: number;
  sentenceId: string;
  text: string;
}

/** 选区落在某一句上的那一截，字段跟划线记录对得上。 */
export interface SelectionPart {
  chapterIndex: number;
  sentenceIndex: number;
  sentenceId: string;
  start: number;
  end: number;
  text: string;
}

export function comparePlaces(a: SelectionPlace, b: SelectionPlace): number {
  return (
    a.chapterIndex - b.chapterIndex ||
    a.sentenceIndex - b.sentenceIndex ||
    a.offset - b.offset
  );
}

/** 把 anchor/focus 摆正成前后顺序——手柄可以反着拖过头。 */
export function orderedSelection(selection: TextSelection): {
  start: SelectionPlace;
  end: SelectionPlace;
} {
  return comparePlaces(selection.anchor, selection.focus) <= 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

export function isEmptySelection(selection: TextSelection): boolean {
  return comparePlaces(selection.anchor, selection.focus) === 0;
}

const CJK = /[㐀-鿿豈-﫿぀-ヿ]/;
const WORDISH = /[0-9A-Za-zÀ-ɏ'’]/;

let segmenter: Intl.Segmenter | null | undefined;
let graphemes: Intl.Segmenter | undefined;

/** DOM 偏移是 UTF-16；保存和拖动的边界必须落在完整可见字符上。 */
export function snapSelectionOffset(text: string, offset: number, edge: "start" | "end"): number {
  const at = Math.max(0, Math.min(offset, text.length));
  if (at === 0 || at === text.length) return at;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    graphemes ??= new Intl.Segmenter("zh", { granularity: "grapheme" });
    for (const part of graphemes.segment(text)) {
      const end = part.index + part.segment.length;
      if (at === part.index || at === end) return at;
      if (at < end) return edge === "start" ? part.index : end;
    }
  } else {
    let start = 0;
    for (const char of text) {
      const end = start + char.length;
      if (at > start && at < end) return edge === "start" ? start : end;
      start = end;
    }
  }
  return at;
}

function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter !== undefined) return segmenter;
  // iOS 16.4 起才有。拿不到就退回按字符类粗分，中文会退化成单字起选。
  segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter("zh", { granularity: "word" })
      : null;
  return segmenter;
}

/** 没有分词器时的兜底：英文数字取整串，中日文取单字，其余原样一个字符。 */
function expandByCharClass(
  text: string,
  offset: number
): { start: number; end: number } {
  const char = text[offset];
  if (char && WORDISH.test(char)) {
    let start = offset;
    let end = offset + 1;
    while (start > 0 && WORDISH.test(text[start - 1])) start -= 1;
    while (end < text.length && WORDISH.test(text[end])) end += 1;
    return { start, end };
  }
  return { start: snapSelectionOffset(text, offset, "start"), end: snapSelectionOffset(text, offset + 1, "end") };
}

/**
 * 长按那一下先选中什么。有分词器就取落点所在的词，落在标点或空白上就只取一个字符，
 * 让用户接着拖手柄——初选就把标点圈进去反而更难调。
 */
export function expandToWord(
  text: string,
  offset: number
): { start: number; end: number } {
  if (!text.length) return { start: 0, end: 0 };
  const at = Math.max(0, Math.min(offset, text.length - 1));

  const segmenterInstance = wordSegmenter();
  if (!segmenterInstance) return expandByCharClass(text, at);

  for (const piece of segmenterInstance.segment(text)) {
    const start = piece.index;
    const end = start + piece.segment.length;
    if (at < start || at >= end) continue;
    return { start, end };
  }
  return { start: at, end: Math.min(text.length, at + 1) };
}

/** 这个字符算不算正文内容，用来判断长按点是不是落在可选的文字上。 */
export function isSelectableChar(char: string): boolean {
  return Boolean(char) && !/\s/.test(char);
}

export function isCjk(char: string): boolean {
  return CJK.test(char);
}

/**
 * 把选区按句子拆开。跨句、跨段、跨章都从这里出去，
 * 划线、复制、问 AI 拿到的是同一份拆分结果，不会各算各的。
 */
export function selectionParts(
  selection: TextSelection,
  sentences: SelectionSentence[]
): SelectionPart[] {
  const { start, end } = orderedSelection(selection);
  const parts: SelectionPart[] = [];

  for (const sentence of sentences) {
    const here: SelectionPlace = {
      chapterIndex: sentence.chapterIndex,
      sentenceIndex: sentence.sentenceIndex,
      sentenceId: sentence.sentenceId,
      offset: 0,
    };
    // 只比到句子这一层：偏移量在句内单独裁。
    const beforeStart =
      here.chapterIndex < start.chapterIndex ||
      (here.chapterIndex === start.chapterIndex &&
        here.sentenceIndex < start.sentenceIndex);
    const afterEnd =
      here.chapterIndex > end.chapterIndex ||
      (here.chapterIndex === end.chapterIndex &&
        here.sentenceIndex > end.sentenceIndex);
    if (beforeStart || afterEnd) continue;

    const isStart =
      here.chapterIndex === start.chapterIndex &&
      here.sentenceIndex === start.sentenceIndex;
    const isEnd =
      here.chapterIndex === end.chapterIndex &&
      here.sentenceIndex === end.sentenceIndex;

    const from = isStart ? snapSelectionOffset(sentence.text, start.offset, "start") : 0;
    const to = isEnd
      ? snapSelectionOffset(sentence.text, end.offset, "end")
      : sentence.text.length;
    if (to <= from) continue;

    parts.push({
      chapterIndex: sentence.chapterIndex,
      sentenceIndex: sentence.sentenceIndex,
      sentenceId: sentence.sentenceId,
      start: from,
      end: to,
      text: sentence.text.slice(from, to),
    });
  }

  return parts;
}

/** 拼回用户看到的那一整段文字。跨句之间不额外加分隔符，正文本来就是连着的。 */
export function selectionText(parts: SelectionPart[]): string {
  return parts.map((part) => part.text).join("");
}
