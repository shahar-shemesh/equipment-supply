import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IAuthUser, MockIdentity, UserRole } from "../../../shared/@core";
import { courierUser, makeToken, setToken } from "../test/fixtures";
import { AuthProvider, useAuth } from "./auth";
import { takeSessionEnd, TOKEN_KEY, USER_KEY } from "./service";

//the provider's end of the 12 hour token: a stored session ends at exp with the note for the login page, a sign in arms
//the watcher again for its own token, a logout by hand disarms it. and the session itself: the mode comes from the
//server, a sign in stores what the mode's provider answered, a switch of identity replaces it, cognito refuses

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("./service", async (importOriginal) => ({ ...(await importOriginal<any>()), post: mocks.post, get: mocks.get }));

const T = Date.parse("2026-09-28T10:00:00.000Z");
const HOUR = 3600_000;

const managerUser: IAuthUser = { id: 1, username: "manager", name: "דנה לוי", email: "manager@equipment.local", roles: [UserRole.manager, UserRole.courier], courier_id: 6 };

let root: Root;
let host: HTMLDivElement;
const probe: { signIn: AuthApi["signIn"] | null; logout: AuthApi["logout"] | null; refreshIdentity: AuthApi["refreshIdentity"] | null } = { signIn: null, logout: null, refreshIdentity: null };
type AuthApi = ReturnType<typeof useAuth>;

function Probe() {
  const { user, mode, modeError, signIn, logout, refreshIdentity } = useAuth();
  probe.signIn = signIn;
  probe.logout = logout;
  probe.refreshIdentity = refreshIdentity;
  return createElement("span", null, createElement("span", { id: "user" }, user ? String(user.id) : "none"), createElement("span", { id: "mode" }, mode ?? (modeError ? "error" : "loading")));
}

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(T);
  localStorage.clear();
  sessionStorage.clear();
  mocks.post.mockReset();
  mocks.get.mockReset().mockResolvedValue({ mode: "mock" });
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
const modeShown = () => host.querySelector("#mode")?.textContent;

