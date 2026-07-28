"use client";

import JSZip from "jszip";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  chaptersFromPlainText,
  createBook,
  createChapter,
  normalizeWhitespace,
} from "./content";
import type {
  Book,
  BookFormat,
  Chapter,
  ImportProgress,
} from "./types";

type ProgressCallback = (progress: ImportProgress) => void;

const MAX_FILE_SIZE = 80 * 1024 * 1024;

function report(
  callback: ProgressCallback | undefined,
  stage: ImportProgress["stage"],
  label: string,
  percent: number
) {
  callback?.({ stage, label, percent });
}

function fileNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "").trim() || "未命名书籍";
}

function extensionOf(name: string): string {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function normalizeZipPath(value: string): string {
  const output: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

function resolveZipPath(baseFile: string, relative: string): string {
  const decoded = (() => {
    try {
      return decodeURIComponent(relative);
    } catch {
      return relative;
    }
  })();
  const base = baseFile.includes("/")
    ? baseFile.slice(0, baseFile.lastIndexOf("/") + 1)
    : "";
  return normalizeZipPath(`${base}${decoded}`);
}

function xmlText(document: Document, localName: string): string {
  const nodes = document.getElementsByTagNameNS("*", localName);
  return normalizeWhitespace(nodes[0]?.textContent ?? "");
}

function parseDocument(raw: string, type: DOMParserSupportedType): Document {
  return new DOMParser().parseFromString(raw, type);
}

function extractTextBlocks(raw: string): {
  title: string;
  paragraphs: string[];
} {
  const document = parseDocument(raw, "text/html");
  document
    .querySelectorAll(
      "script,style,noscript,nav,svg,canvas,form,button,input,select"
    )
    .forEach((node) => node.remove());

  const heading = document.querySelector("h1,h2,h3,title");
  const title = normalizeWhitespace(heading?.textContent ?? "");
  const candidates = Array.from(
    document.querySelectorAll("p,blockquote,li,h1,h2,h3,h4")
  );
  const paragraphs = candidates
    .map((node) => normalizeWhitespace(node.textContent ?? ""))
    .filter((text, index, all) => {
      if (!text || text.length < 2) return false;
      if (/^\d{1,4}$/.test(text)) return false;
      return index === 0 || text !== all[index - 1];
    });

  if (!paragraphs.length) {
    const fallback = normalizeWhitespace(document.body?.textContent ?? "");
    if (fallback) paragraphs.push(fallback);
  }

  return { title, paragraphs };
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取书籍封面"));
    reader.readAsDataURL(blob);
  });
}

async function parseEpub(
  file: File,
  onProgress?: ProgressCallback
): Promise<Book> {
  report(onProgress, "metadata", "正在读取 EPUB 结构", 12);
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const container = zip.file("META-INF/container.xml");
  if (!container) throw new Error("EPUB 缺少目录结构");

  const containerXml = parseDocument(
    await container.async("text"),
    "application/xml"
  );
  const rootFile = containerXml.getElementsByTagNameNS("*", "rootfile")[0];
  const opfPath = rootFile?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB 无法定位内容清单");

  const opfEntry = zip.file(normalizeZipPath(opfPath));
  if (!opfEntry) throw new Error("EPUB 内容清单不存在");

  const opf = parseDocument(await opfEntry.async("text"), "application/xml");
  const title = xmlText(opf, "title") || fileNameWithoutExtension(file.name);
  const author = xmlText(opf, "creator") || "未知作者";

  const manifest = new Map<
    string,
    { href: string; mediaType: string; properties: string }
  >();
  Array.from(opf.getElementsByTagNameNS("*", "item")).forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) return;
    manifest.set(id, {
      href,
      mediaType: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? "",
    });
  });

  let coverDataUrl: string | undefined;
  let coverItem = Array.from(manifest.values()).find((item) =>
    item.properties.split(/\s+/).includes("cover-image")
  );
  if (!coverItem) {
    const coverMeta = Array.from(
      opf.getElementsByTagNameNS("*", "meta")
    ).find((meta) => meta.getAttribute("name") === "cover");
    const coverId = coverMeta?.getAttribute("content");
    if (coverId) coverItem = manifest.get(coverId);
  }
  if (coverItem) {
    const coverPath = resolveZipPath(opfPath, coverItem.href);
    const coverFile = zip.file(coverPath);
    if (coverFile) {
      const blob = await coverFile.async("blob");
      coverDataUrl = await blobToDataUrl(
        new Blob([blob], { type: coverItem.mediaType || blob.type })
      );
    }
  }

  report(onProgress, "content", "正在整理章节与正文", 28);
  const spineIds = Array.from(
    opf.getElementsByTagNameNS("*", "itemref")
  )
    .map((item) => item.getAttribute("idref"))
    .filter((id): id is string => Boolean(id));

  const chapters: Chapter[] = [];
  for (let index = 0; index < spineIds.length; index++) {
    const item = manifest.get(spineIds[index]);
    if (!item) continue;
    if (
      item.properties.includes("nav") ||
      /nav|toc/i.test(item.href) ||
      (!item.mediaType.includes("html") &&
        !item.mediaType.includes("xhtml") &&
        !/\.x?html?$/i.test(item.href))
    ) {
      continue;
    }

    const itemPath = resolveZipPath(opfPath, item.href);
    const entry = zip.file(itemPath);
    if (!entry) continue;
    const extracted = extractTextBlocks(await entry.async("text"));
    const chapter = createChapter(
      extracted.title || `第 ${chapters.length + 1} 章`,
      extracted.paragraphs,
      chapters.length
    );
    if (chapter && chapter.characterCount > 8) chapters.push(chapter);

    report(
      onProgress,
      "content",
      `正在整理第 ${Math.min(index + 1, spineIds.length)} 章`,
      28 + Math.round(((index + 1) / Math.max(spineIds.length, 1)) * 58)
    );
  }

  if (!chapters.length) throw new Error("EPUB 中没有识别到可阅读正文");

  return createBook({
    title,
    author,
    format: "epub",
    chapters,
    fileName: file.name,
    coverDataUrl,
  });
}

