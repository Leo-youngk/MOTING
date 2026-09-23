# 墨听阅读器 (Moting Reader)

中文阅读器，核心特性是 TTS 朗读 + 阅读位置同步高亮。

仓库根目录是 `E:\墨听APP`，应用代码全部在 `moting-reader/` 子目录下。所有 npm 命令都要在 `moting-reader/` 里执行，不是仓库根目录。

## 技术栈

Next.js 16 + React 19，但**构建工具是 Vite + vinext，不是 Next 自带的 CLI**。部署目标是 Cloudflare Workers。

- Node >= 22.13.0
- Tailwind CSS 4
- `pdfjs-dist` / `jszip` 用于 PDF、EPUB 导入
- `@cloudflare/vite-plugin` + `wrangler` 负责 Workers 构建与发布

## 常用命令

在 `moting-reader/` 下运行：

```bash
npm run dev
```

启动开发服务器，走的是 `vite`——**不要用 `next dev`**，会失败。

```bash
npm run typecheck
```

```bash
npm test
```

注意 `npm test` 会**先跑一次完整 build 再执行测试**，所以比较慢。测试用的是 Node 内置 test runner 加 `--experimental-strip-types`，直接跑 TypeScript，没有 Jest/Vitest。

```bash
npm run deploy:dry-run
```

发布前验证。`npm run build` 结束后会执行 `scripts/validate-cloudflare-artifact.mjs` 校验产物，这一步失败说明产物不符合 Workers 要求。

## 目录

| 路径 | 用途 |
|---|---|
| `app/` | 路由与页面 |
| `components/` | UI 组件 |
| `hooks/` | React hooks，TTS 播放器在 `use-speech-player.ts` |
| `lib/` | 核心逻辑，`content.ts` 负责章节/段落/句子解析，`types.ts` 是共享类型 |
| `worker/` | Cloudflare Worker 入口 |
| `tests/` | `*.test.ts`，Node test runner |
| `docs/` | `TASK_PLAN.md`（任务计划）、`TEST_REPORT.md`（测试报告） |

## 内容模型

文本按 `Book → Chapter → Paragraph → Sentence` 逐层拆分。朗读时不直接按句子送 TTS，而是通过 `buildSpeechBlocks()` 把相邻句子合并成 `SpeechBlock`（单块上限 240 字），每块内用 `SpeechSpan` 记录每个句子在合并文本中的 `start`/`end` 偏移，用来把 TTS 的朗读进度映射回具体句子做高亮。

从章节中间开始播放时用 `sliceSpeechBlock()` 裁掉前面的部分，并重算偏移量。

本地库（IndexedDB）里书目和正文分开存：`books` 表只有书目（含从正文算出的目录 `chapterOutline`），正文在 `contents` 表。书库、主页、同步只碰书目；进阅读器、播放器、单书笔记之前才读那一本的正文（`MotingApp` 的 `loadContent`）。

书名、章名只在显示时处理（`lib/display-title.ts`）：列表和播放条用去掉营销括注的短书名，书籍资料页用全名；章名是「未知 / Unknown」这类占位词的章算上一章的续页，目录里不单列、阅读页不另起章首。

## 界面规范

字号、圆角、阴影、时长都用 `app/globals.css` 里 `:root` 的 token（`--text-*` 按 iOS 文字样式分级、`--radius-*`、`--shadow-*`、`--dur-*`），不要再写裸数值。阅读正文和 AI 回答跟着用户选的字号走，不在这套里。外壳界面一律黑体，宋体只留给正文、摘录和封面；橙色只给能点的东西和「正在进行」的状态。毛玻璃只给浮在内容上面的层（底栏、迷你播放条、阅读器浮层、弹出面板、对话顶栏），页面里的卡片和按钮用实底。

## AI 对话

- 排版照 Claude app：常驻顶栏；提问是右侧气泡，回答满宽无框；发出的问题滚到顶栏下面停住，回答在它下面长，不跟着滚；回答末尾在屏幕外时输入框上方浮「回到最新」。
- 回答的 Markdown 按块渲染（`lib/markdown-blocks.ts`，只在切开和不切渲染结果一样的地方切），流式时只重新解析最后一块，最后一块先过 `remend` 补齐没写完的加粗、链接；`lib/markdown-plugins.ts` 里的 `remark-cjk-friendly` 让紧挨中文标点的 `**` 也能加粗。
- 发给模型的历史走 `modelHistory`（`lib/ai.ts`）：去掉空回答、合并连着的提问、只带最近 30 条 / 6 万字。Worker 转发的条数字数上限是同一个 `AI_REQUEST_LIMITS`，改一处两边都生效。流里夹的错误、一个字都没给的回答都当失败，显示在那一问下面并给「重试」，不写进对话记录。
