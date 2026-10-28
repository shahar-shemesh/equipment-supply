import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteDB } from "idb";

import { ReportSyncState } from "../../../shared/@core";
import { SCOPE, fullForm, makeTask, setToken, snapshot } from "../test/fixtures";
import { DB_NAME, closeDb } from "../courier/offline/db";
import { closeChannel, listReports, readBoard, refresh, submitReport, updateReportSync } from "../courier/offline/store";
import ManagerLayout from "./ManagerLayout";

//the manager shell against the real data layer: the link to the courier screens for a two role account, and the sign
//out that sweeps what those screens stored under the manager's scope (the session ends first, like the courier's leave)

const mocks = vi.hoisted(() => ({
  user: { id: 7, username: "dana", name: "דנה לוי", email: null, roles: ["manager", "courier"], courier_id: 3 } as any,
  navigate: vi.fn(),
  logout: vi.fn(),
  order: [] as string[],
  seenAtLogout: null as Promise<any[]> | null,
  desktop: true,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
  NavLink: ({ children, to }: any) => createElement("a", { href: to }, children),
  Outlet: () => null,
}));
vi.mock("../utils/auth", () => ({ useAuth: () => ({ user: mocks.user, logout: mocks.logout }) }));
//the desktop header: nav and the user block inline, no drawer to open first. one test turns it off for the drawer
vi.mock("../utils/useBreakpoint", () => ({ useBreakpoint: () => ({ phone: !mocks.desktop, compact: !mocks.desktop, tablet: false, desktop: mocks.desktop }) }));

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  await closeDb();
  await deleteDB(DB_NAME);
  localStorage.clear();
  sessionStorage.clear();
  setToken({ sub: 7, exp: Math.floor(Date.now() / 1000) + 3600 });
  mocks.user = { id: 7, username: "dana", name: "דנה לוי", email: null, roles: ["manager", "courier"], courier_id: 3 };
  mocks.order = [];
  mocks.seenAtLogout = null;
  mocks.desktop = true;
  mocks.navigate.mockReset();
  //what the store holds the moment the session ends: read here, before the sweep's transaction can run
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
  closeChannel();
  await closeDb();
});

/*──────────────────────────────────────────────────────────────────────────*/

//what a visit to the courier screens leaves under the scope: a snapshot of two tasks, a report the server took and one
//it never saw
async function seed() {
  const tasks = [makeTask(1), makeTask(2)];
  await refresh(SCOPE, async () => snapshot(tasks));
  const synced = await submitReport(SCOPE, mocks.user, tasks[0], fullForm(tasks[0]));
  await updateReportSync(SCOPE, synced.operation_id, { state: ReportSyncState.synced });
  const queued = await submitReport(SCOPE, mocks.user, tasks[1], fullForm(tasks[1]));
  return { synced: synced.operation_id, queued: queued.operation_id };
}

async function render() {
  await act(async () => root.render(createElement(ManagerLayout)));
}

const courierLink = () => host.querySelector('.app-header__nav a[href="/courier"]');
const navLinks = () => Array.from(host.querySelectorAll<HTMLAnchorElement>(".app-header__nav a")).map((a) => a.getAttribute("href"));
const logoutButton = () => host.querySelector(".app-header__logout") as HTMLButtonElement | null;

/*──────────────────────────────────────────────────────────────────────────*/

describe("manager shell", () => {
  it("a two role account gets the link to the courier screens, a plain manager does not", async () => {
    await render();
    expect(courierLink()?.textContent).toBe("nav_courier_view");

    mocks.user = { ...mocks.user, roles: ["manager"], courier_id: null };
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(courierLink()).toBeNull();
  });

  it("the header names the five manager pages in order, the audit log between the rejected reports and the reports", async () => {
    await render();
    expect(navLinks()).toEqual(["/manager/issuances", "/manager/couriers", "/manager/conflicts", "/manager/audit", "/manager/reports", "/courier"]);
    expect(host.querySelector('.app-header__nav a[href="/manager/audit"]')?.textContent).toBe("nav_audit");
  });

  it("under the desktop width the same pages, the audit log included, sit in the drawer behind the hamburger", async () => {
    mocks.desktop = false;
    await render();
    expect(host.querySelector(".app-header__nav")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".app-header__menu-btn").click());
    //the drawer is a portal under the body, not under the host
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".manager-drawer__nav a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual(["/manager/issuances", "/manager/couriers", "/manager/conflicts", "/manager/audit", "/manager/reports", "/courier"]);
    expect(document.querySelector('.manager-drawer__nav a[href="/manager/audit"]')?.textContent).toBe("nav_audit");
  });

  it("sign out ends the session first, then sweeps the synced data of the manager's scope and keeps what the server never took", async () => {
    const { queued } = await seed();
    await render();

    await act(async () => logoutButton()?.click());
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.order).toEqual(["logout"]);
    //both reports were still there when the session ended; after the sweep only the queued one is, and no snapshot
    expect((await mocks.seenAtLogout).map((r) => r.sync.state).sort()).toEqual([ReportSyncState.queued, ReportSyncState.synced]);
    expect((await listReports(SCOPE)).map((r) => [r.operation_id, r.sync.state])).toEqual([[queued, ReportSyncState.queued]]);
    expect((await readBoard(SCOPE)).rows).toEqual([]);
  });

  it("without a courier row the link stays (the role opens the screens) and there is no scope: sign out touches nothing in the database", async () => {
    await seed();
    mocks.user = { ...mocks.user, courier_id: null };
    await render();
    expect(courierLink()).not.toBeNull();

    await act(async () => logoutButton()?.click());
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith("/login"));
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect((await listReports(SCOPE)).map((r) => r.sync.state).sort()).toEqual([ReportSyncState.queued, ReportSyncState.synced]);
    expect((await readBoard(SCOPE)).rows).toHaveLength(2);
  });
});
