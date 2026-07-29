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