function mergePdfPageLines(items: unknown[]): string[] {
  const lines: string[] = [];
  let current = "";
  for (const raw of items) {
    const item = raw as { str?: string; hasEOL?: boolean };
    const value = normalizeWhitespace(item.str ?? "");
    if (value) {
      const needsSpace =
        current &&
        /[A-Za-z0-9)]$/.test(current) &&
        /^[A-Za-z0-9(]/.test(value);
      current += `${needsSpace ? " " : ""}${value}`;
    }
    if (item.hasEOL && current) {
      lines.push(normalizeWhitespace(current));
      current = "";
    }
  }
  if (current) lines.push(normalizeWhitespace(current));
  return lines.filter(Boolean);
}

async function parsePdf(
  file: File,
  onProgress?: ProgressCallback
): Promise<Book> {
  report(onProgress, "metadata", "正在读取 PDF 页面", 10);
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const document = await pdfjs
    .getDocument({ data: new Uint8Array(await file.arrayBuffer()) })
    .promise;

  const metadata = await document.getMetadata().catch(() => null);
  const info = (metadata?.info ?? {}) as { Title?: string; Author?: string };
  const pageLines: string[][] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    pageLines.push(mergePdfPageLines(content.items));
    report(
      onProgress,
      "content",
      `正在提取第 ${pageNumber} / ${document.numPages} 页`,
      16 + Math.round((pageNumber / document.numPages) * 68)
    );
  }

  const occurrence = new Map<string, number>();
  for (const lines of pageLines) {
    for (const line of new Set(lines)) {
      if (line.length <= 80) {
        occurrence.set(line, (occurrence.get(line) ?? 0) + 1);
      }
    }
  }
  const repeatedThreshold = Math.max(3, Math.ceil(document.numPages * 0.55));
  const cleanedPages = pageLines.map((lines) =>
    lines.filter((line) => {
      if (/^(?:第\s*)?\d{1,4}(?:\s*页)?$/.test(line)) return false;
      if ((occurrence.get(line) ?? 0) >= repeatedThreshold) return false;
      return true;
    })
  );

  const text = cleanedPages
    .map((lines) => lines.join("\n"))
    .join("\n\n")
    .trim();
  if (text.length < 80) {
    throw new Error("没有提取到正文，这份 PDF 可能是扫描件");
  }

  const title =
    normalizeWhitespace(info.Title ?? "") || fileNameWithoutExtension(file.name);
  const chapters = chaptersFromPlainText(text, "正文");
  if (!chapters.length) throw new Error("PDF 中没有识别到可阅读正文");

  return createBook({
    title,
    author: normalizeWhitespace(info.Author ?? "") || "未知作者",
    format: "pdf",
    chapters,
    fileName: file.name,
  });
}

async function parsePlainText(
  file: File,
  format: Extract<BookFormat, "txt" | "md">,
  onProgress?: ProgressCallback
): Promise<Book> {
  report(onProgress, "content", "正在识别标题与章节", 25);
  const text = (await file.text()).replace(/^\uFEFF/, "");
  if (text.trim().length < 10) throw new Error("文件中没有足够的正文内容");

  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstLine = nonEmptyLines[0] ?? "";
  const markdownTitle = /^#{1,3}\s+/.test(firstLine)
    ? firstLine.replace(/^#{1,3}\s+/, "").trim()
    : "";
  const plainTitle =
    !markdownTitle &&
    firstLine.length > 1 &&
    firstLine.length <= 60 &&
    !/^第[〇零一二三四五六七八九十百千万两0-9]+[章节卷部篇回]/.test(
      firstLine
    )
      ? firstLine
      : "";
  const title =
    markdownTitle || plainTitle || fileNameWithoutExtension(file.name);
  const bodyText =
    markdownTitle || plainTitle
      ? text.replace(/^\s*[^\r\n]+\r?\n?/, "").trim()
      : text;
  const chapters = chaptersFromPlainText(bodyText, "正文");
  report(onProgress, "content", "正文整理完成", 86);

  return createBook({
    title,
    author: "未知作者",
    format,
    chapters,
    fileName: file.name,
  });
}

export async function parseBookFile(
  file: File,
  onProgress?: ProgressCallback
): Promise<Book> {
  if (file.size > MAX_FILE_SIZE) {
    throw new Error("文件超过 80 MB，请先压缩或拆分后再导入");
  }

  const extension = extensionOf(file.name);
  report(onProgress, "reading", "正在读取文件", 4);

  if (extension === "epub") return parseEpub(file, onProgress);
  if (extension === "pdf") return parsePdf(file, onProgress);
  if (extension === "txt")
    return parsePlainText(file, "txt", onProgress);
  if (extension === "md" || extension === "markdown")
    return parsePlainText(file, "md", onProgress);

  throw new Error("目前支持 EPUB、文字型 PDF、TXT 和 Markdown");
}
