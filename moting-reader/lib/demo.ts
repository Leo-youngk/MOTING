import { chaptersFromPlainText, createBook, positionFor } from "./content";
import type { Book } from "./types";

const DEMO_TEXT = `
# 第一章 为什么要把阅读和听书放在一起

阅读要求我们停下来，把注意力放在文字上。听书则可以进入通勤、散步和整理房间的时间。它们不是互相替代，而是在不同情境中延续同一本书。

一个好用的阅读器，不应该让你重新寻找上次的位置。它要记住你在哪里读过，也记住你在哪里听过。当两个位置不同时，决定权仍然留给你。

这本示例书用于帮助你认识墨听。你可以点击任意一句，然后选择“从这里听”，也可以直接进入底部的听书页面。

# 第二章 让工具退到阅读之后

阅读软件最容易犯的错误，是把功能放在内容之前。统计、推荐和人工智能都可以存在，但它们不应该抢走正文的中心位置。

真正决定体验的，是导入之后的文字是否干净，句子是否自然，重新打开之后能不能准确接上。可靠性本身就是设计。

当你读到值得保留的句子，可以做一个标记。听书时不方便输入，也只需要轻触一次，之后再到笔记页集中处理。

# 第三章 选择与代价

我们每天都在做选择。选择看似自由，却从不轻盈。每一次选择都意味着放弃其他可能性，自由的另一面往往是承担代价。

重要的不是你做了什么选择，而是你清楚地知道，那个选择意味着什么。很多人并非败给选择本身，而是败给选择之后的怀疑与动摇。

选择的质量，取决于拥有的信息、积累的经验，以及对自身边界的认识。我们无法消除不确定性，却可以在不确定中做出更清醒的判断。

当你理解了代价，选择就不再只是负担，而会成为前行的方向。
`;

export function createDemoBook(): Book {
  const chapters = chaptersFromPlainText(DEMO_TEXT, "墨听使用指南");
  const book = createBook({
    title: "墨听使用指南",
    author: "内置示例",
    format: "demo",
    chapters,
  });
  book.accent = "#718091";
  book.readingPosition = positionFor(book, 0, 0);
  book.listeningPosition = positionFor(book, 0, 0);
  return book;
}
