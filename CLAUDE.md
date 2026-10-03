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
| `components/` | UI 组件。底部弹层和滚动锁统一在 `sheet.tsx`（`Modal`），滑杆统一用 `soft-range.tsx`，设置是独立的分级页面 `settings-screen.tsx` |
| `hooks/` | React hooks，TTS 播放器在 `use-speech-player.ts` |
| `lib/` | 核心逻辑，`content.ts` 负责章节/段落/句子解析，`types.ts` 是共享类型 |
| `worker/` | Cloudflare Worker 入口 |
| `tests/` | `*.test.ts`，Node test runner |
| `docs/` | `TASK_PLAN.md`（任务计划）、`TEST_REPORT.md`（测试报告） |

## 内容模型

文本按 `Book → Chapter → Paragraph → Sentence` 逐层拆分。朗读时不直接按句子送 TTS，而是通过 `buildSpeechBlocks()` 把相邻句子合并成 `SpeechBlock`（单块上限 240 字），每块内用 `SpeechSpan` 记录每个句子在合并文本中的 `start`/`end` 偏移，用来把 TTS 的朗读进度映射回具体句子做高亮。

从章节中间开始播放时用 `sliceSpeechBlock()` 裁掉前面的部分，并重算偏移量。

本地库（IndexedDB）里书目和正文分开存：`books` 表只有书目（含从正文算出的目录 `chapterOutline`），正文在 `contents` 表。书库、主页、同步只碰书目；进阅读器、播放器、单书笔记之前才读那一本的正文（`MotingApp` 的 `loadContent`）。

连续阅读（上下滑动）只挂视口附近几章。**滑动中（手在屏上或惯性里）不许改视口上方的 DOM**：iOS Safari 没有 scroll anchoring，惯性期间脚本发的 `scrollBy` 会被丢掉或掐断惯性，补偿一丢正文就整章地跳。所以滑动中只往下接章；往上接章、摘章、把段落从估算占位换成真实排版（`data-primed`）都在停稳 200ms 后由 `planChapterWindow()` 一步步做，每步在同一个任务里改完并补偿。跳转（目录、回到朗读处）当场把目标章和上一章整章排好再滚过去。改这块要跑 `tests/reader-scroll-browser.py`，它模拟了上面两个 iOS 特性。

书名、章名只在显示时处理（`lib/display-title.ts`）：列表和播放条用去掉营销括注的短书名，书籍资料页用全名；章名是「未知 / Unknown」这类占位词的章算上一章的续页，目录里不单列、阅读页不另起章首。

## 界面规范

外壳风格是「云朵软白」：偏冷的云白底、纯白大圆角卡片（`--radius-card`）、铺得很开的淡落影，文字墨蓝，强调色是图标小熊的腮红粉。书架外观三档（软白 / 宣纸 / 墨夜）只换 `html[data-shell]` 上的颜色 token，形状共用一套。

字号、圆角、阴影、时长都用 `app/globals.css` 里 `:root` 的 token（`--text-*` 按 iOS 文字样式分级、`--radius-*`、`--shadow-*`、`--dur-*`），不要再写裸数值。阅读正文和 AI 回答跟着用户选的字号走，不在这套里。外壳界面一律黑体，宋体只留给正文、摘录和封面。

粉色只给能点的东西和「正在进行」的状态。粉色当文字用走 `--accent-deep`；按钮、气泡这类粉底上的字走 `--accent-ink`（墨蓝），实心粉底上的图标走 `--on-accent`，浅粉配白字在手机上看不清。毛玻璃只给浮在内容上面的层（底栏、迷你播放条、阅读器浮层、弹出面板、对话顶栏），页面里的卡片和按钮用实底。

页头左边那只小熊 `public/bear-mark.png` 和桌面图标 `icon-*.png` 都是从用户给的原图裁出来的，要换就从原图重新裁，不要重画；改了 `public/` 里这些文件要顺手把 `sw.js` 的 `CACHE_NAME` 加一。

