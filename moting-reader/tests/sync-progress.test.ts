import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeProgress, type QueuedProgress } from "../lib/sync-progress.ts";

function pending(): QueuedProgress {
  return { id: "positions:book", kind: "positions", key: "book", data: '{"sentence":5}', updatedAt: 1,
    seq: 2, mutationId: "new-mutation", serverRev: 10, baseServerRev: 10, pending: true, bootstrap: false };
}

test("an older upload acknowledgement preserves progress created while it was in flight", () => {
  const current = pending();
  const next = acknowledgeProgress(current, { kind: "positions", key: "book", mutationId: "older-mutation", status: "accepted",
    record: { key: "book", data: { sentence: 4 }, updatedAt: 5000, serverAt: 11 } });
  assert.equal(next.pending, true);
  assert.equal(next.seq, 2);
  assert.equal(next.data, current.data);
  assert.equal(next.baseServerRev, 11);
});

test("a conflict preserves the local candidate and applies the authoritative server version independently of clocks", () => {
  const current = { ...pending(), updatedAt: 1_000_000 };
  const next = acknowledgeProgress(current, { kind: "positions", key: "book", mutationId: current.mutationId, status: "conflict",
    record: { key: "book", data: { sentence: 8 }, updatedAt: 1, serverAt: 12 } });
  assert.equal(next.pending, false);
  assert.equal(next.data, '{"sentence":8}');
  assert.equal(next.conflict?.data, current.data);
  assert.equal(next.conflict?.updatedAt, current.updatedAt);
});

test("a delayed acknowledgement cannot undo a server version already applied", () => {
  const current = { ...pending(), serverRev: 20, baseServerRev: 20 };
  assert.equal(acknowledgeProgress(current, { kind: "positions", key: "book", mutationId: current.mutationId, status: "accepted",
    record: { key: "book", data: { sentence: 1 }, updatedAt: 100, serverAt: 11 } }), current);
});

test("a delayed conflict cannot clear a newer position created during upload", () => {
  const current = pending();
  const next = acknowledgeProgress(current, { kind: "positions", key: "book", mutationId: "older-mutation", status: "conflict",
    record: { key: "book", data: { sentence: 8 }, updatedAt: 1, serverAt: 12 } });
  assert.equal(next.pending, true);
  assert.equal(next.data, current.data);
  assert.equal(next.mutationId, current.mutationId);
  assert.equal(next.baseServerRev, current.baseServerRev);
  assert.equal(next.serverRev, 12);
});
