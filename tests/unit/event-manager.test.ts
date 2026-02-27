import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initEventManager, registerEventHandler } from "../../src/cache/event-manager.ts";

// ═══════════════════════════════════════════════════════════════
// T038: EventManager unit tests
// ═══════════════════════════════════════════════════════════════

describe("T038: EventManager", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── SSR guard ───

  describe("SSR guard", () => {
    it("should return noop cleanup when window is undefined (SSR)", () => {
      const originalWindow = globalThis.window;
      // @ts-expect-error -- simulate SSR
      delete globalThis.window;

      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      // Should not throw
      expect(cleanup).toBeTypeOf("function");
      cleanup();
      expect(handler).not.toHaveBeenCalled();

      globalThis.window = originalWindow;
    });
  });

  // ─── Focus handler with 100ms debounce ───

  describe("focus handler with debounce", () => {
    it("should call handler on window focus event", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);

      expect(handler).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it("should call handler on document visibilitychange when visible", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      // Simulate becoming visible
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(100);

      expect(handler).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it("should NOT call handler on visibilitychange when hidden", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      Object.defineProperty(document, "visibilityState", {
        value: "hidden",
        writable: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(100);

      expect(handler).not.toHaveBeenCalled();
      cleanup();
    });

    it("should debounce rapid focus events within 100ms", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      // Fire focus multiple times rapidly
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(30);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(30);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);

      // Should only call handler once due to debounce
      expect(handler).toHaveBeenCalledTimes(1);
      cleanup();
    });

    it("should call handler again after debounce period", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus"], handler);

      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(1);

      // Wait and fire again
      vi.advanceTimersByTime(50);
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(2);
      cleanup();
    });
  });

  // ─── Online/reconnect handler ───

  describe("online reconnect handler", () => {
    it("should call handler on window online event", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["reconnect"], handler);

      window.dispatchEvent(new Event("online"));

      expect(handler).toHaveBeenCalledTimes(1);
      cleanup();
    });
  });

  // ─── Combined triggers ───

  describe("combined triggers", () => {
    it("should register both focus and reconnect handlers", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus", "reconnect"], handler);

      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);
      expect(handler).toHaveBeenCalledTimes(1);

      window.dispatchEvent(new Event("online"));
      expect(handler).toHaveBeenCalledTimes(2);

      cleanup();
    });

    it("should not register handlers for empty triggers array", () => {
      const handler = vi.fn();
      const cleanup = initEventManager([], handler);

      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);
      window.dispatchEvent(new Event("online"));

      expect(handler).not.toHaveBeenCalled();
      cleanup();
    });
  });

  // ─── Cleanup ───

  describe("cleanup", () => {
    it("should remove all event listeners on cleanup", () => {
      const handler = vi.fn();
      const cleanup = initEventManager(["focus", "reconnect"], handler);

      cleanup();

      // Events should no longer trigger handler
      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);
      window.dispatchEvent(new Event("online"));

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ─── registerEventHandler ───

  describe("registerEventHandler", () => {
    it("should register a custom handler and return cleanup", () => {
      const handler = vi.fn();
      const cleanup = registerEventHandler("focus", handler);

      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);

      expect(handler).toHaveBeenCalledTimes(1);

      cleanup();

      window.dispatchEvent(new Event("focus"));
      vi.advanceTimersByTime(100);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("should register reconnect handler", () => {
      const handler = vi.fn();
      const cleanup = registerEventHandler("reconnect", handler);

      window.dispatchEvent(new Event("online"));
      expect(handler).toHaveBeenCalledTimes(1);

      cleanup();
    });
  });
});
