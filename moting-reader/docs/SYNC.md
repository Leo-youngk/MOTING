# 云端同步

单用户跨设备书库：PC、手机和 PWA 登录同一个同步账号后，书籍、划线、阅读/听书位置、阅读统计、AI 对话和资料补全逐条合并。本机仍可离线使用。

## 存储

- R2 `moting-books` 存正文与插图，路径为 `books/{bookId}/content.json`、`books/{bookId}/images/{imageId}`；封面编号为 `_cover`。
- D1 `moting-sync` 存同步记录、删除墓碑与会话。`updated_at` 是设备时间，`server_at` 是服务端单调版本。普通记录沿用时间比较；阅读与听书使用版本确认。
- IndexedDB v6 保留原表，新增 `sync-progress`。旧 v4 正文拆表迁移仍在同一升级事务内完成；失败回滚，不清库。

## 阅读与听书位置：逐条确认

`positions`、`listening` 分开保存。“听读同步”开关保留原语义，打开时把听书位置也记为阅读位置。

1. 每次真实本地操作立即异步写 IndexedDB，位置与待上传条目在同一事务内提交。阅读另有 localStorage 兜底。同步先等待尚未完成的写入。
2. 条目含 `mutationId`、本地序号、`baseServerRev` 和 `pending`。进度不再通过整轮的 `pushedAt` 筛选。
3. 服务端只在已知版本与当前版本一致时接受现代写入，并在同一 D1 batch 事务内读取逐条确认。重复 mutation 幂等。
4. 确认只能清除对应 mutation；上传期间继续读产生的新条目仍待上传，并接续自己刚确认的服务端版本。
5. 并发冲突应用云端权威值，同时保留本机候选。“云端同步”设置中可选择“使用本机位置”或“保留云端位置”。显式选择本机才生成新修改。
6. 接收按服务端版本比较。设备时钟回拨不影响新协议的胜负；显式重读可以向前面的章节移动，不取最大章节/百分比。

旧库只为尚无确认条目的位置做一次对账，保留原修改时间。较新的旧版嵌入位置先收敛到独立位置表；后续应用权威位置会移除书目里的旧副本，防止复活。旧位置仅在云端仍为旧格式且本机时间不早于云端时接管。现代进度拒绝旧客户端覆盖，返回 426，要求更新页面。

单条无效进度保留并提示重新定位；其他书和拉取继续工作。下次有效本地操作替换该条目并重新上传。

## 同步时机

- 冷启动先恢复本机兜底位置，尝试恢复会话并获取进度，再恢复阅读/播放器；网络等待最多 2.5 秒，超时仍可离线打开。
- 打开阅读器/播放器前也做一次最多 2.5 秒的进度检查，随后重读本地位置。
- 位置变化后首次安排约 3 秒的进度同步，持续操作不会重设期限；前台每 8 秒检查云端版本，有变化才拉进度。
- `online`、`pageshow`、回到可见页面时重查会话并同步。会话请求失败显示“恢复连接”，不会误显示为退出登录；网络错误退避重试，最长 30 秒。
- 离开前台、`pagehide`、暂停或停止播放时先落盘、只推位置。后台听书保留周期推送。进度请求按约 45 KB 拆包，使用 `keepalive`。
- 普通记录的变化安排首次 30 秒同步，持续写入不重设；前台另有每分钟兜底。整轮忙时的新请求完成后补跑。
- 阅读器打开时收到另一设备的位置，显示持续的“跳转”提示，不直接挪动正在阅读的正文。

进度和正文分别使用同步锁。大书、封面或插图上传慢，不会占住进度通道。iOS 页面被系统冻结时不能保证计时器或网络继续运行；保证冻结前落盘、未确认条目保留、重新打开/联网后补传。

## 普通记录与资源

- 书目、划线、设置、阅读记录和资料补丁保留记录级时间比较；正文不会被书目覆盖。AI 对话按稳定轮次 ID 合并并集。
- 删除使用墓碑；拉完全部页后清理被删书的本地关联数据。清空本机书库不传播删除。示例书及其关联数据只留本机。
- `syncReadyAt` 表示正文已上传，其他设备收到后才下载；封面/插图失败独立重试，404 视为源端缺图。
- 整轮先推普通记录、拉增量并持久化进度/游标/资源任务，再传正文和图片。`pendingDownloads` 保留缺失书的下载任务，跨页面重启继续重试。
- 资源尚未完成显示待重试数量，不报告“全部完成”；正文超上限/无效另行提示。

`sync:state` 的 `pushedAt` 只服务普通记录；`pullCursor` 是完整拉取游标，`progressCursor` 是快通道游标，提交时取当前最大值并保留同步期间新增的墓碑。`lastProgressAt` 记录成功检查进度的时刻。`SYNC_SCHEMA=4`，旧版普通记录进行一次全量补传。

## API

同源请求使用 HttpOnly / SameSite=Strict / Secure 会话 Cookie。

- `session` GET/POST：`{ connected, enabled, protocol, build, backend }`。
- `login`：校验固定同步账号，签发 30 天会话；成功会话检查按日滑动续期。`logout` 清会话。
- `version` GET：经鉴权返回全局服务端版本、协议和构建标识，供轻量检查。
- `push`：普通记录逐条合并；现代进度带 `mutationId`、`baseServerRev`、`bootstrap`，返回 `receipts`、`rejected` 和 `tooLarge`。现代进度要求完整合法的位置，不依赖设备和服务器时间一致。
- `pull`：`{ since, progressOnly? }`。跨表按服务端版本分页，每页最多 300 条/8 MB；`progressOnly:true` 仅取阅读/听书。每条带 `serverAt`，现代进度另带 `mutationId`。
- `book/:id/content` 和 `book/:id/images/:imageId` GET/HEAD/POST：上传先 HEAD 检查已有对象，完成后推送 ready 标记。

