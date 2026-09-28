# 正式听书链路（PR 14）

前台打开听书页时，播放器把当前句起的最多 12 万字提交给已登录的
`/api/sync/live/session`。Queue 在独立于网页和播放连接的调用中先生成约
90 秒 packed MP3，达到 75 秒后前端把一个原生 HLS EVENT 播放列表交给
`HTMLAudioElement`。播放期间，媒体分片的 HTTP 请求会让 Queue 把
生成窗口向前推进约 20 分钟；完成的分片及其词级时间轴保存在 R2。
播放列表只追加已经持久化的分片，不依赖后台网页定时器换源。

未登录云端同步、设备不支持原生 HLS 或首段未完成时，继续使用旧的
`/api/tts` 播放器。原生 HLS 宣称可用但 8 秒内没有开始播放时也回退。
切换音色、跳到尚未生成的句子沿用旧引擎，打开新播放位置时再次预热。
本次没有接入原生 iOS App；主屏幕 PWA 的后台可靠性仍取决于 WebKit。

部署前创建名为 `moting-audio` 的 Cloudflare Queue。Worker 同时作为
producer/consumer，R2 仍用 `moting-books`；为 `live-hls-v1/` 前缀
设置 2 天对象过期规则。所有媒体端点通过现有同步会话 Cookie 鉴权。
临时会话在 48 小时后不能访问，R2 生命周期负责实际删除正文与音频。

诊断：浏览器的播放/等待/切后台事件以及媒体分片 GET 被写入当前会话的
`events/` 对象；Queue 成功和失败记录在 Worker observability 中。
登录后 `/api/sync/live/<session-id>/diagnostics` 汇总状态与最近事件。
简要事件也写入 D1 `audio_telemetry`，部署时运行
`npx wrangler d1 execute moting-sync --file worker/audio-telemetry.sql --remote`；
后台可查询 `SELECT * FROM audio_telemetry ORDER BY id DESC LIMIT 100`，
再按 session_id 追查一段收听。日志不记录书籍正文或登录凭据。
简要事件保留约 7 天，每次建立新会话时清理；R2 会话对象按 2 天规则过期。
客户端打开播放页时也会记下版本、原生 HLS 支持状态和回退原因；未出现这些
事件而只出现 `/api/tts` 请求，说明设备仍在运行旧版页面。
这能区分上游合成失败、队列停止和手机没有继续请求媒体。未使用音频
设备的自动化测试不能证明 iPhone 锁屏稳定或首播达到 1–2 秒。

本次会话最多覆盖 12 万字；跨过这段后需要在前台重新建会话。番茄钟
仍是浏览器计时器，iOS 后台可能挂起它；这两项须在后续原生播放阶段
实现服务端停止点和连续长书会话。
