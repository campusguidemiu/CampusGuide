import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { appCache, cacheGet, cacheSet, cacheDel } from "../src/server/cache/cache";

/**
 * The in-process LRU behind account state, feature flags and the rooms list.
 *
 * Worth testing because the whole ban-takes-effect-immediately story rests on
 * it: `getAccountState` caches a status for 30s and `invalidateAccountState`
 * deletes the key. If `cacheDel` silently missed, a banned student would keep
 * working for half a minute after the admin pressed the button.
 */

const key = (name: string) => `test:${name}:${Math.random().toString(36).slice(2)}`;

test("a value survives the round trip", () => {
  const k = key("basic");
  cacheSet(k, { status: "active" });
  assert.deepEqual(cacheGet(k), { status: "active" });
});

test("a missing key reads as undefined, not null", () => {
  // getAccountState distinguishes these: undefined means "not cached", while a
  // cached "missing" string means "we looked and there is no such account".
  assert.equal(cacheGet(key("absent")), undefined);
});

test("cacheDel removes the entry so the next read goes back to the database", () => {
  const k = key("del");
  cacheSet(k, "active");
  assert.equal(cacheGet(k), "active");

  cacheDel(k);
  assert.equal(cacheGet(k), undefined, "a revoked account must not stay cached");
});

test("deleting a key that was never set is a no-op, not a throw", () => {
  assert.doesNotThrow(() => cacheDel(key("never-set")));
});

test("setting the same key twice keeps the newer value", () => {
  const k = key("overwrite");
  cacheSet(k, "pending");
  cacheSet(k, "active");
  assert.equal(cacheGet(k), "active");
});

test("a per-entry TTL expires the value", async () => {
  const k = key("ttl");
  cacheSet(k, "active", 40);

  assert.equal(cacheGet(k), "active", "still live immediately after writing");
  await sleep(80);
  assert.equal(cacheGet(k), undefined, "expired once its own TTL has passed");
});

test("a short TTL does not expire entries written without one", async () => {
  const shortLived = key("short");
  const defaultTtl = key("default");

  cacheSet(shortLived, 1, 40);
  cacheSet(defaultTtl, 2);

  await sleep(80);

  assert.equal(cacheGet(shortLived), undefined);
  assert.equal(cacheGet(defaultTtl), 2, "the 5-minute default must be unaffected");
});

test("falsy values round-trip intact", () => {
  // `cacheGet(k) || fallback` would be a bug at the call site; make sure the
  // cache itself is not the thing losing these.
  for (const value of [0, "", false]) {
    const k = key(`falsy-${String(value)}`);
    cacheSet(k, value);
    assert.equal(cacheGet(k), value);
  }
});

test("keys are namespaced independently", () => {
  const a = key("ns");
  const b = key("ns");
  cacheSet(a, "A");
  cacheSet(b, "B");
  assert.equal(cacheGet(a), "A");
  assert.equal(cacheGet(b), "B");
});

test("the cache is bounded, so it cannot grow without limit", () => {
  // A per-user key with no ceiling is a slow memory leak in a long-lived
  // serverless instance. lru-cache evicts; this asserts the bound exists.
  assert.equal(appCache.max, 500);

  for (let i = 0; i < 600; i++) cacheSet(`overflow:${i}`, i);
  assert.ok(appCache.size <= 500, `size ${appCache.size} must stay within max`);
});

test("the oldest entries are the ones evicted", () => {
  appCache.clear();
  for (let i = 0; i < 520; i++) cacheSet(`evict:${i}`, i);

  assert.equal(cacheGet("evict:0"), undefined, "the earliest write is gone");
  assert.equal(cacheGet("evict:519"), 519, "the most recent write survives");
});
