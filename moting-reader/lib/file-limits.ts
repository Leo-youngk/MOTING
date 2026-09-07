/** 本地优先阅读器的单文件上限。按移动端常用书籍规模控制内存峰值。 */
export const MAX_BOOK_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_BOOK_FILE_LABEL = "20 MB";
export const MAX_BOOK_FILE_ERROR = `文件超过 ${MAX_BOOK_FILE_LABEL}，请先压缩或拆分后再导入`;