发版检查在 `hooks/use-app-update.ts`：service worker 在后台存好新版页面后告诉页面，页面拿缓存那一版的 `/assets/` 清单跟自己开机时加载的比，多出文件就在书架几页底部出「新版本已就绪 · 更新」，设置首页也有「检查更新」。点更新就是重新载入，导航由 SW 从缓存给新版。

## AI 对话

- 排版照 Claude app：常驻顶栏；提问是右侧气泡，回答满宽无框；发出的问题滚到顶栏下面停住，回答在它下面长，不跟着滚；回答末尾在屏幕外时输入框上方浮「回到最新」。
- 回答的 Markdown 按块渲染（`lib/markdown-blocks.ts`，只在切开和不切渲染结果一样的地方切），流式时只重新解析最后一块，最后一块先过 `remend` 补齐没写完的加粗、链接；`lib/markdown-plugins.ts` 里的 `remark-cjk-friendly` 让紧挨中文标点的 `**` 也能加粗。
- 发给模型的历史走 `modelHistory`（`lib/ai.ts`）：去掉空回答、合并连着的提问、只带最近 30 条 / 6 万字。Worker 转发的条数字数上限是同一个 `AI_REQUEST_LIMITS`，改一处两边都生效。流里夹的错误、一个字都没给的回答都当失败，显示在那一问下面并给「重试」，不写进对话记录。
- 上游忙（503、429、5xx）时 Worker 自动重试并换备用模型（`worker/ai-upstream.ts`）：主模型 2 次 → 备用模型 2 次 → 主模型最后 1 次，间隔带抖动，总共最多等 30 秒；只在回答开始流出之前重试。备用模型是设置「AI 助手」里的 `aiFallbackModel`，从接口返回的模型列表里选，不在代码里写死；用到它的那条回答下面注明（响应头 `x-ai-model`）。每次重试、换模型、最终失败都写进 Workers 日志。上游的报错（Gemini 兼容接口外面包一层数组）由 Worker 解开并翻成中文。

## 英文模式

- 阅读页「主题与设置」里行距下面的「英文模式」开关（`ReaderSettings.englishMode`），**默认关，关着时阅读器跟没有这个功能时完全一样**。打开后：
  - 英文段落里单击一个词，词上方浮出释义卡（`components/word-gloss.tsx`）。只认英文段落（`isEnglishText`），中文段落、空白、行尾的单击照旧切沉浸；点已有划线、长按、分页模式左右两成翻页区的行为都不变；卡开着时点空白只收卡。
  - 划英文句子「问 AI」时，建议提问换成「翻译成中文 / 拆解句子结构 / 这段在说什么」；当前章节是英文时系统提示里加一句「用中文讲解、拆句先找主干」。
- 词典是本地的，不走 AI：`scripts/build-dictionary.mjs` 从 ECDICT（MIT）裁出常用词，按首字母拆成 `public/dict/<版本>/a.json … z.json`，查词逻辑和变形还原在 `lib/dictionary.ts`。规则还原不对的变形由生成脚本核对后写进 `forms`，所以**改了 `stemCandidates` 要重新生成数据**。数据有变化要把 `DICTIONARY_PATH` 的版本号加一：service worker 对静态文件缓存优先，同一路径永远读旧的。
- 英文句子之间的空格：`splitIntoSentences` 切开英文句子时把原文里的空格留在前一句末尾（句子是挨着排的，丢了就成了「Hi!How」）；拼朗读文本时英文句子之间补空格（`speechSeparator`）。只认英文交界，中文照旧。排版上的修正只对新导入的书生效（已导入的英文书重新导入才改过来），朗读拼接对已导入的书也生效。
- 英文朗读音色还没加：按「新音色先给用户试听」的规矩，等用户选定。
- 改这块跑 `tests/dictionary.test.ts`、`tests/content.test.ts` 和 `tests/word-gloss-browser.py`。
