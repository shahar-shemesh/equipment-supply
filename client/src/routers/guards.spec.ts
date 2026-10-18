import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IAuthUser, UserRole } from "../../../shared/@core";
import { HomeRedirect, RequireRole } from "./guards";

//the route guards against a memory router: where each kind of session lands when it opens /manager, /courier and the
//root. the auth context is a mock, homeOf is the real one

const mocks = vi.hoisted(() => ({ user: null as any }));
vi.mock("../utils/auth", async (importOriginal) => ({ ...(await importOriginal<any>()), useAuth: () => ({ user: mocks.user }) }));

const courier: IAuthUser = { id: 7, username: "dan", name: "דן משנע", email: null, roles: [UserRole.courier], courier_id: 3 };
const manager: IAuthUser = { id: 1, username: "manager", name: "דנה לוי", email: null, roles: [UserRole.manager, UserRole.courier], courier_id: 6 };

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.user = null;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  await unmount();
  host.remove();
});

async function unmount() {
  if (root) await act(async () => root.unmount());
  root = null;
}

/*──────────────────────────────────────────────────────────────────────────*/

//the same shape as AppRouter: a login page, the two guarded trees, and the catch all. a fresh root per path: a memory
//router already mounted keeps its history and ignores a new initialEntries
const where = (name: string) => createElement("span", { id: "where" }, name);

async function open(path: string) {
  await unmount();
  root = createRoot(host);
  const app = createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(
      Routes,
      null,
      createElement(Route, { path: "/login", element: where("login") }),
      createElement(Route, { path: "/manager/*", element: createElement(RequireRole, { role: UserRole.manager, children: where("manager") }) }),
      createElement(Route, { path: "/courier/*", element: createElement(RequireRole, { role: UserRole.courier, children: where("courier") }) }),
      createElement(Route, { path: "*", element: createElement(HomeRedirect) }),
    ),
  );
  await act(async () => root.render(app));
  return host.querySelector("#where")?.textContent;
}

/*──────────────────────────────────────────────────────────────────────────*/

describe("route guards", () => {
  it("without a session every path goes to the login page", async () => {
    expect(await open("/manager/issuances")).toBe("login");
    expect(await open("/courier")).toBe("login");
    expect(await open("/")).toBe("login");
  });

  it("a courier on a manager path lands on their own board", async () => {
    mocks.user = courier;
    expect(await open("/manager/issuances")).toBe("courier");
    expect(await open("/courier/tasks/5")).toBe("courier");
    expect(await open("/")).toBe("courier");
  });

  it("a manager holds both roles: the board is home and the courier screens open as well", async () => {
    mocks.user = manager;
    expect(await open("/manager/issuances")).toBe("manager");
    expect(await open("/courier")).toBe("courier");
    expect(await open("/")).toBe("manager");
  });

  it("a manager without a courier row has nothing on the courier screens: a typed /courier goes back to the board", async () => {
    mocks.user = { ...manager, courier_id: null };
    expect(await open("/courier")).toBe("manager");
    expect(await open("/manager/couriers")).toBe("manager");
  });
});
