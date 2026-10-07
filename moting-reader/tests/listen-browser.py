"""听书播放器的整条链路，在 iPhone 视口的 Chromium 里跑（不是真机）。

Usage: python tests/listen-browser.py [http://127.0.0.1:5173]
Requires `npm run dev` 和 Playwright（装了 Edge，或者用 BROWSER_PATH 指定 Chromium）。
截图写到 .wrangler/listen-tests/。

/api/tts 在页面里拦下来，回一段构造的静音 MP3（帧格式和云健的一样）加时间轴，
每句 2 秒，所以不碰微软的服务。系统朗读换成一个假的 speechSynthesis（1.5 秒读完一块），
Date.now 可以拨快，用来跳过「云端失败后冷却 30 秒」。

检查：
1. 起播：首段 360 字以内；首段一开播就预取第二段（1500 字以内）；读完首段直接接上第二段，不出「正在准备」。
2. 系统打断（来电、拔耳机）：界面同步成暂停，锁屏上的播放键能接着放。
3. 前进/后退 15 秒按真实时间轴跳，在已加载的音频里不重新合成。
4. 云端连不上：先重试一次，再退回系统朗读并提示；冷却过后自动换回云端。
5. 定时关闭「本章结束后」：在换章前的静音里暂停，位置停在下一章开头，迷你条还在。
6. 离线缓存：整格下到本机，重开应用点播放直接出声，不再请求合成。
7. 读音纠正：设置里加一条规则，送去合成的文字跟着变。
"""
import json
import math
import os
import struct
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
OUTPUT = Path(__file__).resolve().parents[1] / ".wrangler" / "listen-tests"
OUTPUT.mkdir(parents=True, exist_ok=True)
NOW = int(time.time() * 1000)
SENTENCE_SECONDS = 2.0
FRAME_SECONDS = 576 / 24000
SILENT_FRAME = bytes([0xFF, 0xF3, 0x64, 0xC4]) + bytes(140)
BOOK_ID = "listen-book"

OPEN_DB = "const db = await new Promise((res, rej) => { const r = indexedDB.open('moting-reader'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });"

INIT_SCRIPT = """
(() => {
  // 抓住播放器 new 出来的 audio 元素和注册的锁屏按钮。
  window.__audios = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!window.__audios.includes(this)) window.__audios.push(this);
    return play.call(this);
  };
  window.__media = {};
  if (navigator.mediaSession) {
    const set = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      window.__media[action] = handler;
      try { set(action, handler); } catch (error) {}
    };
  }
  // 可以拨快的时钟。
  const realNow = Date.now;
  window.__dateOffset = 0;
  Date.now = () => realNow() + window.__dateOffset;
  // 假的系统朗读：一块 1.5 秒读完。
  const synth = {
    speaking: false, paused: false, pending: false, current: null, spoken: [],
    speak(utterance) {
      this.current = utterance; this.speaking = true; this.spoken.push(utterance.text);
      setTimeout(() => {
        if (this.current !== utterance) return;
        this.current = null; this.speaking = false;
        utterance.onend && utterance.onend(new Event('end'));
      }, 1500);
    },
    cancel() {
      const utterance = this.current; this.current = null; this.speaking = false;
      if (utterance && utterance.onerror) utterance.onerror({ error: 'canceled' });
    },
    pause() {}, resume() {}, getVoices() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
})();
"""


def sentence(sid, text, order):
    return {"id": sid, "text": text, "speakableText": text, "order": order}


def make_book(chapter_count=8):
    chapters = []
    for c in range(chapter_count):
        cid = f"c{c}"
        heading = sentence(f"{cid}-h", f"第{c + 1}章 远行", 0)
        paragraphs = [{"id": f"{cid}-p0", "order": 0, "kind": "heading", "level": 2, "sentences": [heading]}]
        count = 1
        for p in range(6):
            sentences = []
            for s in range(5):
                extra = "行长说" if (p + s) % 4 == 0 else "他走着"
                sentences.append(sentence(f"{cid}-{p}-{s}", f"第{c + 1}章第{p + 1}段第{s + 1}句{extra}，路很长。", s))
            paragraphs.append({"id": f"{cid}-p{p + 1}", "order": p + 1, "kind": "text", "sentences": sentences})
            count += len(sentences)
        chars = sum(len(s["text"]) for para in paragraphs for s in para["sentences"])
        chapters.append({"id": cid, "title": f"第{c + 1}章 远行", "order": c, "sentenceCount": count,
                         "characterCount": chars, "paragraphs": paragraphs})
    total_sentences = sum(c["sentenceCount"] for c in chapters)
    total_chars = sum(c["characterCount"] for c in chapters)
    return {"id": BOOK_ID, "title": "远行记", "author": "测试作者", "format": "txt", "accent": "#7a8290",
            "status": "ready", "createdAt": NOW, "updatedAt": NOW, "lastOpenedAt": NOW,
            "sentenceCount": total_sentences, "characterCount": total_chars, "chapters": chapters}


