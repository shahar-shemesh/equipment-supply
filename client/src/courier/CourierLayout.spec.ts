import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB } from "idb";

import { ReportSyncState } from "../../../shared/@core";
import { SCOPE, fullForm, makeTask, setToken, snapshot } from "../test/fixtures";
import { DB_NAME, closeDb } from "./offline/db";
import { closeChannel, listReports, refresh, submitReport, updateReportSync } from "./offline/store";
import CourierLayout from "./CourierLayout";

//the logout button against the real data layer: when a pass runs first, what the dialogs say, and the order of stop,
//session end and cleanup. the worker is a mock (the layout starts it with nothing to inject), the store is fake-indexeddb

const mocks = vi.hoisted(() => ({
  user: { id: 7, username: "dan", name: "דן משנע", email: null, roles: ["courier"], courier_id: 3 },
  rows: [] as any[],
  navigate: vi.fn(),
  logout: vi.fn(),
  refreshIdentity: vi.fn(),
  startSync: vi.fn(),
  stopSync: vi.fn(),
  flushForLogout: vi.fn(),
  //the worker's status says nothing is pending whatever the database holds: the layout must not decide by it
  status: { pending: 0, attention: 0, identity_lost: false } as any,
  order: [] as string[],
  seenAtLogout: null as Promise<any[]> | null,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate, Link: ({ children, to, className }: any) => createElement("a", { href: to, className }, children), Outlet: () => null }));
vi.mock("../utils/auth", () => ({ useAuth: () => ({ user: mocks.user, logout: mocks.logout, refreshIdentity: mocks.refreshIdentity }) }));
vi.mock("./components/SyncStatusBar", () => ({ SyncStatusBar: () => null }));
vi.mock("./offline/storage", () => ({ requestPersistentStorage: () => Promise.resolve(null) }));
vi.mock("./offline/sync", () => ({
  startSync: mocks.startSync,
  stopSync: mocks.stopSync,
  getSyncStatus: () => ({ ...mocks.status }),
  subscribeSync: () => () => {},
  flushForLogout: mocks.flushForLogout,
  //the store's background reads: the refresh on mount gets the seeded list back, so the snapshot stays what the test wrote
  offlineGet: () => Promise.resolve({ rows: mocks.rows, counts: { all: mocks.rows.length, pending: mocks.rows.length, done: 0 } }),
  noteBackgroundResult: () => {},
  kickSync: () => Promise.resolve(),
}));

let root: Root;
let host: HTMLDivElement;
let online = true;

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await closeDb();
  await deleteDB(DB_NAME);
  localStorage.clear();
  sessionStorage.clear();
  setToken({ sub: 7, exp: Math.floor(Date.now() / 1000) + 3600 });
  online = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  mocks.rows = [];
  mocks.order = [];
  mocks.seenAtLogout = null;
  mocks.user = { id: 7, username: "dan", name: "דן משנע", email: null, roles: ["courier"], courier_id: 3 };
  mocks.navigate.mockReset();
  mocks.refreshIdentity.mockReset().mockResolvedValue(null);
  mocks.status = { pending: 0, attention: 0, identity_lost: false } as any;
  mocks.flushForLogout.mockReset();
  mocks.startSync.mockReset().mockResolvedValue(undefined);
  mocks.stopSync.mockReset().mockImplementation(() => mocks.order.push("stop"));
  //what the reports store holds the moment the session ends: read here, before the cleanup's transaction can run
  mocks.logout.mockReset().mockImplementation(() => {
    mocks.order.push("logout");
    mocks.seenAtLogout = listReports(SCOPE);
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (navigator as any).onLine;
  closeChannel();
  await closeDb();
});

/*──────────────────────────────────────────────────────────────────────────*/

//a snapshot of one task per state and a report in that state for each
async function seed(states: ReportSyncState[]) {
  const tasks = states.map((_, i) => makeTask(i + 1));
  mocks.rows = tasks;
  await refresh(SCOPE, async () => snapshot(tasks));
  const ids: string[] = [];
  for (let i = 0; i < states.length; i++) {
    const r = await submitReport(SCOPE, mocks.user as any, tasks[i], fullForm(tasks[i]));
    if (states[i] !== ReportSyncState.queued) await updateReportSync(SCOPE, r.operation_id, { state: states[i] });
    ids.push(r.operation_id);
  }
  return ids;
}

