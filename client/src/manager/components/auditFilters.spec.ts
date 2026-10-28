import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dayjs from "dayjs";

import { AuditAction } from "../../../../shared/@core";
import { ActionFilterField, AuditFilters, SEARCH_MAX, emptyAuditFilters, isDirty, rangeInvalid, toAuditQuery } from "./AuditFilters";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

//the query string the audit page sends: the action list joins with a comma, the chips send their ids, empties stay home
describe("toAuditQuery", () => {
  it("maps every filter to the parameter the server reads; the days go as local midnights, the end one day on", () => {
    const q = toAuditQuery({ q: " דנה ", actions: [AuditAction.issuance_assign, AuditAction.issuance_edit], from: "2026-10-01", to: "2026-10-28", actor: { id: 4, label: "דנה" }, issuance: { id: 7, label: "7000001" } });
    expect(q).toEqual({ q: "דנה", action: "issuance.assign,issuance.edit", from: dayjs("2026-10-01").format(), to: dayjs("2026-10-29").format(), actor_user_id: 4, issuance_id: 7 });
    //the shape the server's DATE_RE takes: a date time with seconds and the zone it was picked in
    expect(q.from).toMatch(/^2026-10-01T00:00:00[+-]\d{2}:\d{2}$/);
    expect(q.to).toMatch(/^2026-10-29T00:00:00[+-]\d{2}:\d{2}$/);
  });

  it("sends nothing for an empty filter set, a blank search or an empty list", () => {
    expect(toAuditQuery(emptyAuditFilters)).toEqual({});
    expect(toAuditQuery({ ...emptyAuditFilters, q: "   ", actions: [] })).toEqual({});
    expect(toAuditQuery({ ...emptyAuditFilters, actions: [AuditAction.auth_login] })).toEqual({ action: "auth.login" });
  });
});