BOOK = make_book()


def sentence_starts(text):
    """每句从第几个字开始：开头、句号后面、换行后面。"""
    starts = []
    for index, char in enumerate(text):
        if char == "\n":
            continue
        if index == 0 or text[index - 1] in "。\n":
            starts.append(index)
    return starts


def frame_tts(text):
    starts = sentence_starts(text)
    timeline = [{"time": k * SENTENCE_SECONDS, "charIndex": start} for k, start in enumerate(starts)]
    frames = math.ceil((len(starts) * SENTENCE_SECONDS + 0.5) / FRAME_SECONDS)
    metadata = json.dumps(timeline).encode()
    return struct.pack(">I", len(metadata)) + metadata + SILENT_FRAME * frames, timeline


class Tts:
    """拦 /api/tts：记下每次请求的文本，可以切成 503。"""

    def __init__(self):
        self.requests = []
        self.failing = False
        self.timelines = {}

    def handle(self, route):
        payload = json.loads(route.request.post_data or "{}")
        text = payload.get("text", "")
        self.requests.append(text)
        if self.failing:
            route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": "上游忙"}))
            return
        body, timeline = frame_tts(text)
        self.timelines[text] = timeline
        route.fulfill(status=200, content_type="application/octet-stream", body=body)


def seed(page):
    page.evaluate(
        "async (book) => {" + OPEN_DB + """
            await new Promise((res, rej) => { const t = db.transaction(['books','contents'], 'readwrite');
                const { chapters, ...meta } = book;
                t.objectStore('books').put({ ...meta, chapterOutline: chapters.map(c => ({ id: c.id, title: c.title, sentenceCount: c.sentenceCount, characterCount: c.characterCount })) });
                t.objectStore('contents').put({ bookId: book.id, chapters });
                t.oncomplete = res; t.onerror = () => rej(t.error); });
            db.close();
        }""",
        BOOK,
    )


def new_page(browser, tts):
    context = browser.new_context(
        viewport={"width": 390, "height": 844},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True,
        service_workers="block",
    )
    context.add_init_script(INIT_SCRIPT)
    context.route("**/api/tts", tts.handle)
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    seed(page)
    page.reload()
    page.wait_for_load_state("networkidle")
    return context, page, errors


def open_player(page):
    # 重开应用会回到上次的页面：已经在播放页就不用再点进去，在设置这类二级页就先退出来。
    page.wait_for_timeout(300)
    if page.locator(".player-screen").count():
        page.wait_for_timeout(400)
        return
    for _ in range(3):
        if page.locator(".bottom-nav").count():
            break
        page.get_by_role("button", name="返回").first.click()
        page.wait_for_timeout(300)
    page.locator(".bottom-nav").get_by_role("button", name="听书").click()
    page.locator(".ios-row__main", has_text="远行记").first.click()
    page.locator(".player-screen").wait_for()
    page.wait_for_timeout(400)


def audio_state(page):
    return page.evaluate(
        """() => { const a = window.__audios.find(x => x.src.startsWith('blob:') || x.src.startsWith('data:'));
            const last = window.__audios[window.__audios.length - 1];
            return last ? { paused: last.paused, src: last.src, time: last.currentTime, duration: last.duration,
                             session: navigator.mediaSession ? navigator.mediaSession.playbackState : '' } : null; }"""
    )


def wait_playing(page, timeout=8000):
    page.wait_for_function(
        "() => { const a = window.__audios[window.__audios.length - 1]; return a && !a.paused && a.src.startsWith('blob:') && a.readyState >= 2; }",
        timeout=timeout,
    )


def primary_label(page):
    return page.locator(".player-primary-control").get_attribute("aria-label")


def line(page):
    return page.locator(".player-line").inner_text()


def wait_for(predicate, timeout=6.0, step=0.1):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()


