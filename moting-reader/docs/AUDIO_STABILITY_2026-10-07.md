# 听书连续播放修复（2026-10-07）

线上播放器在 14.35 秒出现 waiting/stalled，readyState 降至 0/1；服务端此时已生成 118.824 秒，随后继续生成约 20 分钟。问题发生在客户端切换至 HLS 和媒体封装阶段，不是简单缺少缓存。

旧封装把每个 120 字合成结果的音频时间戳置零，并在每段声明 discontinuity，且以 60 秒为 target duration。起播使用另一条短 MP3，再于播放途中切到原生 HLS；在尚无 seekable range 的 EVENT 流上立即设置 currentTime。12 秒未推进后又丢弃原生会话，退回分段换源。

## 修改后的行为

- iPhone/iPad 和桌面 Safari 使用原生 HLS 从首段开始播放，复用点击时激活的 audio 元素。准备 24 秒即可起播，播放页预热继续可用；不等待整本书生成，不再中途用 HLS 接管短 MP3。
- 新会话使用 MPEG-TS 容器，每个完整 MPEG 音频帧具有连续的 PTS/PCR。按完整音频帧划分约 6 秒媒体分片，PAT/PMT 与音频 continuity counter 均跨分片延续，无重编码、无逐片 discontinuity。播放列表的 EXT-X-START 请求原生定位，避免在 metadata 就绪但 seekable 尚未就绪时强行写入 currentTime。
- Cloudflare Queue 独立生成、R2 持久化，媒体 GET 触发约 20 分钟的滚动预缓存。缓存对象 private/immutable。较旧会话保留分片格式、编号和准备门槛。生产仍限制 Queue 并发为 1，防止同会话状态并发写入。
- 先写媒体对象再发布播放列表；写入失败不会推进正文游标或发布缺失分片。已满足的缓存目标不反复发送重复 Queue 任务。
- 普通缓冲保留同一媒体源；传输错误按原会话、原位置退避重试。主动暂停取消恢复任务，系统意外暂停尝试恢复，回到前台也恢复；系统明确禁止自动播放时显示原因并保留位置。暂停后发生媒体错误也可从原会话恢复。
- 长书会话上限从 12 万字提高至 120 万字，避免正常长书在有界会话末尾过早依赖页面 JS 另起音频。睡眠定时、书籍结束、手动停止保留原有含义。
- 诊断版本 2026-10-07-continuous-v4，事件增加客户端实际 buffered 范围与 MediaError 编号。PWA shell v21。

## 验证

259 项单元测试通过，类型检查与变更文件 ESLint 通过。覆盖 MPEG 帧完整性、连续 PTS、6 秒 target duration、跨 Queue 批次延续、R2 写入失败、原生媒体请求驱动缓存补充、旧会话兼容和长书范围。

21 项浏览器交互检查通过，使用公开《豆棚閒話》的章节与真实 MP3 解码，覆盖跨章、首次直接准备原生流、同元素复用、14 秒缓冲不丢弃原生流、错误恢复、主动暂停、意外暂停恢复和本章睡眠停止。原生控制流程的测试资源是 MP3 替身，不能当成 Safari HLS 或实体 iPhone 测试。

完整公开《豆棚閒話》作为 HLS 传输测试输入（93261 个朗读字符，11 个解析章节，正文完整；源文件的一则标题未匹配章节标签）。真实 HTTP HLS 经 FFmpeg 读取 70 个 MPEG-TS 分片，解码 359.976 秒，零解码错误、零非单调时间戳错误。无页面 JS 心跳时媒体 GET 仍将服务端生成窗口补充到 1220.784 秒。音频为受控有效 MP3，不包含用户私人正文或会话音频；测试只写 loopback 内存存储。

初次使用 packed MP3 连续时间戳方案时，长解码测试发现非单调 DTS，最终改为每帧具有明确时钟的 MPEG-TS。未进行实体 iPhone 的长时间锁屏验收，也不保证操作系统回收应用、外部音频占用或完全断网且缓存耗尽时永不受影响。

结构化结果：audio-stability-2026-10-07/player-controls.json 与 hls-transport.json。

## 复现

- node --experimental-strip-types --test tests/*.test.*
- READER_BOOK_PATH=<公开完整豆棚閒話文本> node --experimental-strip-types tests/hls-transport.mjs
- 按 tests/speech-chapter-browser.mjs 顶部设置浏览器与公开书籍路径。

设计依据：RFC 8216（https://www.rfc-editor.org/rfc/rfc8216）和 Apple HLS 规范（https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices）。