async function render() {
  await act(async () => root.render(createElement(CourierLayout)));
}

async function click(button: Element | null | undefined) {
  expect(button).toBeTruthy();
  await act(async () => (button as HTMLButtonElement).click());
}

const headerLogout = () => host.querySelector(".app-header__logout");
const managerLink = () => host.querySelector(".app-header__link");
//the dialogs render in a portal under body; one is open at a time
const dialog = () => document.querySelector(".confirm-dialog");
const dialogButton = (label: string) => Array.from(dialog()?.querySelectorAll("button") || []).find((b) => b.textContent === label);
const states = async () => (await listReports(SCOPE)).map((r) => r.sync.state);

/*──────────────────────────────────────────────────────────────────────────*/

describe("courier logout", () => {
  it("online under a fresh token a pass runs first, then the worker stops, the session ends with the count, and only the server's copies leave", async () => {
    const [, queued] = await seed([ReportSyncState.synced, ReportSyncState.queued]);
    mocks.flushForLogout.mockImplementation(async () => {
      mocks.order.push("flush");
      await updateReportSync(SCOPE, queued, { state: ReportSyncState.synced });
      return { sent: 1, pending: 0, attention: 0 };
    });
    await render();

    await click(headerLogout());
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.order).toEqual(["flush", "stop", "logout"]);
    expect(mocks.logout).toHaveBeenCalledWith({ reason: "logout", sent: 1 });
    //the cleanup came after the session ended: both rows were still there at that moment, none is now
    expect((await mocks.seenAtLogout).map((r) => r.sync.state)).toEqual([ReportSyncState.synced, ReportSyncState.synced]);
    expect(await states()).toEqual([]);
    //the syncing dialog leaves with its exit transition
    await vi.waitFor(() => expect(dialog()).toBeNull());
  });

  it("offline no pass runs: the plain dialog, and after the confirm the queue is still on the device", async () => {
    online = false;
    const [, queued] = await seed([ReportSyncState.synced, ReportSyncState.queued]);
    await render();

    await click(headerLogout());
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("logout_pending_work"));
    expect(dialog()?.textContent).not.toContain("logout_sync_incomplete");
    expect(mocks.flushForLogout).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();

    await click(dialogButton("logout"));
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.order).toEqual(["stop", "logout"]);
    expect(mocks.logout).toHaveBeenCalledWith({ reason: "logout", sent: 0 });
    expect((await listReports(SCOPE)).map((r) => [r.operation_id, r.sync.state])).toEqual([[queued, ReportSyncState.queued]]);
  });

  it("a pass that leaves reports to send says so above the count, and cancel stays logged in with everything in place", async () => {
    await seed([ReportSyncState.queued, ReportSyncState.queued]);
    mocks.flushForLogout.mockResolvedValue({ sent: 1, pending: 1, attention: 0 });
    await render();

    await click(headerLogout());
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("logout_pending_work"));
    expect(dialog()?.textContent).toContain("logout_sync_incomplete");

    await click(dialogButton("cancel"));
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(mocks.stopSync).not.toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(await states()).toEqual([ReportSyncState.queued, ReportSyncState.queued]);
  });

  it("rejected reports alone ride the pass for their evidence, do not count as incomplete, and stay through the logout", async () => {
    await seed([ReportSyncState.conflict]);
    mocks.flushForLogout.mockResolvedValue({ sent: 0, pending: 0, attention: 1 });
    await render();

    await click(headerLogout());
    await vi.waitFor(() => expect(dialog()?.textContent).toContain("logout_pending_work"));
    expect(dialog()?.textContent).not.toContain("logout_sync_incomplete");
    expect(mocks.flushForLogout).toHaveBeenCalledTimes(1);

    await click(dialogButton("logout"));
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.logout).toHaveBeenCalledWith({ reason: "logout", sent: 0 });
    expect(await states()).toEqual([ReportSyncState.conflict]);
  });

  it("with nothing on the device it leaves at once", async () => {
    await seed([]);
    await render();
    //a courier holds no other screen to go to
    expect(managerLink()).toBeNull();

    await click(headerLogout());
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.flushForLogout).not.toHaveBeenCalled();
    expect(mocks.order).toEqual(["stop", "logout"]);
    expect(mocks.logout).toHaveBeenCalledWith({ reason: "logout", sent: 0 });
    expect(dialog()).toBeNull();
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("a manager on the courier screens", () => {
  it("sees the link back to the board next to the logout", async () => {
    mocks.user = { ...mocks.user, roles: ["manager", "courier"] } as any;
    try {
      await seed([]);
      await render();
      expect(managerLink()?.getAttribute("href")).toBe("/manager/issuances");
      expect(managerLink()?.textContent).toBe("nav_manager_view");
      expect(host.querySelector(".courier-no-identity")).toBeNull();
    } finally {
      mocks.user = { ...mocks.user, roles: ["courier"] } as any;
    }
  });

  it("without a courier row the screens open with the notice in place of the board, the queue of the row it held is named, and no worker starts", async () => {
    //what the account signed under its previous row is still on the device
    await seed([ReportSyncState.queued]);
    const before = mocks.user;
    mocks.user = { ...mocks.user, roles: ["manager", "courier"], courier_id: null } as any;
    try {
      await render();
      expect(host.querySelector(".courier-no-identity .MuiAlert-root")?.textContent).toBe("courier_no_identity courier_no_identity_manager");
      await vi.waitFor(() => expect(host.querySelector(".courier-no-identity")?.textContent).toContain("sync_other_account_one"));
      expect(managerLink()).not.toBeNull();
      expect(mocks.startSync).not.toHaveBeenCalled();
      expect(mocks.refreshIdentity).not.toHaveBeenCalled();
      //sign out with no scope leaves at once, nothing to flush or sweep
      await click(headerLogout());
      await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
      expect(mocks.logout).toHaveBeenCalledWith({ reason: "logout", sent: 0 });
    } finally {
      mocks.user = before;
    }
  });

  it("a request that said the account lost its courier row makes the shell ask /auth/me again; the same row back restarts the worker once", async () => {
    mocks.status = { pending: 1, attention: 0, identity_lost: true } as any;
    mocks.refreshIdentity.mockResolvedValue(mocks.user);
    await seed([]);
    await render();
    //the mount's start, then the one restart after the answer
    await vi.waitFor(() => expect(mocks.startSync).toHaveBeenCalledTimes(2));
    expect(mocks.refreshIdentity).toHaveBeenCalledTimes(1);
    expect(mocks.startSync.mock.calls.map((c) => c[0])).toEqual([SCOPE, SCOPE]);
  });

  it("a row changed by /auth/me moves the scope: the old worker stops, a new one starts under the new row, no row ends in the notice", async () => {
    await seed([]);
    await render();
    expect(mocks.startSync).toHaveBeenLastCalledWith(SCOPE, expect.anything());

    mocks.user = { ...mocks.user, courier_id: 9 } as any;
    await render();
    expect(mocks.order).toEqual(["stop"]);
    expect(mocks.startSync).toHaveBeenCalledTimes(2);
    expect(mocks.startSync).toHaveBeenLastCalledWith("7:9", expect.anything());
    expect(host.querySelector(".courier-no-identity")).toBeNull();

    mocks.user = { ...mocks.user, courier_id: null } as any;
    await render();
    expect(mocks.order).toEqual(["stop", "stop"]);
    expect(mocks.startSync).toHaveBeenCalledTimes(2);
    expect(host.querySelector(".courier-no-identity")).not.toBeNull();
  });

  it("a failed /auth/me after a lost identity leaves the worker idle", async () => {
    mocks.status = { pending: 1, attention: 0, identity_lost: true } as any;
    mocks.refreshIdentity.mockRejectedValue(new Error("offline"));
    await seed([]);
    await render();
    await vi.waitFor(() => expect(mocks.refreshIdentity).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.startSync).toHaveBeenCalledTimes(1);
  });
});
