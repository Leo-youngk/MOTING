/** Actual contiguous playable data, not the end of the last (possibly disjoint) range. */
export function continuousAhead(ranges, time, tolerance = 0.05) {
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.start(i) <= time + tolerance && ranges.end(i) > time) return ranges.end(i) - time;
  }
  return 0;
}

export function missingInterval(ranges, start, end, tolerance = 0.15) {
  if (end - start <= tolerance) return false;
  let cursor = start;
  for (let i = 0; i < ranges.length; i++) {
    if (ranges.end(i) <= cursor) continue;
    if (ranges.start(i) > cursor + tolerance) return true;
    cursor = Math.max(cursor, ranges.end(i));
    if (cursor >= end - tolerance) return false;
  }
  return true;
}

/** Retry the SAME bytes after quota, splitting MP3 input into smaller appends.
 * A wall-clock deadline prevents waiting forever for a stalled playback clock.
 * MPEG audio byte streams accept arbitrary byte boundaries; the parser retains incomplete frames.
 */
export async function appendWithRecovery(bytes, {
  append, trim, wait, alive = () => true, onQuota = () => {},
  now = Date.now, timeout = 30000, minChunk = 16384,
}) {
  let offset = 0;
  let chunkSize = Math.min(bytes.byteLength, 256 * 1024);
  let blockedSince = null;
  while (offset < bytes.byteLength) {
    if (!alive()) throw new Error('媒体源已关闭');
    const size = Math.min(chunkSize, bytes.byteLength - offset);
    try {
      await append(bytes.subarray(offset, offset + size));
      offset += size;
      blockedSince = null;
    } catch (error) {
      if (error?.name !== 'QuotaExceededError') throw error;
      blockedSince ??= now();
      onQuota(size);
      await trim();
      if (now() - blockedSince >= timeout) throw new Error('缓冲空间不足且无法恢复，请降低缓冲量后重试');
      if (size > minChunk) chunkSize = Math.max(minChunk, Math.floor(size / 2));
      else await wait();
    }
  }
}
