import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncStatusBar } from "./SyncStatusBar";

//the strip against a mocked status: what it says and what it lets the courier press when the account lost its row

const mocks = vi.hoisted(() => ({
  status: { scope: "7:3", online: true, reachable: true, running: false, auth_required: false, identity_lost: false, pending: 0, attention: 0, last_sync_at: null, last_error: null } as any,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../../utils/auth", () => ({ useAuth: () => ({ user: { id: 7, username: "dan", name: "דן", email: null, roles: ["courier"], courier_id: 3 }, logout: vi.fn() }) }));
vi.mock("../offline/useCourierData", () => ({
  useSyncStatus: () => ({ data: mocks.status }),
  useBoard: () => ({ data: null }),
  useOtherAccountsWork: () => ({ data: [] }),
}));
vi.mock("../offline/store", () => ({ refresh: vi.fn(), clearSyncedData: vi.fn() }));
vi.mock("../offline/sync", () => ({ stopSync: vi.fn() }));
vi.mock("./PendingReportsDialog", () => ({ PendingReportsDialog: () => null }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.status = { ...mocks.status, identity_lost: false };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => root.render(createElement(SyncStatusBar)));
}

const refreshButton = () => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("offline_refresh")) as HTMLButtonElement | undefined;

describe("sync strip", () => {
  it("with the row in place the refresh is enabled and nothing says the identity is lost", async () => {
    await render();
    expect(refreshButton()?.disabled).toBe(false);
    expect(host.textContent).not.toContain("sync_identity_lost");
  });

  it("with the identity lost the chip says so and the refresh is disabled", async () => {
    mocks.status = { ...mocks.status, identity_lost: true };
    await render();
    expect(host.textContent).toContain("sync_identity_lost");
    expect(refreshButton()?.disabled).toBe(true);
  });
});
