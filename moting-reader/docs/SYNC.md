# 云端同步(R2 + D1)

在本地优先的基础上增加可选的多设备同步。不登录时应用行为与原来完全一致;登录后书籍、进度、划线、统计、设置、AI 对话在各设备间自动合并。

## 存储分工

- **R2 桶 `moting-books`**:大对象、低频——每本书解析后的正文 `books/{bookId}/content.json`(chapters JSON)、插图 `books/{bookId}/images/{imageId}`、封面 `books/{bookId}/images/_cover`。免费 10 GB。
- 封面不进 D1:它是整张图的 data URL,会顶破 D1 单行 2 MB 上限。书籍 meta 推送前去掉 `coverDataUrl`,资料补丁去掉 `original.coverDataUrl`(对端书里已有一份)。
- **D1 库 `moting-sync`**:小记录、高频——书籍元数据(不含正文)、阅读位置、听书进度、划线、阅读时长、设置(含早期阅读统计)、AI 对话、资料补丁。免费 5 GB。
- 听书进度单独一张 `listening` 表,按位置自己的 `updatedAt` 比新旧。它在客户端存在 Book 记录里,跟 meta 一起走会被 meta 的 LWW 连带覆盖(另一台设备改个书名就能把刚听的进度盖掉)。
- 表结构见 `worker/sync-schema.sql`。每张同步表带 `updated_at`(客户端声明的修改时间,LWW 依据)、`server_at`(服务端单调号段,pull 水位);书和划线另有 `deleted_at` 墓碑。`sync_meta` 表存单调时钟号段。
- **客户端本地库**(IndexedDB v5):书目和正文分两张表——`books` 只存书目(含从正文算出来的目录 `chapterOutline`),正文在 `contents`(主键 bookId),打开某本书时才读。本地库没法只读一条记录的一部分,以前两者存在同一条记录里,开机和每轮同步都要把几十本书的全文整个读一遍。书籍 meta 推送前同时去掉 `chapterOutline`(每台设备拿到正文后自己算),接收端合并远端 meta 时保留本地的目录。

## 合并语义(核心:绝不整库覆盖)

所有合并都在记录级别进行,逐条比时间,新者胜:

- **书籍/划线**:远端 `updated_at` 更大才覆盖本地;本地独有字段(正文 chapters、阅读位置)永不被 meta 覆盖——位置走独立的 `positions` 表。
- **删除**:走墓碑(`deleted_at`)。设备删除一本书/一条划线时记墓碑,push 后由云端传播到其他设备。`clearLibrary`(清空本地)不写墓碑,只清这台设备。
- **正文完整性**:一本书的 meta 带 `syncReadyAt` 标记,只有正文与插图都上传成功后才置位;其他设备看到它才会下载,避免拿到半本书。
- **首次同步**:手机数据先上传到云端(记录级 upsert),另一台设备首次登录时按 `since=0` 拉取全部并合并。两端同时有数据时取并集,任何一侧都不丢。
- **内置示例书不同步**:每台设备书库为空时各生成一本、编号随机,它和挂在上面的划线/位置/对话只留本机。
- **删书连带清理**:删书只推书的墓碑,它的划线等记录在云端仍是活的。客户端每轮把见到的删书墓碑攒起来,拉完再按书清一遍本地的划线、位置、对话、资料补丁——全新设备首次同步也不会留下孤儿划线。
- **旧设置与早期统计**:同步上线前保存的设置没有修改时间,按 1 处理(能推上去,但任何真实改动都比它新);早期版本的每日阅读时长基数存在 settings 表的 `stats` 键,各设备按天取大合并,幂等。
- **只在真写进本地时通知界面**:本机刚推上去的记录,下一轮 pull 会原样拉回来一遍。阅读记录只在本地没有、或远端那条更晚结束时才写;AI 对话、资料补丁只在更新时才写。`onApplied(kind)` 只为真正写了的类别触发,界面也只重读这几类——以前每轮同步都会因为这些「回声」把整个书库重读一遍,读书时每 5 分钟卡一下。

## 两个水位(不能混用)

客户端 `sync:state` 里有两把不同时钟的尺子:

- `pushedAt`:本机毫秒。上一轮成功同步**开始**的时刻,本地记录修改时间比它新才上传。
- `pullCursor`:服务端 `server_at`。下一轮 pull 从这里接着拉。

历史教训:曾经只有一个 `lastSyncAt`,存的是服务端号段(毫秒×1000),却拿去和本地毫秒时间比,首轮之后所有本地改动都被判为「没改过」,再也传不上去。

