# 在线找书

## 范围

在书库切换到「在线找书」，按书名或作者搜索 Z-Library，选择格式与版本后直接下载并自动解析入库。继续使用原有本地阅读、听书与 IndexedDB，不增加云端书库或新部署服务。

目标站点固定为用户提供的 `https://zh.z-lib.gd`。不要求粘贴书籍链接。支持 EPUB、文字型 PDF、TXT、Markdown，单个文件上限 50 MB。同一在线版本通过 `onlineSourceId` 识别；删除后可以重新导入。

## 接口依据

- https://github.com/bipinkrish/Zlibrary-API/blob/main/Zlibrary.py ：EAPI 搜索、书籍文件接口、会话 Cookie 协议。
- https://github.com/ZlibraryKO/zlibrary.koplugin/blob/main/zlibrary/api.lua ：当前网站 `rpc.php` 登录参数和 `response.user_id/user_key`，搜索分页、下载次数限制处理。
- https://github.com/ZlibraryKO/zlibrary.koplugin/blob/main/zlibrary/config.lua ：当前登录与搜索路径。

此处独立实现 TypeScript/Web Fetch 客户端，参考通信协议，没有复制或嵌入 Python/Lua 库源码，也不增加 Python 运行时。

## 实现

- `worker/zlibrary.ts`：同源 POST 接口；服务端转发固定站点，登录密码不持久化，会话通过当前设备 HttpOnly / SameSite=Strict Cookie 保存，HTTPS 部署设置 Secure。上游登录过期清除会话。退出只清除此设备连接。
- `lib/zlibrary.ts`：搜索与文件流下载、取消、超时、下载中断和网页响应检查。
- `components/online-library.tsx`：搜索、格式选择、结果分页、登录、加入书库、重复版本识别。
- `lib/storage.ts`：正文与插图在同一 IndexedDB 事务保存，避免保存失败留下半本书。

所有响应 `no-store`，所有入口采用 POST，避免 PWA Service Worker 缓存账号或下载响应。账号 Cookie 不转发到文件 CDN；下载地址只能由固定站点的书籍接口提供。协议异常、站点拦截和配额不足明确显示错误，没有假结果或自动切换其他书源。

## 验证要求

运行 typecheck、构建及 Node 测试；浏览器按 iPhone 尺寸检查登录、搜索、分页、取消、成功导入、重复识别、错误状态与页面宽度。协议夹具只存在测试文件中。真实端到端验证与夹具测试分开记录，未取得真实登录或下载结果时不声称已跑通。

### 2026-09-07 本地验证结果

- `npm run typecheck` 通过。
- `npm test`：构建与 Cloudflare 产物校验通过，56 项测试通过，其中 13 项覆盖在线书源协议及失败路径。
- 新增 TypeScript/TSX 文件的 ESLint 检查通过；全仓库 `npm run lint` 仍受已有代码及 `.wrangler` 临时文件错误影响，不属于本次修改范围。
- `python tests/online-library-browser.py` 通过：真实 Worker 会话路由 + 明确标注的书源夹具，覆盖密码错误、登录、搜索、分页去重、超大文件、取消下载、连接失败、网页伪装文件、EPUB 实际解析入库、刷新后重复识别、打开正文、空结果、会话过期。
- 375 / 390 / 430 像素手机视口均无横向溢出，无浏览器页面错误；搜索区域高度在空结果与加载完成后保持固定。截图保存在忽略目录 `.wrangler/online-library-tests/`。真机 iOS 手势未验证。
- Wrangler 部署预检通过，构建产物中未发现部署凭据。

部署凭据位于项目根下的 `.env.deploy.local`（Git 忽略），通过 Node `process.loadEnvFile()` 读取后再启动 Wrangler，不把凭据放进命令行。该文件只用于部署，与用户的 Z-Library 登录无关。

### 发布记录与真实联调边界

- 功能提交：`4a4b86e`，已推送 `origin/master`。
- 生产地址：https://moting-reader.yk2958374240.workers.dev
- Cloudflare 发布成功，版本：`7a87c230-deae-42cb-8be7-ba913fcf39cb`。
- 发布后本机访问生产地址时，Python HTTP 请求和 Edge 浏览器均连接超时，尚未收到生产搜索接口的响应。本机对 `workers.dev` 的 DNS 返回 `157.240.17.41`，存在网络解析异常，不能据此判定云端书源接口失效。
- 当前没有用户的 Z-Library 登录会话，真实账号登录与真实书籍下载尚未验证。上面的端到端通过结果指明确标注的测试 EPUB 与书源夹具，不代表真实站点的完整链路已通过。

### 2026-09-23 单文件上限放宽到 50 MB

- 原因：中文书 PDF 普遍 20-40 MB，搜「罗素」时 20 条结果里 12 条被旧上限禁用，只有两三本能实际加入书库。
- 改动：`lib/file-limits.ts` 上限 20 MB → 50 MB；同步 `lib/zlibrary.ts` 大小错误文案引用、测试夹具断言与文档。
- 验证：typecheck 与 132 项测试通过；线上实测搜「罗素」20 条结果全部可点「加入书库」。
- 版本：`4093f63c-184e-4393-8f71-e1328849341d`。格式白名单（epub/pdf/txt/md）按用户决定维持不变，mobi/azw3 仍不出现在结果中。
- 部署坑：本机残留的旧 `CLOUDFLARE_API_TOKEN` 会让 `process.loadEnvFile` 加载失效（不覆盖已有变量），wrangler 因此用错账户报 10000；需在会话里显式覆盖该环境变量后再部署。