def check_playback(browser, checks):
    tts = Tts()
    context, page, errors = new_page(browser, tts)
    open_player(page)
    # 进播放页就预取首段。
    checks["prefetch_on_open"] = wait_for(lambda: len(tts.requests) == 1)
    first = tts.requests[0] if tts.requests else ""
    checks["first_segment_short"] = 0 < len(first) <= 363

    page.locator(".player-primary-control").click()
    wait_playing(page)
    checks["first_play_hits_prefetch"] = len(tts.requests) >= 1 and tts.requests.count(first) == 1
    checks["second_segment_prefetched"] = wait_for(lambda: len(tts.requests) >= 2)
    second = tts.requests[1] if len(tts.requests) > 1 else ""
    checks["second_segment_medium"] = 363 < len(second) <= 1503
    checks["first_continues_into_second"] = bool(second) and first.rstrip("\n") != second and BOOK["chapters"][0]["paragraphs"][0]["sentences"][0]["text"] in first
    page.screenshot(path=str(OUTPUT / "playing.png"))

    # 系统打断：元素被系统暂停，界面要跟着变，锁屏的播放键要能续上。
    page.evaluate("() => window.__audios[window.__audios.length - 1].pause()")
    checks["interrupt_syncs_ui"] = wait_for(lambda: primary_label(page) == "播放")
    checks["interrupt_syncs_lock_screen"] = audio_state(page)["session"] == "paused"
    page.evaluate("() => window.__media.play()")
    checks["lock_screen_play_resumes"] = wait_for(lambda: primary_label(page) == "暂停" and not audio_state(page)["paused"])

    # 15 秒按真实时间轴跳（每句 2 秒，大约 7 句），在已加载的音频里，不重新合成。
    before_requests = len(tts.requests)
    before_time = audio_state(page)["time"]
    page.get_by_role("button", name="前进 15 秒").click()
    page.wait_for_timeout(300)
    after_time = audio_state(page)["time"]
    checks["skip_forward_real_time"] = 12.5 <= after_time - before_time <= 16.5
    page.get_by_role("button", name="后退 15 秒").click()
    page.wait_for_timeout(300)
    back_time = audio_state(page)["time"]
    checks["skip_back_real_time"] = 13 <= after_time - back_time <= 17.5
    checks["skip_inside_clip_no_synthesis"] = len(tts.requests) == before_requests

    # 首段放完直接接第二段（已经预取好了），中间不出「正在准备」。
    first_src = audio_state(page)["src"]
    page.evaluate("() => { const a = window.__audios[window.__audios.length - 1]; a.currentTime = a.duration - 0.15; }")
    checks["seamless_handover"] = wait_for(
        lambda: audio_state(page)["src"] != first_src and not audio_state(page)["paused"], timeout=4
    )
    checks["no_buffering_on_handover"] = page.locator(".player-preparing").count() == 0
    checks["third_segment_prefetched"] = wait_for(lambda: len(tts.requests) >= 3)
    checks["playback_no_page_errors"] = not errors
    context.close()


def check_fallback(browser, checks):
    tts = Tts()
    tts.failing = True
    context, page, errors = new_page(browser, tts)
    open_player(page)
    clicked = time.time()
    page.locator(".player-primary-control").click()
    # 失败一次先等 1.5 秒重试，第二次才退回系统朗读。
    checks["fallback_message"] = wait_for(lambda: "云端语音暂时连不上" in page.locator("body").inner_text(), timeout=8)
    checks["retries_before_fallback"] = time.time() - clicked >= 1.4 and len(tts.requests) >= 2
    checks["fallback_uses_system_voice"] = wait_for(
        lambda: page.evaluate("() => window.speechSynthesis.spoken.length") > 0, timeout=3
    )
    checks["fallback_label"] = page.locator(".player-tools").get_by_text("系统声音").count() == 1
    page.screenshot(path=str(OUTPUT / "fallback.png"))

    # 云端恢复、冷却时间过了：下一块自动换回云端。
    tts.failing = False
    page.evaluate("() => { window.__dateOffset += 31000; }")
    checks["returns_to_cloud"] = wait_for(
        lambda: (audio_state(page) or {}).get("src", "").startswith("blob:") and not audio_state(page)["paused"],
        timeout=8,
    )
    checks["fallback_message_cleared"] = wait_for(
        lambda: "云端语音暂时连不上" not in page.locator("body").inner_text(), timeout=3
    )
    checks["fallback_no_page_errors"] = not errors
    context.close()


