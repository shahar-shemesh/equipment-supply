import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditAction, AuditActorType, AuditEntityType, IAuditEntry, UserRole } from "../../../../shared/@core";

const service = vi.hoisted(() => ({ get: vi.fn() }));
const mocks = vi.hoisted(() => ({ compact: false }));
//keys back, except the range line, whose numbers are what the cards' tests read
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, values?: any) => (values && "total" in values ? `${key}:${values.from}-${values.to}/${values.total}` : key) }) }));
vi.mock("../../utils/service", () => ({ get: service.get, errorMessage: (e: any) => String(e?.message || e) }));
//the desktop (the grid) unless a test asks for the cards
vi.mock("../../utils/useBreakpoint", () => ({ useBreakpoint: () => ({ phone: mocks.compact, compact: mocks.compact, tablet: false, desktop: !mocks.compact }) }));
//the grid package is esm with directory imports that vitest's node resolver refuses, and jsdom has no layout for it
//anyway. the stub draws what the page hands it and offers the three callbacks the page listens to
vi.mock("@mui/x-data-grid-premium", () => ({
  DataGridPremium: (props: any) => createElement(
    "div",
    { className: "grid-stub", "data-loading": String(!!props.loading), "data-page": props.paginationModel.page, "data-total": props.rowCount, "data-order": props.sortModel[0]?.sort },
    createElement("button", { type: "button", className: "stub-next", onClick: () => props.onPaginationModelChange({ page: props.paginationModel.page + 1, pageSize: props.paginationModel.pageSize }) }, "next"),
    createElement("button", { type: "button", className: "stub-asc", onClick: () => props.onSortModelChange([{ field: "at", sort: "asc" }]) }, "asc"),
    createElement("button", { type: "button", className: "stub-desc", onClick: () => props.onSortModelChange([{ field: "at", sort: "desc" }]) }, "desc"),
    props.rows.length === 0 && !props.loading ? createElement("div", { className: "stub-empty" }, props.localeText.noRowsLabel) : null,
    ...props.rows.map((r: any) => createElement("div", { key: r.id, className: "stub-row", onClick: () => props.onRowClick({ row: r }) }, props.columns.filter((c: any) => c.valueGetter).map((c: any) => c.valueGetter(undefined, r)).join(" | "))),
  ),
}));
vi.mock("@mui/x-data-grid-premium/locales", () => ({ heIL: { components: { MuiDataGrid: { defaultProps: { localeText: {} } } } } }));

import AuditPage from "./AuditPage";

//the audit page against a mocked api and a stub grid: the parameters of every request, what the grid is handed while a
//request runs and after it fails, the answer that arrives late, and the drawer a row opens

const edit: IAuditEntry = {
  id: 10, at: "2026-10-28T08:00:00.000Z", actor_type: AuditActorType.user, actor_user_id: 1, actor_username: "manager", actor_role: UserRole.manager,
  action: AuditAction.issuance_edit, entity_type: AuditEntityType.issuance, entity_id: 7, issuance_id: 7, batch_id: null,
  details: { changes: { priority: { from: "normal", to: "urgent" } } }, actor_name: "דנה לוי", issuance_number: "7000001", courier_name: null,
};
const login: IAuditEntry = { ...edit, id: 9, action: AuditAction.auth_login, entity_type: AuditEntityType.user, entity_id: 1, issuance_id: null, details: null, issuance_number: null };

const page = (items: IAuditEntry[], total = items.length) => ({ items, total });

