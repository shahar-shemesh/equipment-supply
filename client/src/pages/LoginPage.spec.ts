import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthMode, MockIdentity, UserRole } from "../../../shared/@core";
import { courierUser } from "../test/fixtures";
import LoginPage from "./LoginPage";

//the page's branch on the server's mode: the two identity buttons in mock mode and which identity each sends, the
//boundary message in cognito mode, and the two states before an answer. the provider behind useAuth is a mock

const managerUser = { id: 1, username: "manager", name: "דנה לוי", email: "manager@equipment.local", roles: [UserRole.manager, UserRole.courier], courier_id: 6 };

const mocks = vi.hoisted(() => ({
  auth: { user: null as any, mode: null as any, modeError: false, signIn: vi.fn() },
  navigate: vi.fn(),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("../utils/auth", () => ({
  useAuth: () => mocks.auth,
  homeOf: (u: any) => (u?.roles?.includes("manager") ? "/manager/issuances" : "/courier"),
}));
vi.mock("../courier/offline/useCourierData", () => ({ useOtherAccountsWork: () => ({ data: [] }) }));
vi.mock("../components/Logo", () => ({ Logo: () => null }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  mocks.auth = { user: null, mode: null, modeError: false, signIn: vi.fn() };
  mocks.navigate.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

/*──────────────────────────────────────────────────────────────────────────*/

async function render() {
  await act(async () => root.render(createElement(LoginPage)));
}

const buttons = () => Array.from(host.querySelectorAll(".login-card__identities button")) as HTMLButtonElement[];
const text = () => host.textContent || "";

/*──────────────────────────────────────────────────────────────────────────*/

describe("login page", () => {
  it("before the mode is known a loading line, when the server is unreachable the error, no button either way", async () => {
    await render();
    expect(text()).toContain("login_mode_loading");
    expect(buttons()).toHaveLength(0);

    mocks.auth = { ...mocks.auth, modeError: true };
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(text()).toContain("login_server_unreachable");
    expect(text()).not.toContain("login_mode_loading");
    expect(buttons()).toHaveLength(0);
  });

  it("mock mode: the banner and two buttons, each sending its own identity and landing on that user's home", async () => {
    mocks.auth = { ...mocks.auth, mode: AuthMode.mock };
    mocks.auth.signIn.mockImplementation(async ({ identity }: any) => (identity === MockIdentity.manager ? managerUser : courierUser));
    await render();
    expect(text()).toContain("login_mock_banner");
    expect(buttons().map((b) => b.textContent)).toEqual(["login_as_manager", "login_as_courier"]);

    await act(async () => buttons()[0].click());
    expect(mocks.auth.signIn).toHaveBeenLastCalledWith({ identity: MockIdentity.manager });
    expect(mocks.navigate).toHaveBeenLastCalledWith("/manager/issuances", { replace: true });

    await act(async () => buttons()[1].click());
    expect(mocks.auth.signIn).toHaveBeenLastCalledWith({ identity: MockIdentity.courier });
    expect(mocks.navigate).toHaveBeenLastCalledWith("/courier", { replace: true });
    expect(mocks.auth.signIn).toHaveBeenCalledTimes(2);
  });

  it("a refused sign in shows its message and stays on the page", async () => {
    mocks.auth = { ...mocks.auth, mode: AuthMode.mock };
    mocks.auth.signIn.mockRejectedValue(new Error("mock login refused"));
    await render();
    await act(async () => buttons()[1].click());
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(text()).toContain("mock login refused");
    expect(buttons()[1].disabled).toBe(false);
  });

  it("cognito mode: the boundary message and no button", async () => {
    mocks.auth = { ...mocks.auth, mode: AuthMode.cognito };
    await render();
    expect(text()).toContain("login_cognito_missing");
    expect(text()).not.toContain("login_mock_banner");
    expect(buttons()).toHaveLength(0);
  });

  it("a signed in person is sent home, no button pressed", async () => {
    mocks.auth = { ...mocks.auth, mode: AuthMode.mock, user: courierUser };
    await render();
    expect(mocks.navigate).toHaveBeenCalledWith("/courier", { replace: true });
  });
});
