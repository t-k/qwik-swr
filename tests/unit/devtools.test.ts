import { describe, it, expect, beforeEach } from "vitest";
import { store } from "../../src/cache/store.ts";
import { cache } from "../../src/cache/cache-api.ts";
import type { CacheExport, HashedKey } from "../../src/types/index.ts";

// Helper to cast string to HashedKey in tests
const hk = (s: string) => s as HashedKey;

describe("SWRDevtools", () => {
  beforeEach(() => {
    store._reset();
  });

  // ─── T052: getDebugSnapshot returns all cache entries ───

  describe("T052: getDebugSnapshot returns all cache entries", () => {
    it("should return empty snapshot when no cache entries exist", () => {
      const snapshot = store.getDebugSnapshot();

      expect(snapshot.entries).toEqual([]);
      expect(snapshot.totalObservers).toBe(0);
      expect(snapshot.inflightCount).toBe(0);
    });

    it("should return all cache entries with correct fields", () => {
      const now = Date.now();
      store.setCache(hk("s:key1"), { data: "value1", timestamp: now });
      store.setCache(hk("s:key2"), { data: "value2", timestamp: now - 5000 });
      store.setCache(hk("s:key3"), { data: "value3", timestamp: now - 10000 });

      const snapshot = store.getDebugSnapshot();

      expect(snapshot.entries).toHaveLength(3);
      expect(snapshot.totalObservers).toBe(0);
      expect(snapshot.inflightCount).toBe(0);

      const keys = snapshot.entries.map((e) => e.hashedKey);
      expect(keys).toContain("s:key1");
      expect(keys).toContain("s:key2");
      expect(keys).toContain("s:key3");
    });

    it("should show status 'fresh' for entries without queryConfig", () => {
      // Without queryConfig, non-error non-inflight entries show as "fresh"
      store.setCache(hk("s:freshKey"), { data: "hello", timestamp: Date.now() });

      const snapshot = store.getDebugSnapshot();
      const entry = snapshot.entries.find((e) => e.hashedKey === "s:freshKey");

      expect(entry).toBeDefined();
      expect(entry!.status).toBe("fresh");
      expect(entry!.hasError).toBe(false);
    });

    it("should show status 'error' for entries with error field", () => {
      store.setCache(hk("s:errorKey"), {
        data: undefined,
        timestamp: Date.now(),
        error: {
          type: "network",
          message: "Network error",
          retryCount: 0,
          timestamp: Date.now(),
        },
      });

      const snapshot = store.getDebugSnapshot();
      const entry = snapshot.entries.find((e) => e.hashedKey === "s:errorKey");

      expect(entry).toBeDefined();
      expect(entry!.status).toBe("error");
      expect(entry!.hasError).toBe(true);
    });

    it("should calculate age correctly", () => {
      const pastTime = Date.now() - 5000;
      store.setCache(hk("s:agedKey"), { data: "old", timestamp: pastTime });

      const snapshot = store.getDebugSnapshot();
      const entry = snapshot.entries.find((e) => e.hashedKey === "s:agedKey");

      expect(entry).toBeDefined();
      // Age should be approximately 5000ms (allow some tolerance)
      expect(entry!.age).toBeGreaterThanOrEqual(4900);
      expect(entry!.age).toBeLessThan(6000);
    });

    it("should report observerCount as 0 when no observers attached", () => {
      store.setCache(hk("s:noObs"), { data: "data", timestamp: Date.now() });

      const snapshot = store.getDebugSnapshot();
      const entry = snapshot.entries.find((e) => e.hashedKey === "s:noObs");

      expect(entry).toBeDefined();
      expect(entry!.observerCount).toBe(0);
    });
  });

  // ─── T053: cache.export returns CacheExport format ───

  describe("T053: cache.export returns CacheExport format", () => {
    it("should return correct CacheExport structure with no entries", () => {
      const exported = cache.export();

      expect(exported.version).toBe(1);
      expect(exported.exportedAt).toBeTypeOf("number");
      expect(exported.entries).toEqual([]);
    });

    it("should export all cache entries", () => {
      const now = Date.now();
      store.setCache(hk("s:alpha"), { data: "a", timestamp: now });
      store.setCache(hk("s:beta"), { data: "b", timestamp: now - 1000 });

      const exported = cache.export();

      expect(exported.version).toBe(1);
      expect(exported.exportedAt).toBeGreaterThanOrEqual(now);
      expect(exported.entries).toHaveLength(2);

      const alphaEntry = exported.entries.find((e) => e.hashedKey === "s:alpha");
      expect(alphaEntry).toBeDefined();
      expect(alphaEntry!.entry.data).toBe("a");
      expect(alphaEntry!.entry.timestamp).toBe(now);

      const betaEntry = exported.entries.find((e) => e.hashedKey === "s:beta");
      expect(betaEntry).toBeDefined();
      expect(betaEntry!.entry.data).toBe("b");
      expect(betaEntry!.entry.timestamp).toBe(now - 1000);
    });

    it("should include error entries in export", () => {
      store.setCache(hk("s:errExport"), {
        data: null,
        timestamp: 1000,
        error: {
          type: "http",
          message: "404 Not Found",
          retryCount: 2,
          timestamp: 1000,
        },
      });

      const exported = cache.export();

      expect(exported.entries).toHaveLength(1);
      expect(exported.entries[0].entry.error).toBeDefined();
      expect(exported.entries[0].entry.error!.type).toBe("http");
    });
  });

  // ─── T054: cache.import (merge) keeps existing + adds new ───

  describe("T054: cache.import (merge) keeps existing + adds new", () => {
    it("should add new entries without affecting existing ones", () => {
      // Pre-existing entry
      store.setCache(hk("s:existing"), { data: "original", timestamp: 2000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [{ hashedKey: hk("s:newKey"), entry: { data: "imported", timestamp: 1500 } }],
      };

      cache.import(importData, { strategy: "merge" });

      // Existing entry should remain unchanged
      const existing = store.getCache(hk("s:existing"));
      expect(existing).not.toBeNull();
      expect(existing!.data).toBe("original");
      expect(existing!.timestamp).toBe(2000);

      // New entry should be added
      const newEntry = store.getCache(hk("s:newKey"));
      expect(newEntry).not.toBeNull();
      expect(newEntry!.data).toBe("imported");
      expect(newEntry!.timestamp).toBe(1500);
    });

    it("should default to merge strategy when no options provided", () => {
      store.setCache(hk("s:def"), { data: "old", timestamp: 3000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [
          // Older timestamp -> should NOT replace
          { hashedKey: hk("s:def"), entry: { data: "older", timestamp: 1000 } },
          // New key -> should be added
          { hashedKey: hk("s:brand-new"), entry: { data: "fresh", timestamp: 5000 } },
        ],
      };

      cache.import(importData); // no options = merge by default

      expect(store.getCache(hk("s:def"))!.data).toBe("old"); // kept existing
      expect(store.getCache(hk("s:brand-new"))!.data).toBe("fresh"); // added new
    });
  });

  // ─── T055: cache.import (overwrite) replaces all ───

  describe("T055: cache.import (overwrite) replaces all", () => {
    it("should clear existing cache and replace with imported entries", () => {
      // Pre-existing entries
      store.setCache(hk("s:willBeGone"), { data: "bye", timestamp: 1000 });
      store.setCache(hk("s:alsoGone"), { data: "goodbye", timestamp: 2000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [
          { hashedKey: hk("s:replacement1"), entry: { data: "new1", timestamp: 3000 } },
          { hashedKey: hk("s:replacement2"), entry: { data: "new2", timestamp: 4000 } },
        ],
      };

      cache.import(importData, { strategy: "overwrite" });

      // Old entries should be gone
      expect(store.getCache(hk("s:willBeGone"))).toBeNull();
      expect(store.getCache(hk("s:alsoGone"))).toBeNull();

      // New entries should exist
      expect(store.getCache(hk("s:replacement1"))!.data).toBe("new1");
      expect(store.getCache(hk("s:replacement2"))!.data).toBe("new2");
    });

    it("should work with empty import (clears all)", () => {
      store.setCache(hk("s:clear-me"), { data: "data", timestamp: 1000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [],
      };

      cache.import(importData, { strategy: "overwrite" });

      expect(store.getCache(hk("s:clear-me"))).toBeNull();
      expect(store.keys()).toHaveLength(0);
    });
  });

  // ─── T056: cache.import (merge) for same key, newer timestamp wins ───

  describe("T056: cache.import (merge) for same key, newer timestamp wins", () => {
    it("should keep existing entry when imported entry has older timestamp", () => {
      store.setCache(hk("s:conflict"), { data: "current", timestamp: 2000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [
          { hashedKey: hk("s:conflict"), entry: { data: "older-import", timestamp: 1000 } },
        ],
      };

      cache.import(importData, { strategy: "merge" });

      const result = store.getCache(hk("s:conflict"));
      expect(result!.data).toBe("current"); // kept existing (newer)
      expect(result!.timestamp).toBe(2000);
    });

    it("should replace existing entry when imported entry has newer timestamp", () => {
      store.setCache(hk("s:conflict"), { data: "current", timestamp: 2000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [
          { hashedKey: hk("s:conflict"), entry: { data: "newer-import", timestamp: 3000 } },
        ],
      };

      cache.import(importData, { strategy: "merge" });

      const result = store.getCache(hk("s:conflict"));
      expect(result!.data).toBe("newer-import"); // replaced with newer
      expect(result!.timestamp).toBe(3000);
    });

    it("should keep existing entry when timestamps are equal", () => {
      store.setCache(hk("s:equal"), { data: "existing", timestamp: 2000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [
          { hashedKey: hk("s:equal"), entry: { data: "imported-same-time", timestamp: 2000 } },
        ],
      };

      cache.import(importData, { strategy: "merge" });

      const result = store.getCache(hk("s:equal"));
      expect(result!.data).toBe("existing"); // kept existing (equal timestamp)
      expect(result!.timestamp).toBe(2000);
    });

    it("should handle mixed: some keys newer, some older, some new", () => {
      store.setCache(hk("s:old-wins"), { data: "keep-me", timestamp: 5000 });
      store.setCache(hk("s:new-wins"), { data: "replace-me", timestamp: 1000 });

      const importData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [
          // Older than existing -> skip
          { hashedKey: hk("s:old-wins"), entry: { data: "nope", timestamp: 3000 } },
          // Newer than existing -> replace
          { hashedKey: hk("s:new-wins"), entry: { data: "yes", timestamp: 4000 } },
          // Brand new key -> add
          { hashedKey: hk("s:brand-new"), entry: { data: "added", timestamp: 2000 } },
        ],
      };

      cache.import(importData, { strategy: "merge" });

      expect(store.getCache(hk("s:old-wins"))!.data).toBe("keep-me");
      expect(store.getCache(hk("s:new-wins"))!.data).toBe("yes");
      expect(store.getCache(hk("s:brand-new"))!.data).toBe("added");
    });
  });

  // ─── BUG3: revalidateByKey returns false for observer-less keys ───

  describe("revalidateByKey returns false when no observers exist for key", () => {
    it("should return false when cache exists but no observers are attached", () => {
      store.setCache(hk("s:noobs"), { data: "val", timestamp: Date.now() });

      const result = store.revalidateByKey(hk("s:noobs"));

      expect(result).toBe(false);
    });
  });

  // ─── cache.export and cache.import round-trip ───

  describe("cache.export and cache.import round-trip preserves data", () => {
    it("should restore entries after reset via export then import", () => {
      store.setCache(hk("s:exp1"), { data: "a", timestamp: 1000 });
      store.setCache(hk("s:exp2"), { data: "b", timestamp: 2000 });

      const exported = cache.export();

      store._reset();

      cache.import(exported, { strategy: "merge" });

      const entry1 = store.getCache(hk("s:exp1"));
      expect(entry1).not.toBeNull();
      expect(entry1!.data).toBe("a");

      const entry2 = store.getCache(hk("s:exp2"));
      expect(entry2).not.toBeNull();
      expect(entry2!.data).toBe("b");
    });
  });

  // ─── cache.import with strategy 'replace' replaces all entries ───

  describe("cache.import with strategy 'replace' replaces all entries", () => {
    it("should remove old keys and add new keys when using overwrite strategy", () => {
      store.setCache(hk("s:old"), { data: "old", timestamp: 1000 });

      const newData: CacheExport = {
        version: 1,
        exportedAt: Date.now(),
        entries: [{ hashedKey: hk("s:fresh"), entry: { data: "fresh", timestamp: 2000 } }],
      };

      cache.import(newData, { strategy: "overwrite" });

      expect(store.getCache(hk("s:old"))).toBeNull();

      const freshEntry = store.getCache(hk("s:fresh"));
      expect(freshEntry).not.toBeNull();
      expect(freshEntry!.data).toBe("fresh");
    });
  });
});