function deferred<T>() {
  let resolve: (v: T) => void;
  let reject: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

//what the browser does when text is typed into the search box
function type(input: HTMLInputElement, value: string) {
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const calendar = () => document.querySelector<HTMLElement>("[role=dialog]");
const button = (within: ParentNode, text: string) => Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);

describe("AuditPage", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    service.get.mockReset();
    mocks.compact = false;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render() {
    await act(async () => root.render(createElement(AuditPage)));
  }

  const grid = () => host.querySelector<HTMLElement>(".grid-stub");
  const rows = () => Array.from(host.querySelectorAll<HTMLElement>(".stub-row"));
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
  const lastParams = () => service.get.mock.calls.at(-1)[1];
  const drawer = () => document.querySelector<HTMLElement>(".audit-drawer");

  it("opens on the first page of 25, newest first, with no filter, and hands the rows to the grid", async () => {
    service.get.mockResolvedValue(page([edit, login], 60));
    await render();
    expect(service.get).toHaveBeenCalledTimes(1);
    expect(service.get).toHaveBeenCalledWith("/audit", { order: "desc", page: 1, size: 25 });
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toContain("7000001");
    expect(grid().dataset.total).toBe("60");
    expect(grid().dataset.loading).toBe("false");
  });

  it("a page click sends page=2, a header sort sends order=asc from page 1 again, and a filter change goes back to page 1", async () => {
    service.get.mockResolvedValue(page([edit], 60));
    await render();

    await click(host.querySelector(".stub-next"));
    expect(lastParams()).toEqual({ order: "desc", page: 2, size: 25 });
    expect(grid().dataset.page).toBe("1");

    await click(host.querySelector(".stub-asc"));
    expect(lastParams()).toEqual({ order: "asc", page: 1, size: 25 });
    expect(grid().dataset.order).toBe("asc");

    await click(host.querySelector(".stub-next"));
    expect(lastParams()).toEqual({ order: "asc", page: 2, size: 25 });

    //the second header click: back to newest first, from page 1 again
    await click(host.querySelector(".stub-desc"));
    expect(lastParams()).toEqual({ order: "desc", page: 1, size: 25 });
    expect(grid().dataset.order).toBe("desc");
    await click(host.querySelector(".stub-asc"));

    await act(async () => type(host.querySelector<HTMLInputElement>("#audit-search"), "דנה"));
    await vi.waitFor(() => expect(lastParams()).toEqual({ q: "דנה", order: "asc", page: 1, size: 25 }));
    expect(grid().dataset.page).toBe("0");
  });

  it("marks the grid loading while a request runs and prints the empty text on an empty page", async () => {
    const first = deferred<any>();
    service.get.mockReturnValue(first.promise);
    await render();
    expect(grid().dataset.loading).toBe("true");
    expect(host.querySelector(".stub-empty")).toBeNull();

    await act(async () => first.resolve(page([])));
    expect(grid().dataset.loading).toBe("false");
    expect(host.querySelector(".stub-empty")?.textContent).toBe("audit_empty");
  });

  it("a failed request shows the error with a retry button and keeps the rows it had; the retry repeats the same request", async () => {
    service.get.mockResolvedValueOnce(page([edit, login], 2)).mockRejectedValueOnce(new Error("boom"));
    await render();
    expect(rows()).toHaveLength(2);

    await click(host.querySelector(".stub-next"));
    await vi.waitFor(() => expect(host.querySelector(".audit-page__error")?.textContent).toContain("boom"));
    expect(rows()).toHaveLength(2);
    expect(grid().dataset.loading).toBe("false");

    service.get.mockResolvedValueOnce(page([login], 1));
    await click(button(host.querySelector(".audit-page__error"), "audit_retry"));
    await vi.waitFor(() => expect(host.querySelector(".audit-page__error")).toBeNull());
    expect(lastParams()).toEqual({ order: "desc", page: 2, size: 25 });
    expect(rows()).toHaveLength(1);
  });

  it("two requests in flight: the answer of the older one is dropped when it arrives after the newer", async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    service.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render();
    await click(host.querySelector(".stub-asc"));
    expect(service.get).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(page([login], 1)));
    expect(rows().map((r) => r.textContent)).toHaveLength(1);
    expect(rows()[0].textContent).toContain("audit_action_auth_login");
    expect(grid().dataset.loading).toBe("false");

    await act(async () => first.resolve(page([edit, login], 2)));
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("audit_action_auth_login");
  });

  it("a row opens the drawer with the event and its changes table; the drawer's buttons set the chips and send the id", async () => {
    service.get.mockResolvedValue(page([edit, login], 2));
    await render();
    expect(drawer()).toBeNull();

    await click(rows()[0]);
    expect(drawer()?.textContent).toContain("audit_drawer_title");
    expect(drawer()?.textContent).toContain("audit_action_issuance_edit");
    const cells = Array.from(drawer().querySelectorAll(".audit-changes td")).map((td) => td.textContent);
    expect(cells).toEqual(["audit_field_priority", "priority_normal", "priority_urgent"]);
    //the raw row is there, folded
    const technical = drawer().querySelector<HTMLDetailsElement>(".audit-drawer__technical");
    expect(technical.open).toBe(false);
    expect(technical.querySelector("pre").textContent).toContain('"issuance_number": "7000001"');

    await click(button(drawer(), "audit_drawer_filter_issuance"));
    await vi.waitFor(() => expect(lastParams()).toEqual({ issuance_id: 7, order: "desc", page: 1, size: 25 }));
    expect(host.querySelector(".audit-filters__chip")?.textContent).toBe("audit_filter_issuance");
    await vi.waitFor(() => expect(drawer()).toBeNull());

    //the login row has no issuance: only the actor button
    await click(rows()[1]);
    expect(button(drawer(), "audit_drawer_filter_issuance")).toBeUndefined();
    await click(button(drawer(), "audit_drawer_filter_actor"));
    await vi.waitFor(() => expect(lastParams()).toEqual({ issuance_id: 7, actor_user_id: 1, order: "desc", page: 1, size: 25 }));
    expect(Array.from(host.querySelectorAll(".audit-filters__chip")).map((c) => c.textContent)).toEqual(["audit_filter_issuance", "audit_filter_actor"]);
  });

  it("a window that ends before it starts sends nothing until it is fixed", async () => {
    service.get.mockResolvedValue(page([edit], 1));
    await render();
    const opens = () => host.querySelectorAll<HTMLButtonElement>(".audit-filters__date button[title=open_calendar]");

    //from the 12th, to the 5th of the month the calendar opens on. the days travel as local midnights, the end exclusive
    await click(opens()[0]);
    await click(button(calendar(), "12"));
    expect(lastParams().from).toMatch(/-12T00:00:00[+-]\d{2}:\d{2}$/);
    const calls = service.get.mock.calls.length;
    await click(opens()[1]);
    await click(button(calendar(), "5"));
    expect(host.querySelector(".audit-filters__range-error")).not.toBeNull();
    expect(service.get).toHaveBeenCalledTimes(calls);

    //to the 20th: a valid window, one request with both ends
    await click(opens()[1]);
    await click(button(calendar(), "20"));
    expect(service.get).toHaveBeenCalledTimes(calls + 1);
    expect(lastParams().from).toMatch(/-12T00:00:00/);
    expect(lastParams().to).toMatch(/-21T00:00:00/);
    expect(host.querySelector(".audit-filters__range-error")).toBeNull();
    //three calendar popups: 1.5s on an idle machine, past the default 5s next to the server suite
  }, 15000);
});

