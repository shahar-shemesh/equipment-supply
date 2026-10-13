import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { courierUser, makeToken, setToken } from "../test/fixtures";
import { AuthProvider, useAuth } from "./auth";
import { takeSessionEnd, TOKEN_KEY, USER_KEY } from "./service";

//the provider's end of the 12 hour token: a stored session ends at exp with the note for the login page, a login arms
//the watcher again for its own token, a logout by hand disarms it

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("./service", async (importOriginal) => ({ ...(await importOriginal<any>()), post: mocks.post }));

const T = Date.parse("2026-09-28T10:00:00.000Z");
const HOUR = 3600_000;

let root: Root;
let host: HTMLDivElement;
const probe: { login: AuthApi["login"] | null; logout: AuthApi["logout"] | null } = { login: null, logout: null };
type AuthApi = ReturnType<typeof useAuth>;

function Probe() {
  const { user, login, logout } = useAuth();
  probe.login = login;
  probe.logout = logout;
  return createElement("span", { id: "user" }, user ? String(user.id) : "none");
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(T);
  localStorage.clear();
  sessionStorage.clear();
  mocks.post.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
});

/*──────────────────────────────────────────────────────────────────────────*/

const shown = () => host.querySelector("#user")?.textContent;

async function render() {
  await act(async () => root.render(createElement(AuthProvider, null, createElement(Probe))));
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

/*──────────────────────────────────────────────────────────────────────────*/

describe("AuthProvider and the token expiry", () => {
  it("a stored session ends at exp: no user, no keys, and the note says expired", async () => {
    localStorage.setItem(USER_KEY, JSON.stringify(courierUser));
    setToken({ sub: 7, exp: Math.floor(T / 1000) + 3600 });
    await render();
    expect(shown()).toBe("7");

    await advance(HOUR - 1);
    expect(shown()).toBe("7");
    expect(localStorage.getItem(TOKEN_KEY)).toBeTruthy();
    await advance(1);
    expect(shown()).toBe("none");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(takeSessionEnd()).toEqual({ reason: "expired" });
  });

  it("a session already past exp when the page opens ends on the first tick", async () => {
    localStorage.setItem(USER_KEY, JSON.stringify(courierUser));
    setToken({ sub: 7, exp: Math.floor(T / 1000) - 60 });
    await render();
    await advance(0);
    expect(shown()).toBe("none");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(takeSessionEnd()).toEqual({ reason: "expired" });
  });

  it("a login arms the watcher for its own token, a logout by hand disarms it and leaves its own note", async () => {
    await render();
    expect(shown()).toBe("none");
    const exp = Math.floor(T / 1000) + 2 * 3600;
    mocks.post.mockResolvedValue({ token: makeToken({ sub: 7, exp }), user: { id: 7, ...courierUser } });
    await act(async () => {
      await probe.login("dan", "1234");
    });
    expect(shown()).toBe("7");
    expect(localStorage.getItem(TOKEN_KEY)).toBe(makeToken({ sub: 7, exp }));

    await advance(2 * HOUR - 1);
    expect(shown()).toBe("7");
    await advance(1);
    expect(shown()).toBe("none");
    expect(takeSessionEnd()).toEqual({ reason: "expired" });

    //again, this time the courier leaves before exp: the watcher is gone with the session, the timer writes no note over it
    await act(async () => {
      await probe.login("dan", "1234");
    });
    expect(shown()).toBe("7");
    await act(async () => probe.logout({ reason: "logout", sent: 2 }));
    expect(shown()).toBe("none");
    await advance(3 * HOUR);
    expect(takeSessionEnd()).toEqual({ reason: "logout", sent: 2 });
    expect(takeSessionEnd()).toBeNull();
  });
});
