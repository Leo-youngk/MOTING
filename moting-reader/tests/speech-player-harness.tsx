// Loopback browser regression fixture. Never imported by the application.
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { useSpeechPlayer } from "../hooks/use-speech-player";
import { createBook, createChapter, positionFor } from "../lib/content";
import { DEFAULT_SETTINGS, type BookPosition } from "../lib/types";

const text = await (await fetch("/__realbook.txt")).text();
const sections = text.split(/^第[一二三四五六七八九十]+則[^\n]*\n/m).slice(1, 4);
if (sections.length !== 3) throw new Error("Expected the first three chapters of Gutenberg #25328, 豆棚閒話");
const book = createBook({ title: "豆棚閒話", format: "txt", chapters: sections.map((text, index) => createChapter(`第${index + 1}則`, [{ text }], index)!) });
const history: BookPosition[] = [];
function Harness() {
  const player = useSpeechPlayer({ getBook: (id) => id === book.id ? book : undefined,
    settings: DEFAULT_SETTINGS, onProgress: (_id, position) => history.push(position) });
  useEffect(() => {
    Object.assign(window, { speechHarness: { player, book, history,
      from: positionFor(book, 0, book.chapters[0].sentenceCount - 1) } });
  }, [player]);
  return <button id="delayed-start" onClick={() => {
    player.preparePlayback();
    setTimeout(() => player.start(book.id, positionFor(book, 0, book.chapters[0].sentenceCount - 1)), 100);
  }}>读取正文后播放</button>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