`sync:state` 里还有 `schema`(客户端同步数据版本,`lib/sync.ts` 的 `SYNC_SCHEMA`)。**新增同步类别时必须加一**:按旧版本同步过的设备 `pushedAt` 已经越过了那些旧记录的时间,不整体补传一轮就永远传不上去。版本落后时这一轮按 `since=0` 全量推,服务端 LWW 会把没变的挡掉。

## 协议(`worker/sync.ts`)

同源 POST,凭据在 HttpOnly / SameSite=Strict / Secure Cookie 里,与在线找书一致。

- `session`(GET/POST)→ `{ connected, enabled }`;未配资源时 `enabled:false`
- `login` {username,password} → 校验(哈希后比较)→ 30 天会话 Cookie。**滑动续期**:session/push/pull 校验会话时,距上次续期超过一天就把服务端过期时刻和浏览器 Cookie 一起推回 30 天后(Cookie 不续的话浏览器照样 30 天后丢掉它)。30 天内同步过一次就永远不用重新登录。
- `logout` → 清会话
- `push` {books,notes,positions,sessions,settings,chats,patches,listening} → 逐条 LWW,返回 `{ tooLarge, rejected }`:超过 D1 单行上限的、以及单条数据异常的(键不合法、时间戳比服务端快一天以上等)都只跳过这一条并回报,客户端提示用户。只有整体格式不对才 400——一条坏记录不能让之后每一轮同步都失败。
  - 整批在一个 D1 batch(事务)里完成:先占 `server_at` 号段,再每表一条 `INSERT … SELECT FROM json_each(?)` 批量 upsert。免费档每次调用限 50 条 D1 查询,逐条 upsert 会在首轮上传时直接失败。
  - 占号段与写入同事务,并发 pull 要么看到整批、要么一条都看不到,游标不会越过尚未落库的号。
- `pull` {since} → 跨表按 `server_at` 统一分页(每页 300 条 / 8 MB),返回 `{ cursor, hasMore, …各表 }`。客户端循环拉到 `hasMore:false`,拉完才推进 `pullCursor`。
- `book/:id/content` GET/HEAD/POST(R2 正文)、`book/:id/images/:imageId` GET/HEAD/POST(R2 插图,封面固定编号 `_cover`)
- 上传一本书:先 HEAD 问正文在不在——在就说明上次传到一半被打断,只补缺的插图(插图也先 HEAD);传完一本立刻标 `syncReadyAt` 并推 meta,中途被杀掉下次只从没传完的那本接着来。插图上传/下载都是 4 路并发。

## 双部署与旧域名迁移

Worker 绑定必须同账户,故同步后端整体部署在持有 R2/D1 的账户(下称“主部署”)。旧域名账户没有 R2/D1,但手机端现有数据都在旧域名的 IndexedDB 里。迁移路径:

- **主部署**(新域名):完整应用 + R2/D1 bindings + 同步服务端。
- **旧域名部署**:同一套代码,构建后由 `scripts/legacy-config.mjs` 去掉 R2/D1 bindings、加 `SYNC_UPSTREAM` 变量。运行时 `worker/index.ts` 见到 `SYNC_UPSTREAM` 就把 `/api/sync/*` 反向代理(`forwardSync`)到主部署。客户端始终同源,旧域名上的手机登录即上传全部数据。
- 手机流程:旧域名登录 → 数据上传主部署 → 改用新域名(重新添加到主屏幕)→ 登录 → 全部拉回。

## 验证

- `node --experimental-strip-types --test tests/sync.test.ts`:协议与合并逻辑(内存 store)。
- `python tests/sync-browser.py http://localhost:5173`:三台设备经本地 miniflare 真 D1/R2 同步,覆盖 651 条划线跨批跨页、封面、第二轮增删、旧版本升级补传(设置/统计/听书进度)、续传不重发正文、删书后全新设备无孤儿划线、示例书不外传。
- **线上有真实数据之后,不要再往生产推探针数据**(哪怕测完就删):设备可能在删之前就把它拉走,而删服务器上的行不会传播到设备。生产只做不写入的验证——只推会被拒收的坏记录、HEAD 一个不存在的对象、读 pull;非写不可的,只写设备一定会忽略的记录(比如挂在不存在的书上的听书进度),再按主键精确删。

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
- 旧域名反代的超时(330 秒)必须比客户端最长等待(正文上传 300 秒)宽,否则慢网上传大书会被中间这一层先掐断。
- 单本正文上限沿用 `MAX_BOOK_FILE_BYTES`(50 MB);超出的书 `runSync` 会跳过并计入 `failedContent`,提示用户。