describe("rangeInvalid and isDirty", () => {
  it("a window that ends before it starts is invalid, the same day twice and an open end are not", () => {
    expect(rangeInvalid({ ...emptyAuditFilters, from: "2026-10-29", to: "2026-10-28" })).toBe(true);
    expect(rangeInvalid({ ...emptyAuditFilters, from: "2026-10-28", to: "2026-10-28" })).toBe(false);
    expect(rangeInvalid({ ...emptyAuditFilters, from: "2026-10-29" })).toBe(false);
    expect(rangeInvalid({ ...emptyAuditFilters, to: "2026-10-01" })).toBe(false);
    expect(rangeInvalid(emptyAuditFilters)).toBe(false);
  });

  it("any one filter makes the set dirty", () => {
    expect(isDirty(emptyAuditFilters)).toBe(false);
    expect(isDirty({ ...emptyAuditFilters, q: "x" })).toBe(true);
    expect(isDirty({ ...emptyAuditFilters, actions: [AuditAction.auth_login] })).toBe(true);
    expect(isDirty({ ...emptyAuditFilters, to: "2026-10-01" })).toBe(true);
    expect(isDirty({ ...emptyAuditFilters, issuance: { id: 1, label: "1" } })).toBe(true);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

//the popups (the calendar, the action list) are rendered into the body, outside the host
const calendar = () => document.querySelector<HTMLElement>("[role=dialog]");
const button = (within: ParentNode, text: string) => Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);
const options = () => Array.from(document.querySelectorAll<HTMLElement>("[role=listbox] [role=option]"));

//what the browser does when text is typed into the search box
function type(input: HTMLInputElement, value: string) {
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("AuditFilters", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onChange: any;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    onChange = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(filters = emptyAuditFilters) {
    await act(async () => root.render(createElement(AuditFilters, { filters, onChange })));
  }

  const dateFields = () => Array.from(host.querySelectorAll<HTMLElement>(".audit-filters__date"));

  it("the search box goes up after a pause, the dates and the chips at once, each leaving the other filters as they were", async () => {
    const filters = { ...emptyAuditFilters, actions: [AuditAction.auth_login], issuance: { id: 7, label: "7000001" }, actor: { id: 4, label: "דנה" } };
    await render(filters);
    await act(async () => type(host.querySelector<HTMLInputElement>("#audit-search"), "דנה"));
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...filters, q: "דנה" }));

    //the "to" calendar: the second date field
    await act(async () => dateFields()[1].querySelector<HTMLButtonElement>("button[title=open_calendar]").click());
    await act(async () => button(calendar(), "12").click());
    //the parent here never hands the typed q back as a prop, so the pick carries the filters as rendered
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, to: expect.stringMatching(/^\d{4}-\d{2}-12$/) });

    //the chips, each with its text and its x
    const chips = () => Array.from(host.querySelectorAll<HTMLElement>(".audit-filters__chip"));
    expect(chips().map((c) => c.textContent)).toEqual(["audit_filter_issuance", "audit_filter_actor"]);
    await act(async () => chips()[0].querySelector<SVGElement>(".MuiChip-deleteIcon").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, issuance: null });
    await act(async () => chips()[1].querySelector<SVGElement>(".MuiChip-deleteIcon").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, actor: null });
  });

  it("a pick made while the text waits survives: the debounced call carries the filters as they are when the pause ends", async () => {
    await render(emptyAuditFilters);
    await act(async () => type(host.querySelector<HTMLInputElement>("#audit-search"), "דנה"));
    //the page took an action pick during the 400 ms and handed the new filters down before the timer fired
    const picked = { ...emptyAuditFilters, actions: [AuditAction.issuance_edit] };
    await render(picked);
    expect(onChange).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith({ ...picked, q: "דנה" }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("a window that ends before it starts marks both date fields and says so; the clear button empties everything", async () => {
    await render({ ...emptyAuditFilters, from: "2026-10-29", to: "2026-10-28" });
    expect(dateFields().map((f) => f.classList.contains("is-invalid"))).toEqual([true, true]);
    expect(host.querySelector(".audit-filters__range-error")?.textContent).toBe("audit_filter_range_invalid");

    await act(async () => host.querySelector<HTMLButtonElement>(".board-filters__clear").click());
    expect(onChange).toHaveBeenLastCalledWith(emptyAuditFilters);

    await render({ ...emptyAuditFilters, from: "2026-10-28", to: "2026-10-28" });
    expect(dateFields().map((f) => f.classList.contains("is-invalid"))).toEqual([false, false]);
    expect(host.querySelector(".audit-filters__range-error")).toBeNull();
  });

  it("nothing picked hides the clear button and the chips; the search box stops at the server's cap", async () => {
    await render();
    expect(host.querySelector(".board-filters__clear")).toBeNull();
    expect(host.querySelector(".audit-filters__chips")).toBeNull();
    expect(host.querySelector<HTMLInputElement>("#audit-search").maxLength).toBe(SEARCH_MAX);
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

//the action multi select: every action of the closed list with a checkbox, a pick adds without closing the list
describe("ActionFilterField", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onChange: any;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    onChange = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("lists every action by its label, the picked ones checked, and a click picks one more", async () => {
    await act(async () => root.render(createElement(ActionFilterField, { value: [AuditAction.issuance_edit], onChange })));
    await act(async () => host.querySelector<HTMLButtonElement>("button[title=audit_filter_actions_open]").click());
    const all = Object.values(AuditAction);
    expect(options()).toHaveLength(all.length);
    expect(options()[0].textContent).toBe("audit_action_issuance_assign");
    expect(options().map((o) => o.querySelector<HTMLInputElement>("input[type=checkbox]").checked).filter(Boolean)).toHaveLength(1);
    await act(async () => options()[0].click());
    expect(onChange).toHaveBeenCalledWith([AuditAction.issuance_edit, AuditAction.issuance_assign]);
    expect(options()).toHaveLength(all.length); //still open
  });
});