/*──────────────────────────────────────────────────────────────────────────*/

//under 900px the same page draws cards instead of the grid: the range line with its two arrows and the order toggle
//above them, a card per event, a tap opens the drawer
describe("AuditPage under 900px", () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    service.get.mockReset();
    mocks.compact = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render() {
    await act(async () => root.render(createElement(AuditPage)));
  }

  const cards = () => Array.from(host.querySelectorAll<HTMLElement>(".audit-card"));
  const arrows = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".board__page-btn")); //[back, forward]
  const range = () => host.querySelector(".board__range span")?.textContent;
  const toggle = () => host.querySelector<HTMLButtonElement>(".audit-cards__order");
  const click = (el: Element | null | undefined) => act(async () => (el as HTMLElement).click());
  const lastParams = () => service.get.mock.calls.at(-1)[1];

  it("a card per event under the range line; the arrows page within the total and the toggle flips the order from page 1", async () => {
    service.get.mockResolvedValue(page([edit, login], 60));
    await render();
    expect(host.querySelector(".grid-stub")).toBeNull();
    expect(cards()).toHaveLength(2);
    expect(cards()[0].textContent).toContain("audit_action_issuance_edit");
    expect(cards()[0].textContent).toContain("7000001");
    expect(range()).toBe("audit_range:1-25/60");
    expect(arrows().map((b) => b.disabled)).toEqual([true, false]);

    await click(arrows()[1]);
    expect(lastParams()).toEqual({ order: "desc", page: 2, size: 25 });
    expect(range()).toBe("audit_range:26-50/60");
    expect(arrows().map((b) => b.disabled)).toEqual([false, false]);

    await click(arrows()[1]);
    expect(lastParams()).toEqual({ order: "desc", page: 3, size: 25 });
    expect(range()).toBe("audit_range:51-60/60");
    expect(arrows().map((b) => b.disabled)).toEqual([false, true]);

    await click(arrows()[0]);
    expect(lastParams()).toEqual({ order: "desc", page: 2, size: 25 });

    expect(toggle().textContent).toBe("audit_sort_newest");
    await click(toggle());
    expect(lastParams()).toEqual({ order: "asc", page: 1, size: 25 });
    expect(toggle().textContent).toBe("audit_sort_oldest");
    await click(toggle());
    expect(lastParams()).toEqual({ order: "desc", page: 1, size: 25 });
  });

  it("an empty page says so, and a tap on a card opens the drawer with that event", async () => {
    service.get.mockResolvedValueOnce(page([])).mockResolvedValue(page([edit, login], 2));
    await render();
    expect(cards()).toHaveLength(0);
    expect(host.querySelector(".audit-cards__empty")?.textContent).toBe("audit_empty");
    expect(range()).toBe("audit_range:0-0/0");
    expect(arrows().map((b) => b.disabled)).toEqual([true, true]);

    await click(toggle());
    expect(cards()).toHaveLength(2);
    await click(cards()[1]);
    const drawer = document.querySelector<HTMLElement>(".audit-drawer");
    expect(drawer?.textContent).toContain("audit_drawer_title");
    expect(drawer?.textContent).toContain("audit_action_auth_login");
    expect(drawer?.textContent).not.toContain("audit_action_issuance_edit");
  });
});
