import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeToken, setToken } from "../../test/fixtures";
import { TOKEN_KEY } from "../../utils/service";
import { watchTokenExpiry } from "./identity";

//the client side end of the session: the watcher fires once at exp, or on the first focus after it, and never for a
//token that is still fresh or does not expire

const T = Date.parse("2026-09-28T10:00:00.000Z");
const HOUR = 3600_000;
const exp = Math.floor(T / 1000) + 3600;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T);
  localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  vi.useRealTimers();
  delete (document as any).visibilityState;
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("watchTokenExpiry", () => {
  it("fires once at exp and not again on the focus after it", () => {
    setToken({ sub: 7, exp });
    const onExpired = vi.fn();
    watchTokenExpiry(onExpired);
    vi.advanceTimersByTime(HOUR - 1);
    expect(onExpired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpired).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(HOUR);
    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it("fires on focus or on becoming visible after exp when the timer never ran (the tablet slept through it)", () => {
    setToken({ sub: 7, exp });
    const onExpired = vi.fn();
    //the clock the watcher reads moves past exp while no timer fires, which is what a device waking from sleep looks like
    const now = vi.fn(() => T);
    watchTokenExpiry(onExpired, now);
    window.dispatchEvent(new Event("focus"));
    expect(onExpired).not.toHaveBeenCalled();
    now.mockReturnValue(T + HOUR);
    window.dispatchEvent(new Event("focus"));
    expect(onExpired).toHaveBeenCalledTimes(1);

    //the same through visibilitychange, and only when the page is the visible one
    const onVisible = vi.fn();
    watchTokenExpiry(onVisible, now);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onVisible).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onVisible).toHaveBeenCalledTimes(1);
  });

  it("never fires for a fresh token, a token without exp, or no token at all", () => {
    setToken({ sub: 7, exp });
    const onExpired = vi.fn();
    watchTokenExpiry(onExpired);
    vi.advanceTimersByTime(HOUR / 2);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onExpired).not.toHaveBeenCalled();

    //no exp: nothing to wait for, however long the page stays open
    localStorage.setItem(TOKEN_KEY, makeToken({ sub: 7, exp: undefined }));
    const never = vi.fn();
    watchTokenExpiry(never);
    vi.advanceTimersByTime(1000 * HOUR);
    window.dispatchEvent(new Event("focus"));
    expect(never).not.toHaveBeenCalled();

    localStorage.removeItem(TOKEN_KEY);
    watchTokenExpiry(never);
    vi.advanceTimersByTime(HOUR);
    window.dispatchEvent(new Event("focus"));
    expect(never).not.toHaveBeenCalled();
  });

  it("dispose cancels the timer and the listeners", () => {
    setToken({ sub: 7, exp });
    const onExpired = vi.fn();
    const dispose = watchTokenExpiry(onExpired);
    dispose();
    vi.advanceTimersByTime(2 * HOUR);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(onExpired).not.toHaveBeenCalled();
    //a second dispose is a no-op
    dispose();
  });
});
