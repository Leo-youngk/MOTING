# 云端同步(R2 + D1)

在本地优先的基础上增加可选的多设备同步。不登录时应用行为与原来完全一致;登录后书籍、进度、划线、统计、设置、AI 对话在各设备间自动合并。

## 存储分工

- **R2 桶 `moting-books`**:大对象、低频——每本书解析后的正文 `books/{bookId}/content.json`(chapters JSON)、插图 `books/{bookId}/images/{imageId}`、封面 `books/{bookId}/images/_cover`。免费 10 GB。
- 封面不进 D1:它是整张图的 data URL,会顶破 D1 单行 2 MB 上限。书籍 meta 推送前去掉 `coverDataUrl`,资料补丁去掉 `original.coverDataUrl`(对端书里已有一份)。
- **D1 库 `moting-sync`**:小记录、高频——书籍元数据(不含正文)、阅读位置、划线、阅读时长、设置、AI 对话、资料补丁。免费 5 GB。
- 表结构见 `worker/sync-schema.sql`。每张同步表带 `updated_at`(客户端声明的修改时间,LWW 依据)、`server_at`(服务端单调号段,pull 水位);书和划线另有 `deleted_at` 墓碑。`sync_meta` 表存单调时钟号段。

## 合并语义(核心:绝不整库覆盖)

所有合并都在记录级别进行,逐条比时间,新者胜:

- **书籍/划线**:远端 `updated_at` 更大才覆盖本地;本地独有字段(正文 chapters、阅读位置)永不被 meta 覆盖——位置走独立的 `positions` 表。
- **删除**:走墓碑(`deleted_at`)。设备删除一本书/一条划线时记墓碑,push 后由云端传播到其他设备。`clearLibrary`(清空本地)不写墓碑,只清这台设备。
- **正文完整性**:一本书的 meta 带 `syncReadyAt` 标记,只有正文与插图都上传成功后才置位;其他设备看到它才会下载,避免拿到半本书。
- **首次同步**:手机数据先上传到云端(记录级 upsert),另一台设备首次登录时按 `since=0` 拉取全部并合并。两端同时有数据时取并集,任何一侧都不丢。
- **内置示例书不同步**:每台设备书库为空时各生成一本、编号随机,它和挂在上面的划线/位置/对话只留本机。

## 两个水位(不能混用)

客户端 `sync:state` 里有两把不同时钟的尺子:

- `pushedAt`:本机毫秒。上一轮成功同步**开始**的时刻,本地记录修改时间比它新才上传。
- `pullCursor`:服务端 `server_at`。下一轮 pull 从这里接着拉。

历史教训:曾经只有一个 `lastSyncAt`,存的是服务端号段(毫秒×1000),却拿去和本地毫秒时间比,首轮之后所有本地改动都被判为「没改过」,再也传不上去。

## 协议(`worker/sync.ts`)

同源 POST,凭据在 HttpOnly / SameSite=Strict / Secure Cookie 里,与在线找书一致。

- `session`(GET/POST)→ `{ connected, enabled }`;未配资源时 `enabled:false`
- `login` {username,password} → 校验(哈希后比较)→ 30 天会话 Cookie
- `logout` → 清会话
- `push` {books,notes,positions,sessions,settings,chats,patches} → 逐条 LWW,返回 `{ tooLarge }`(超过 D1 单行上限被跳过的键,客户端提示用户)。
  - 整批在一个 D1 batch(事务)里完成:先占 `server_at` 号段,再每表一条 `INSERT … SELECT FROM json_each(?)` 批量 upsert。免费档每次调用限 50 条 D1 查询,逐条 upsert 会在首轮上传时直接失败。
  - 占号段与写入同事务,并发 pull 要么看到整批、要么一条都看不到,游标不会越过尚未落库的号。
- `pull` {since} → 跨表按 `server_at` 统一分页(每页 300 条 / 8 MB),返回 `{ cursor, hasMore, …各表 }`。客户端循环拉到 `hasMore:false`,拉完才推进 `pullCursor`。
- `book/:id/content` GET/POST(R2 正文)、`book/:id/images/:imageId` GET/POST(R2 插图)

## 双部署与旧域名迁移

Worker 绑定必须同账户,故同步后端整体部署在持有 R2/D1 的账户(下称“主部署”)。旧域名账户没有 R2/D1,但手机端现有数据都在旧域名的 IndexedDB 里。迁移路径:

- **主部署**(新域名):完整应用 + R2/D1 bindings + 同步服务端。
- **旧域名部署**:同一套代码,构建后由 `scripts/legacy-config.mjs` 去掉 R2/D1 bindings、加 `SYNC_UPSTREAM` 变量。运行时 `worker/index.ts` 见到 `SYNC_UPSTREAM` 就把 `/api/sync/*` 反向代理(`forwardSync`)到主部署。客户端始终同源,旧域名上的手机登录即上传全部数据。
- 手机流程:旧域名登录 → 数据上传主部署 → 改用新域名(重新添加到主屏幕)→ 登录 → 全部拉回。

## 验证

- `node --experimental-strip-types --test tests/sync.test.ts`:协议与合并逻辑(内存 store)。
- `python tests/sync-browser.py http://localhost:5173`:两台设备经本地 miniflare 真 D1/R2 双向同步,覆盖 651 条划线跨批跨页、封面、第二轮增删、示例书不外传。

## 凭据与部署

- 单用户固定账号:`wrangler secret put SYNC_USERNAME` / `SYNC_PASSWORD`(仅主部署需要)。
- 主部署:`npm run deploy`(需 `CLOUDFLARE_ACCOUNT_ID` 为 R2/D1 所在账户,凭据在 `.env.main.local`)。另需 `WEREAD_API_KEY` 密钥,否则书城 503。
- 旧域名:`npm run deploy:legacy`(需 `CLOUDFLARE_ACCOUNT_ID` 为旧账户,凭据在 `.env`)。
- D1 初始化:`npx wrangler d1 execute moting-sync --file worker/sync-schema.sql --remote`。
- 部署用的 API Token 需要 `Workers Scripts: Edit`、`D1:Edit`、`Workers R2 Storage:Edit` 权限;`wrangler` 会用会话环境变量里的 token,注意别让 shell 里残留的旧账户 token 覆盖。

## 已知边界

- 时钟偏差:客户端 `updated_at` 用本机时间,LWW 允许 1 天偏差;系统时钟严重不准的设备可能被判为“更旧”。个人设备可接受。
- `aiApiKey` 随设置同步,以明文存 D1(按用户要求)。
- R2 对象删除后不清理(个人用量远低于 10 GB;墓碑永久保留,体积极小)。
- 部署在 Workers 免费档:D1 每次调用最多 50 条查询。新增接口前先数一下单次请求的查询条数。
- 单本正文上限沿用 `MAX_BOOK_FILE_BYTES`(50 MB);超出的书 `runSync` 会跳过并计入 `failedContent`,提示用户。