async function render() {
  await act(async () => root.render(createElement(AuthProvider, null, createElement(Probe))));
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

async function signIn(identity: MockIdentity) {
  await act(async () => {
    await probe.signIn({ identity });
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

  it("a sign in arms the watcher for its own token, a logout by hand disarms it and leaves its own note", async () => {
    await render();
    expect(shown()).toBe("none");
    expect(modeShown()).toBe("mock");
    const exp = Math.floor(T / 1000) + 2 * 3600;
    mocks.post.mockResolvedValue({ token: makeToken({ sub: 7, exp }), user: courierUser });
    await signIn(MockIdentity.courier);
    expect(shown()).toBe("7");
    expect(localStorage.getItem(TOKEN_KEY)).toBe(makeToken({ sub: 7, exp }));

    await advance(2 * HOUR - 1);
    expect(shown()).toBe("7");
    await advance(1);
    expect(shown()).toBe("none");
    expect(takeSessionEnd()).toEqual({ reason: "expired" });

    //again, this time the courier leaves before exp: the watcher is gone with the session, the timer writes no note over it
    await signIn(MockIdentity.courier);
    expect(shown()).toBe("7");
    await act(async () => probe.logout({ reason: "logout", sent: 2 }));
    expect(shown()).toBe("none");
    await advance(3 * HOUR);
    expect(takeSessionEnd()).toEqual({ reason: "logout", sent: 2 });
    expect(takeSessionEnd()).toBeNull();
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("AuthProvider and the session", () => {
  it("the mode is the server's answer, asked once; a failed request shows as unreachable and is asked again when the network returns", async () => {
    mocks.get.mockReset().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce({ mode: "mock" });
    await render();
    expect(modeShown()).toBe("error");
    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(mocks.get).toHaveBeenCalledWith("/auth/mode");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(modeShown()).toBe("mock");
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it("manager in, out, courier in: the storage ends with the courier's token and user only", async () => {
    const managerToken = makeToken({ sub: 1, courier_id: 6, username: "manager" });
    const courierToken = makeToken({ sub: 7 });
    mocks.post.mockResolvedValueOnce({ token: managerToken, user: managerUser }).mockResolvedValueOnce({ token: courierToken, user: courierUser });
    await render();

    await signIn(MockIdentity.manager);
    expect(shown()).toBe("1");
    expect(localStorage.getItem(TOKEN_KEY)).toBe(managerToken);
    expect(JSON.parse(localStorage.getItem(USER_KEY))).toEqual(managerUser);

    await act(async () => probe.logout());
    expect(shown()).toBe("none");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();

    await signIn(MockIdentity.courier);
    expect(shown()).toBe("7");
    expect(localStorage.getItem(TOKEN_KEY)).toBe(courierToken);
    expect(JSON.parse(localStorage.getItem(USER_KEY))).toEqual(courierUser);
    expect(localStorage.length).toBe(2);
    //the server got the identity key and nothing else, both times
    expect(mocks.post.mock.calls).toEqual([["/auth/mock/login", { identity: "manager" }], ["/auth/mock/login", { identity: "courier" }]]);
  });

  it("a server answer that is not a session (no token, or a roles list the routes do not know) stores nothing", async () => {
    mocks.post.mockResolvedValueOnce({ user: courierUser }).mockResolvedValueOnce({ token: makeToken({ sub: 9 }), user: { ...courierUser, id: 9, roles: ["auditor"] } });
    await render();
    await expect(probe.signIn({ identity: MockIdentity.courier })).rejects.toThrow("not a session");
    await expect(probe.signIn({ identity: MockIdentity.courier })).rejects.toThrow("not a session");
    expect(shown()).toBe("none");
    expect(localStorage.length).toBe(0);
  });

  it("in cognito mode a sign in is refused before any request and nothing is stored", async () => {
    mocks.get.mockReset().mockResolvedValue({ mode: "cognito" });
    await render();
    expect(modeShown()).toBe("cognito");

    await expect(probe.signIn({ identity: MockIdentity.manager })).rejects.toThrow(/docs\/auth\.md/);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(shown()).toBe("none");
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });

  it("another tab's sign in and sign out reach this tab through the storage event; an old shape written there reads as no user and is left alone", async () => {
    await render();
    expect(shown()).toBe("none");

    //the other tab signed in: this tab follows without a request of its own
    localStorage.setItem(USER_KEY, JSON.stringify(courierUser));
    setToken({ sub: 7, exp: Math.floor(T / 1000) + 3600 });
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: USER_KEY }));
    });
    expect(shown()).toBe("7");
    expect(mocks.post).not.toHaveBeenCalled();

    //the other tab signed out (clear() in storage fires the event with a null key)
    localStorage.clear();
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(shown()).toBe("none");

    //an old shape from the other tab: no user here, and the write is the other tab's to drop, not this one's
    const old = JSON.stringify({ id: 7, username: "dan", display_name: "דן משנע", role: "courier", courier_id: 3 });
    localStorage.setItem(USER_KEY, old);
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: USER_KEY }));
    });
    expect(shown()).toBe("none");
    expect(localStorage.getItem(USER_KEY)).toBe(old);
  });

  it("the identity follows /auth/me: a courier row linked or unlinked since the login replaces the stored user, a failed request or another account's answer keeps it", async () => {
    localStorage.setItem(USER_KEY, JSON.stringify(courierUser));
    setToken({ sub: 7, exp: Math.floor(T / 1000) + 3600 });
    //asked at mount, with the row the manager linked meanwhile
    mocks.get.mockReset().mockImplementation(async (path: string) => (path === "/auth/mode" ? { mode: "mock" } : { ...courierUser, courier_id: 9 }));
    await render();
    expect(mocks.get).toHaveBeenCalledWith("/auth/me");
    expect(JSON.parse(localStorage.getItem(USER_KEY)).courier_id).toBe(9);
    expect(shown()).toBe("7");

    //a failed request rejects and keeps the snapshot
    mocks.get.mockReset().mockRejectedValue(new Error("offline"));
    await act(async () => {
      await expect(probe.refreshIdentity()).rejects.toThrow("offline");
    });
    expect(JSON.parse(localStorage.getItem(USER_KEY)).courier_id).toBe(9);

    //the row was unlinked
    mocks.get.mockReset().mockResolvedValue({ ...courierUser, courier_id: null });
    await act(async () => {
      await probe.refreshIdentity();
    });
    expect(JSON.parse(localStorage.getItem(USER_KEY)).courier_id).toBeNull();

    //an answer for another account, or one that is not a session, changes nothing
    mocks.get.mockReset().mockResolvedValueOnce({ ...courierUser, id: 8, courier_id: 4 }).mockResolvedValueOnce({ mode: "mock" });
    await act(async () => {
      await probe.refreshIdentity();
      await probe.refreshIdentity();
    });
    expect(JSON.parse(localStorage.getItem(USER_KEY))).toMatchObject({ id: 7, courier_id: null });
    expect(localStorage.getItem(TOKEN_KEY)).toBeTruthy();

    //the network comes back: asked again without anyone pressing anything (the tablet that opened offline)
    mocks.get.mockReset().mockResolvedValue({ ...courierUser, courier_id: 11 });
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(mocks.get).toHaveBeenCalledWith("/auth/me");
    expect(JSON.parse(localStorage.getItem(USER_KEY)).courier_id).toBe(11);
  });

  it("an answer that lands after a logout, or after another account signed in, is not written", async () => {
    localStorage.setItem(USER_KEY, JSON.stringify(courierUser));
    setToken({ sub: 7, exp: Math.floor(T / 1000) + 3600 });
    let answer: (v: any) => void = () => {};
    mocks.get.mockReset().mockImplementation((path: string) => (path === "/auth/mode" ? Promise.resolve({ mode: "mock" }) : new Promise((res) => (answer = res))));
    await render();
    expect(shown()).toBe("7");

    //the mount's request is still out when the courier signs out
    await act(async () => probe.logout());
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    await act(async () => {
      answer({ ...courierUser, courier_id: 9 });
    });
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(shown()).toBe("none");

    //and with another account signed in meanwhile, the late answer of the first one changes nothing
    localStorage.setItem(USER_KEY, JSON.stringify(courierUser));
    setToken({ sub: 7, exp: Math.floor(T / 1000) + 3600 });
    const pending = probe.refreshIdentity();
    localStorage.setItem(USER_KEY, JSON.stringify(managerUser));
    await act(async () => {
      answer({ ...courierUser, courier_id: 9 });
      await pending;
    });
    expect(JSON.parse(localStorage.getItem(USER_KEY))).toEqual(managerUser);
  });

  it("a session stored before the roles existed reads as no user and is dropped with its token", async () => {
    localStorage.setItem(USER_KEY, JSON.stringify({ id: 7, username: "dan", display_name: "דן משנע", role: "courier", courier_id: 3 }));
    setToken({ sub: 7, exp: Math.floor(T / 1000) + 3600 });
    await render();
    expect(shown()).toBe("none");
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    //no note: nothing ended, the person simply signs in again
    expect(takeSessionEnd()).toBeNull();
  });
});