def check_sleep_chapter(browser, checks):
    tts = Tts()
    context, page, errors = new_page(browser, tts)
    open_player(page)
    page.locator(".player-tools").get_by_role("button", name="定时").click()
    page.get_by_role("button", name="本章结束后").click()
    page.locator(".player-primary-control").click()
    wait_playing(page)
    # 跳到第二段（跨进第二章），再拨到换章前一秒。
    first_src = audio_state(page)["src"]
    page.evaluate("() => { const a = window.__audios[window.__audios.length - 1]; a.currentTime = a.duration - 0.15; }")
    wait_for(lambda: audio_state(page)["src"] != first_src and not audio_state(page)["paused"], timeout=4)
    second = tts.requests[1] if len(tts.requests) > 1 else ""
    boundary = second.find("\n\n\n")
    starts = sentence_starts(second)
    next_start = next((k for k, start in enumerate(starts) if start > boundary), None) if boundary >= 0 else None
    checks["second_segment_crosses_chapter"] = next_start is not None
    if next_start is not None:
        page.evaluate(
            "(t) => { const a = window.__audios[window.__audios.length - 1]; a.currentTime = t; }",
            next_start * SENTENCE_SECONDS - 1.0,
        )
        checks["sleep_pauses_at_chapter_end"] = wait_for(lambda: primary_label(page) == "播放", timeout=3)
        checks["sleep_position_next_chapter"] = wait_for(lambda: line(page).startswith("第2章"), timeout=2)
        checks["sleep_mode_reset"] = page.locator(".player-tools").get_by_text("定时").count() == 1
    page.locator(".player-header").get_by_role("button", name="返回").click()
    checks["mini_player_stays"] = wait_for(lambda: page.locator(".mini-player").count() == 1, timeout=3)
    page.screenshot(path=str(OUTPUT / "sleep-paused.png"))
    checks["sleep_no_page_errors"] = not errors
    context.close()


def check_offline(browser, checks):
    tts = Tts()
    context, page, errors = new_page(browser, tts)
    open_player(page)
    page.get_by_role("button", name="更多").click()
    page.get_by_role("button", name="离线缓存后面 3 章").click()
    checks["download_finishes"] = wait_for(
        lambda: page.get_by_text("没网也能听").count() == 1 or page.get_by_text("已缓存").count() >= 1, timeout=10
    )
    cells = [text for text in tts.requests if len(text) > 1503]
    checks["download_whole_cells"] = len(cells) >= 1
    cached = page.evaluate("async () => (await (await caches.open('moting-tts-v2')).keys()).length")
    checks["cells_in_cache_storage"] = cached >= len(cells) and cached > 0
    page.screenshot(path=str(OUTPUT / "offline-cached.png"))

    # 重开应用：进播放页从本机把整格搬进内存，点播放直接出声，不再请求合成。
    page.reload()
    page.wait_for_load_state("networkidle")
    open_player(page)
    page.wait_for_timeout(600)
    before = len(tts.requests)
    page.locator(".player-primary-control").click()
    wait_playing(page, timeout=1500)
    page.wait_for_timeout(500)
    # 之后可能会去预取下一格（没缓存的那部分），但起播这一段不能再请求合成。
    opening = BOOK["chapters"][0]["paragraphs"][0]["sentences"][0]["text"]
    checks["offline_play_without_synthesis"] = not any(
        text.startswith(opening) for text in tts.requests[before:]
    )
    checks["offline_no_page_errors"] = not errors
    context.close()


def check_replacement(browser, checks):
    tts = Tts()
    context, page, errors = new_page(browser, tts)
    page.get_by_role("button", name="设置").first.click()
    page.get_by_role("button", name="朗读音色").click()
    page.get_by_label("原文").fill("行长")
    page.get_by_label("读作").fill("航长")
    page.get_by_role("button", name="添加").click()
    checks["rule_listed"] = page.locator(".speech-rule").count() == 1
    page.screenshot(path=str(OUTPUT / "speech-rules.png"))
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    open_player(page)
    page.locator(".player-primary-control").click()
    wait_playing(page)
    texts = "".join(tts.requests)
    checks["replacement_applied"] = "航长" in texts and "行长" not in texts
    checks["replacement_no_page_errors"] = not errors
    context.close()


def main():
    checks = {}
    with sync_playwright() as playwright:
        executable = os.environ.get("BROWSER_PATH")
        launch = {"executable_path": executable} if executable else {"channel": "msedge"}
        browser = playwright.chromium.launch(
            headless=True, args=["--autoplay-policy=no-user-gesture-required"], **launch
        )
        for phase in (check_playback, check_fallback, check_sleep_chapter, check_offline, check_replacement):
            try:
                phase(browser, checks)
            except Exception as error:  # 一组挂了不影响别的组出结果。
                checks[f"{phase.__name__}_crashed: {str(error).splitlines()[0]}"] = False
        browser.close()

    failed = [name for name, ok in checks.items() if not ok]
    for name, ok in checks.items():
        print(f"{'PASS' if ok else 'FAIL'} {name}")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
