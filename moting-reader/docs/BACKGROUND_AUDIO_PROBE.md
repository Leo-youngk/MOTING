# 后台听书验证（PR 14）

测试入口：设置 → 后台听书测试。此阶段只修改诊断页，正式 `use-speech-player.ts` 尚未切换引擎。

## 本次修复

- 缓冲不足按当前位置所在的连续区间计算，未来区间不能掩盖中间缺口。
- QuotaExceededError 重试同一批字节，清理已播数据、缩小 MP3 追加块；以真实时间限制重试，避免等待无法前进的播放时钟。
- 保留未播完音频与时间范围；系统回收后按原时间戳补回。恢复失败明确终止并留日志。
- 逐段换源组缓存命中时同步换源；未命中时循环静音等待，与正式播放器交接策略一致。
- 两组均设置 playback 音频会话。MMS 通常跟随 streaming 提示补充，低于 15 秒的连续缓冲允许紧急补充。
- 600 字/4 分钟为默认测试参数。提前缓冲按实际播放倍速换算，30 分钟只是目标，并非设备一定能保留。
- 日志包含绝对时间、前后台状态、连续缓冲长度、回收范围、恢复结果和缓存命中。当前测试页不保存正式听书进度。

## 已执行

- 类型检查、Lint、项目 200 项测试通过（含新增 5 项缓冲回归测试）。
- Chromium 134 的 MediaSource 浏览器测试通过：8 段拼接只启动一次播放；注入一次 quota 后恢复；主动移除中间区间后补回并播放越过缺口；换源组验证 2 次同步缓存命中。
- 浏览器测试使用合成 MP3 隔离媒体传输行为，不证明真实 TTS 服务、ManagedMediaSource 或 iPhone 后台播放已经通过。

运行：在应用目录启动 `python -m http.server 8765 --directory public`，另一个终端运行 `node tests/mms-probe-browser.mjs`。需安装 Playwright Chromium 与 ffmpeg；可用 BROWSER_PATH 指定 Chromium。

## iPhone 验收

1. 从主屏幕打开更新后的 PWA，通过设置进入测试页。确认独立模式为 true、ManagedMediaSource 为 true、audio/mpeg 支持为 true。
2. 选自己的真实长书，以 600 字、4 分钟、1×开始；播出声音后锁屏 60 分钟，中途不打开页面。
3. 回来复制日志：后台必须持续有 fetch-ok/appended；播放必须越过进入后台时已有缓冲终点。只有持续出声或播放 20 分钟不能证明后台补充正常。
4. 重新打开测试页，对同一本书同一章跑逐段换源组，再验证 2×、跨章节、网络切换、耳机暂停/继续。
5. MMS 通过后再集成正式播放器的文字时间轴、保存进度、跳章、换音色。未完成真机验证前不能宣称后台问题已修复。

## Native HLS validation — 2026-09-27-hls-v1

The default probe mode now prepares a finite VOD playlist before playback. It
uses the existing sync login (cookie path `/api/sync`), R2 binding and Edge TTS.
No new Cloudflare infrastructure or database migration is needed. Formal reader
playback is unchanged; MMS and swap remain selectable controls. The unshipped
120-second prefetch experiment is not part of this change.

1. Log into cloud sync in Settings and open Background Listening Test.
2. Select the same book/chapter as the MMS test and native HLS. Choose 10 minutes
   for a quick check or 60 minutes for the background test. Preparation stays in
   the foreground; it can take several minutes and retries failed batches.
3. After preparation, tap the separate play button (Safari user gesture).
4. Lock the phone or switch apps. Test 60 minutes at 1x, including chapter
   boundaries, then copy the logs. Do not swipe the PWA away from the app switcher;
   HLS does not promise continued playback after the OS terminates the app.
5. Confirm version `2026-09-27-hls-v1`, `hls-ready` duration, no waiting/error during
   listening, and continued actual audible playback. Sparse background JS logs
   alone do not prove or disprove native playback.

Preparation sends at most 600 characters per request, internally synthesizes
120-character chunks with at most three concurrent sockets, measures MP3 frame
durations, prepends RFC 8216 §3.4 ID3 PRIV timestamps, and stores packed MP3 plus
byte-range metadata. Finalization reads only completed objects and emits a VOD
playlist with ENDLIST and timestamp discontinuities between batches. There is
no JS TTS pump during playback; Safari requests authenticated byte ranges from
R2. No hls.js or MSE fallback silently substitutes for native HLS.

Up to 40 batches, or the end of the book, may shorten the requested duration,
especially at faster rates. The page shows actual prepared duration. Test
position is not written into the formal reader. Audio keys expire after 24–48
hours (daily cache); URLs require the sync session. Text is not stored. Old
objects are removed in bounded batches on future preparation requests; this is
opportunistic cleanup, not an exact scheduled physical-deletion deadline.

Verification: `npm test`, `npm run typecheck`, `npm run lint`. The HLS test uses
FFmpeg (required on PATH) to generate a synthetic MP3 and decode both packed
segments and the complete byte-range playlist across a discontinuity. Tests
cover cache reuse, no synthesis on playback, byte-range correctness, malformed
requests, expiry and authentication. This validates transport and integration,
not iPhone lock-screen reliability. Real-device validation remains required
before integrating into the formal player.

## Fast native stream — 2026-09-27-stream-v1

Default test mode now creates a text session when a book/chapter is selected,
prewarms only the first sentence (up to 40 characters), and enables the play
button as soon as the session URL is ready. The click synchronously sets one
native `<audio src>` and calls play. No foreground TTS pump or segment handoff
is involved. Remaining text is synthesized server-side in batches up to 600
characters as the native HTTP response is consumed. Completed batches are
cached in R2; data is emitted before the upstream turn finishes. The existing
framed `/api/tts` API and formal player remain compatible.

The Edge websocket now converts Blob frames in order as they arrive, instead
of waiting for all frames. It rejects premature websocket closure, preserves
callback ordering, and never retries a stream segment after any bytes were
sent. Request cancellation closes upstream work. Queue buffering is bounded
per synthesis batch. Existing HLS/MMS/swap remain available for comparison.

`stream-first-playing.ms` is click-to-first-playing (not an acoustic microphone
measurement). `stream-server.firstAudioMs` is server synthesis/cache-to-first
emission, excluding session lookup and client network; `firstSource` distinguishes
cache from TTS. The metrics fetch is diagnostic only, not required for audio.
Do not conflate these measurements or claim a subsecond target without device
results. Opening the page may prewarm the first sentence, so a warm start is
not a cold-start benchmark.

This is a bounded validation session, not the final player: maximum 22,000 text
characters / 40 synthesis batches, no seek or disconnect-resume, stop at requested
duration on a batch boundary (or text end). Unknown length responses truthfully
return HTTP 200 with `Accept-Ranges: none`, including when a client supplies Range.
Safari's behavior for a long generated MP3 response needs real-device testing;
HLS remains the comparison path. Generation depends on an open native media
connection, not durable background jobs after disconnect. Cloudflare invocation
and upstream limits still apply; this does not claim indefinite playback.

Unlike the HLS VOD test, selected text is temporarily saved to authenticated R2
session objects so the native player can GET its media URL. Session access expires
in 48 hours; cache keys have daily buckets and are reused for up to 48 hours.
Cleanup touches only `audio-stream-v1/`, at most 50 old objects on later successful
warmups. It is opportunistic, not scheduled deletion. No sync book/position data
is modified.
