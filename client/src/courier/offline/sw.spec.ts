import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

//the update gate: a new build applies itself at once, except while a report form holds it

const update = vi.fn(() => Promise.resolve());
let options: any = null;

vi.mock("virtual:pwa-register", () => ({
  registerSW(o: any) {
    options = o;
    return update;
  },
}));

import { holdUpdate, isUpdateReady, registerServiceWorker, resetSwForTests } from "./sw";

beforeEach(() => {
  resetSwForTests();
  update.mockClear();
  options = null;
  registerServiceWorker();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("service worker updates", () => {
  it("a new build with nothing on hold reloads at once, without asking", () => {
    options.onNeedRefresh();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(true);
    expect(isUpdateReady()).toBe(false);
  });

  it("a build that arrives while a form holds the update waits for the release", () => {
    const release = holdUpdate();
    options.onNeedRefresh();
    expect(update).not.toHaveBeenCalled();
    expect(isUpdateReady()).toBe(true);
    release();
    expect(update).toHaveBeenCalledTimes(1);
    expect(isUpdateReady()).toBe(false);
  });

  it("two holds: the update applies after the last one, and a double release counts once", () => {
    const a = holdUpdate();
    const b = holdUpdate();
    options.onNeedRefresh();
    a();
    a();
    expect(update).not.toHaveBeenCalled();
    b();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("a release with no build waiting does nothing", () => {
    const release = holdUpdate();
    release();
    expect(update).not.toHaveBeenCalled();
  });

  it("a failed activation keeps the build waiting for the next quiet moment", async () => {
    update.mockImplementationOnce(() => Promise.reject(new Error("no controller")));
    options.onNeedRefresh();
    await Promise.resolve();
    await Promise.resolve();
    expect(isUpdateReady()).toBe(true);
    const release = holdUpdate();
    release();
    expect(update).toHaveBeenCalledTimes(2);
  });
});
