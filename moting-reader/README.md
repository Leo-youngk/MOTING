# 墨听阅读器

墨听是一款本地优先的 PWA 阅读器。导入电子书后，既可以阅读，也可以在独立的“听书”页选择书籍并连续朗读。

本项目不需要账号或 API Key。书籍、进度、标记和设置默认保存在当前浏览器的 IndexedDB 中，不会主动上传原始文件。

## 已实现功能

- 导入 EPUB、文字型 PDF、TXT 和 Markdown，单个文件上限 80 MB。
- 书架搜索、排序、进度展示、继续阅读和删除。
- 独立听书页：继续上次收听、筛选最近收听、从书单直接开播。
- 阅读页：目录、章节切换、句子定位、字号、行距、版心、字体和主题。
- 播放器：播放/暂停、前后句、上下章、倍速、系统语音、睡眠定时和当前文字。
- 阅读进度与听书进度分开保存。
- 阅读书签与听书标记汇总，并可回到原句。
- PWA 安装信息和离线应用外壳。
- 无书籍时自动加入一册可删除的演示书。

## 本地运行

环境要求：

- Node.js 22.13 或更高版本。
- 推荐 Linux、macOS 或 Windows WSL。

安装并启动：

```bash
npm install
npm run dev
```

终端会显示本地地址，使用浏览器打开即可。首次进入时会看到《墨听使用指南》演示书。

生产检查：

```bash
npm run typecheck
npm run lint
npm test
npm run deploy:dry-run
```

`npm test` 会执行生产构建、核心文本与进度单元测试、PWA 配置检查，以及渲染入口检查。
`npm run deploy:dry-run` 只检查 Cloudflare 上传包，不会更改线上 Worker。

## 部署到 Cloudflare

项目使用 Cloudflare Workers + Static Assets，不需要 D1、R2、Supabase 或应用 API Key。

### Windows 一键部署

1. 安装 Node.js 22.13 或更高版本。
2. 双击项目根目录的 `deploy-cloudflare.cmd`。
3. 按提示输入 Cloudflare Account ID。
4. 输入拥有 `Workers Scripts: Edit` 权限的 API Token；输入内容不会显示。
5. 等待构建、测试和上传完成，保存终端最后显示的 `workers.dev` 地址。

脚本会在部署结束后清除当前进程中的 Cloudflare 凭据。不要把 Token 写进源码、
截图或聊天记录。

### 使用 Cloudflare OAuth

也可以打开终端并执行：

```bash
npm ci
npx wrangler login
npm run deploy
```

后续更新只需执行：

```bash
npm run deploy
```

注意：

- `wrangler.jsonc` 中的 Worker 名称是 `moting-reader`。若账户中已有同名
  Worker，部署会更新它；名称不同才会新建项目。
- 书籍、进度、标记和设置仍保存在每台设备、每个浏览器的 IndexedDB 中。
- 不同网址使用独立存储；本地预览中导入的书不会自动迁移到 `workers.dev`。
- 更换网址也会产生新的浏览器存储空间，正式使用后不要随意更换域名。

## 导入说明

| 格式 | 支持情况 | 注意事项 |
| --- | --- | --- |
| EPUB | 提取书名、作者、封面、章节和正文 | DRM 保护文件无法导入 |
| PDF | 提取可选择的文字层，并清理常见页码/重复页眉 | 扫描图片 PDF 暂不含 OCR |
| TXT | 识别首行书名与“第 X 章”式标题 | 无章节时自动按长度整理 |
| Markdown | 识别 Markdown 标题和正文 | 复杂嵌入内容会转为纯文本 |

项目内的 `examples/墨听示例书.txt` 可用于快速测试导入。

## 听书说明

墨听使用浏览器的 Web Speech API 调用设备系统语音，因此：

- 无需配置密钥，也不会将正文提交给本项目自己的服务器。
- 可选声音取决于操作系统和浏览器；中文系统语音通常体验更好。
- 语音、倍速改变会从下一句开始稳定生效。
- 移动系统可能在锁屏、切到后台或省电模式下暂停网页朗读。
- iPhone/iPad 建议“添加到主屏幕”后使用，并在真实设备上确认目标系统版本的后台行为。

本版没有集成云端高质量 TTS。若以后接入，应放在服务端代理，并由部署环境保管密钥，不能把密钥写进前端代码。

## 数据与隐私

- 数据只保存在使用该应用的浏览器配置中。
- 清除站点数据、无痕窗口关闭或浏览器卸载都可能丢失书库。
- “我的”页可清空全部本地数据；此操作不可撤销。
- 本版不含跨设备同步与书库导出，重要原始电子书请自行保留。

## PWA 安装

- Chrome / Edge：使用地址栏或浏览器菜单中的“安装应用”。
- iPhone / iPad Safari：点“分享” → “添加到主屏幕”。
- 离线外壳需先在线完整打开应用一次；已导入的书籍正文来自本地存储。

## 目录

```text
app/                 页面入口与全局样式
components/          书架、听书、阅读器、播放器等界面
hooks/               系统语音播放控制
lib/                 数据模型、解析、内容处理和 IndexedDB
public/              PWA manifest、图标与 service worker
tests/               自动化测试
docs/TASK_PLAN.md     完整任务规划与验收标准
docs/TEST_REPORT.md   实际测试记录与已知限制
examples/             可导入示例文本
```

## 技术边界

- 页面框架：React 19 + Next.js/Vinext + TypeScript。
- 本地存储：IndexedDB。
- EPUB：JSZip。
- PDF：PDF.js。
- 听书：SpeechSynthesis。
- 图标：Lucide React。

详细设计范围见 `docs/TASK_PLAN.md`，交付前验证结果见 `docs/TEST_REPORT.md`。
