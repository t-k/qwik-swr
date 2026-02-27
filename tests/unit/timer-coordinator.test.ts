import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("timerCoordinator", () => {
  let timerCoordinator: typeof import("../../src/cache/timer-coordinator.ts").timerCoordinator;

  beforeEach(async () => {
    vi.useFakeTimers();
    const mod = await import("../../src/cache/timer-coordinator.ts");
    timerCoordinator = mod.timerCoordinator;
    timerCoordinator._reset();
  });

  afterEach(() => {
    timerCoordinator._reset();
    vi.useRealTimers();
  });

  it("should register a callback and fire at the specified interval", () => {
    const callback = vi.fn();
    timerCoordinator.register(5000, "ob1", callback);

    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5000);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("should share one timer for callbacks with the same interval", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const cb3 = vi.fn();

    timerCoordinator.register(5000, "ob1", cb1);
    timerCoordinator.register(5000, "ob2", cb2);
    timerCoordinator.register(5000, "ob3", cb3);

    expect(timerCoordinator._activeGroupCount()).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb3).toHaveBeenCalledTimes(1);
  });

  it("should create separate groups for different intervals", () => {
    const cb5s = vi.fn();
    const cb10s = vi.fn();

    timerCoordinator.register(5000, "ob1", cb5s);
    timerCoordinator.register(10000, "ob2", cb10s);

    expect(timerCoordinator._activeGroupCount()).toBe(2);

    vi.advanceTimersByTime(5000);
    expect(cb5s).toHaveBeenCalledTimes(1);
    expect(cb10s).toHaveBeenCalledTimes(0);

    vi.advanceTimersByTime(5000); // total: 10s
    expect(cb5s).toHaveBeenCalledTimes(2);
    expect(cb10s).toHaveBeenCalledTimes(1);
  });

  it("should unregister a callback and not call it anymore", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const unregister1 = timerCoordinator.register(5000, "ob1", cb1);
    timerCoordinator.register(5000, "ob2", cb2);

    unregister1();

    vi.advanceTimersByTime(5000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("should clear timer when last callback is unregistered", () => {
    const cb = vi.fn();
    const unregister = timerCoordinator.register(5000, "ob1", cb);

    expect(timerCoordinator._activeGroupCount()).toBe(1);

    unregister();

    expect(timerCoordinator._activeGroupCount()).toBe(0);

    // Timer should be stopped — no callbacks fire
    vi.advanceTimersByTime(10000);
    expect(cb).not.toHaveBeenCalled();
  });

  it("should handle _reset clearing all timers", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    timerCoordinator.register(5000, "ob1", cb1);
    timerCoordinator.register(10000, "ob2", cb2);

    expect(timerCoordinator._activeGroupCount()).toBe(2);

    timerCoordinator._reset();

    expect(timerCoordinator._activeGroupCount()).toBe(0);

    vi.advanceTimersByTime(15000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });

  it("should handle re-registering the same id (replaces callback)", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    timerCoordinator.register(5000, "ob1", cb1);
    timerCoordinator.register(5000, "ob1", cb2); // Same id, different callback

    vi.advanceTimersByTime(5000);
    // The latest registered callback should be called
    expect(cb2).toHaveBeenCalledTimes(1);
    // Original callback should not be called since same id was overwritten
    expect(cb1).not.toHaveBeenCalled();
  });

  it("should cap groups at MAX_GROUPS and use standalone timer for overflow", () => {
    // Register 64 groups (MAX_GROUPS)
    const unregisters: (() => void)[] = [];
    for (let i = 1; i <= 64; i++) {
      unregisters.push(timerCoordinator.register(i * 1000, `id-${i}`, vi.fn()));
    }
    expect(timerCoordinator._activeGroupCount()).toBe(64);

    // 65th group should be standalone (not tracked in groups Map)
    const overflowCb = vi.fn();
    const unregOverflow = timerCoordinator.register(65_000, "overflow", overflowCb);
    expect(timerCoordinator._activeGroupCount()).toBe(64); // still 64

    // But the standalone timer should still work
    vi.advanceTimersByTime(65_000);
    expect(overflowCb).toHaveBeenCalledTimes(1);

    // Unregistering overflow should not affect groups Map
    unregOverflow();
    expect(timerCoordinator._activeGroupCount()).toBe(64);

    // Clean up
    for (const unreg of unregisters) unreg();
  });

  it("should allow registering in an existing group even when at MAX_GROUPS", () => {
    // Fill up to MAX_GROUPS
    const unregisters: (() => void)[] = [];
    for (let i = 1; i <= 64; i++) {
      unregisters.push(timerCoordinator.register(i * 1000, `id-${i}`, vi.fn()));
    }
    expect(timerCoordinator._activeGroupCount()).toBe(64);

    // Register into an existing group (same intervalMs=1000) should work normally
    const cb = vi.fn();
    const unreg = timerCoordinator.register(1000, "extra-in-existing", cb);
    expect(timerCoordinator._activeGroupCount()).toBe(64); // still 64

    vi.advanceTimersByTime(1000);
    expect(cb).toHaveBeenCalledTimes(1);

    unreg();
    // Clean up
    for (const u of unregisters) u();
  });

  it("should clean up standalone timers on _reset", () => {
    // Fill up to MAX_GROUPS
    const unregisters: (() => void)[] = [];
    for (let i = 1; i <= 64; i++) {
      unregisters.push(timerCoordinator.register(i * 1000, `id-${i}`, vi.fn()));
    }

    // Create standalone group (65th)
    const overflowCb = vi.fn();
    timerCoordinator.register(65_000, "overflow", overflowCb);

    // Reset should clean up ALL timers including standalone
    timerCoordinator._reset();

    // Standalone timer should no longer fire
    vi.advanceTimersByTime(65_000);
    expect(overflowCb).not.toHaveBeenCalled();
    expect(timerCoordinator._activeGroupCount()).toBe(0);
  });

  it("should return correct _activeGroupCount", () => {
    expect(timerCoordinator._activeGroupCount()).toBe(0);

    const unsub1 = timerCoordinator.register(1000, "a", () => {});
    expect(timerCoordinator._activeGroupCount()).toBe(1);

    const unsub2 = timerCoordinator.register(2000, "b", () => {});
    expect(timerCoordinator._activeGroupCount()).toBe(2);

    timerCoordinator.register(1000, "c", () => {});
    expect(timerCoordinator._activeGroupCount()).toBe(2); // same group as "a"

    unsub1();
    expect(timerCoordinator._activeGroupCount()).toBe(2); // "c" still in 1000ms group

    unsub2();
    expect(timerCoordinator._activeGroupCount()).toBe(1); // 2000ms group removed
  });
});