D1 占号段、批量 upsert 和确认读取在同一事务完成。下一批最小版本严格大于上一批上界，空拉取游标不会跳过未来写入；每页固定已提交上界后扫描全部表。

## 双部署与升级

- 主站 `https://moting-reader.if5v.workers.dev`：完整应用、D1、R2 和音频 Queue。
- 旧站 `https://moting-reader.yk2958374240.workers.dev`：同一构建前端；`scripts/legacy-config.mjs` 去掉 D1/R2/Queue，设置 `SYNC_UPSTREAM`，同源代理 `/api/sync/*` 到主站。
- 两个入口都要部署。只更新后端不能更新旧入口的客户端。
- 两个入口的浏览器存储隔离。旧站完成同步后，可在主站登录拉回书库；升级不要清除原站点数据。

凭据仅从忽略的配置读入子进程环境：主账户 `.env.main.local`，旧账户 `.env`。固定账号由平台 `SYNC_USERNAME`、`SYNC_PASSWORD` 提供，书城还需 `WEREAD_API_KEY`。

新 D1 先执行 `worker/sync-schema.sql`，再应用迁移；已有数据库只运行增量迁移。先导出私有备份：

```sh
npx wrangler d1 export moting-sync --remote --output /private/path/moting-sync-backup.sql
npx wrangler d1 migrations apply moting-sync --remote --config wrangler.jsonc
npm run deploy
npm run deploy:legacy
```

迁移 `0001_progress_confirmation.sql` 只为两张位置表增加 nullable `mutation_id`，保留历史记录。Token 需要对应账户的 Workers、D1、R2 权限。旧域名代理超时 330 秒，大于正文上传最长 300 秒。

## 验证

- `npm test`：生产构建、全部单测。HLS 测试依赖本机 `ffmpeg`，不调用生产 TTS。
- `npm run typecheck` 与修改文件的 ESLint。
- `python tests/sync-browser.py http://127.0.0.1:5183`：本地 D1/R2 三设备回归，含 651 条划线跨批跨页、升级、删除、正文续传与图片恢复。
- `python tests/sync-progress-browser.py http://127.0.0.1:5183`：确认队列、旧确认、时钟回拨、并发冲突、离线重开、旧客户端保护、异常条目和资源阻塞。
- `python tests/sync-regressions-browser.py http://127.0.0.1:5183`：真实连续阅读、迟到落盘与联网恢复。
- `python tests/sync-boot-browser.py http://127.0.0.1:5183`：启动会话暂时失败后的自动恢复。
- `python tests/sync-timing-browser.py http://127.0.0.1:5183`：后台仅推、回前台拉取、远端跳转与阅读锚点。
- `python tests/storage-migration-browser.py http://127.0.0.1:5183`：v4 到 v6，保留正文、划线、设置和位置。

开发服务用 `MOTING_DEV_STATE` 指向临时目录，先初始化本地 schema 并应用迁移。旧升级回归需要全新本地 D1 状态，避免之前测试的新设置影响历史设置场景。只写隔离测试服务；生产仅检查部署、资源、协议和结构，不推探针书或位置。

## 边界

- 普通记录仍使用设备时间；本次取消时钟依赖的范围是阅读/听书。
- 按现有约定，`aiApiKey` 随设置存入 D1。
- R2 删除对象暂不物理清理，墓碑持续保留。
- Workers 免费档单次 D1 查询数上限 50，批量协议避免逐条 SQL。
- 单本正文沿用 50 MB 上限。
# 大记录与失败恢复（协议 5）

- 256 KiB 以内的普通记录保留在 D1；更大的书目、笔记、会话、设置、聊天和资料补丁正文存入现有 R2。单条正文上限 32 MiB，按实际 UTF-8 字节计算。
- 对象路径为 `sync-records/v1/{kind}/{key}/{sha256}.json`。D1 的原内容列保存 `@moting-sync-r2-v1:` 前缀加 `{hash,bytes}`；合法 JSON 无法伪装成这个前缀。不新增或重建生产表。
- 客户端先 HEAD / POST 正文，再 push 引用。服务器验证正文已存在后，才在 D1 事务中写引用并返回逐条确认。R2/D1 没有共同事务；中断只留下可复用的不可变对象，不会把缺少正文的引用标记为成功。
- 原有内联 push 自动转存 R2，原有 pull 返回展开的 JSON；新客户端通过 `recordBlobs:true` 获取引用并单独下载、校验长度和 SHA-256。拉取分页同时限制展开体积，下载失败时不推进游标。
- 普通记录确认 `recordReceipts` 包含 kind、key、上传的 updatedAt、accepted/stale 和 serverAt；查询与 upsert 在同一 D1 事务内。进度仍使用原有 mutation 确认与独立通道。
- `issues` 区分格式异常、大小上限和存储暂时不可用，包含类型、键、大小、原因和能否自动重试，日志只写这些信息。
- 本地 `pushFailures` 持久化记录版本、指纹及重试时间。未修改的永久异常暂停自动上传；修改、手动重试或协议升级后重新尝试。临时错误从 30 秒逐步退避至 15 分钟，进度通道继续工作。正文永久拒收任务保存到 `blockedContent`，不丢任务或误报全部完成，可手动重新尝试。
- 已确认普通记录先保存上传水位，避免资源下载中断后再次发送大正文；同步期间产生的新版本仍待传。设置页显示具体失败记录与上次全部同步时间，部分完成不显示全部完成。
- 对象按哈希保留版本，当前没有后台删除历史对象的操作。聊天仍使用完整快照和既有分支合并；逐条聊天增量是后续优化。回退 Worker 时应使用支持这些引用的版本，旧客户端本身可继续使用。
