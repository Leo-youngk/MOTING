import remarkCjkFriendly from "remark-cjk-friendly";
import remarkGfm from "remark-gfm";

/**
 * AI 回答用的 Markdown 扩展。
 *
 * remark-cjk-friendly：CommonMark 规定 `**` 紧挨标点时，另一侧必须是空格或标点才算加粗，
 * 所以 `讲**“真实”**。` 这种中文里最常见的写法会原样露出星号。这个插件按中日韩文字放宽规则。
 */
export const remarkPlugins = [remarkGfm, remarkCjkFriendly];
