import dayjs from "dayjs";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardFilters, DateFilterField, emptyFilters, initialFilters, toQuery } from "./BoardFilters";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

//the query string the board sends: lists join with a comma, empties stay home, strings pass through

describe("toQuery", () => {
  it("joins the lists with a comma and passes the strings through", () => {
    const q = toQuery({ ...emptyFilters, status: ["assigned", "delivered"], city: ["תל אביב", "חיפה"], search: "כהן", date: "2026-10-07" });
    expect(q).toEqual({ status: "assigned,delivered", city: "תל אביב,חיפה", search: "כהן", date: "2026-10-07" });
  });

  it("one value is a list of one", () => {
    expect(toQuery({ ...emptyFilters, status: ["unassigned"] })).toEqual({ status: "unassigned" });
  });

  it("empty lists, empty strings and blank items send nothing", () => {
    expect(toQuery(emptyFilters)).toEqual({});
    expect(toQuery({ ...emptyFilters, status: ["assigned", ""], city: [""] })).toEqual({ status: "assigned" });
  });
});

describe("initialFilters", () => {
  it("opens on today's date with everything else empty", () => {
    expect(initialFilters()).toEqual({ ...emptyFilters, date: dayjs().format("YYYY-MM-DD") });
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

//what the browser does when a date is picked in a native date input: the new value and an input event
function pick(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

//the delivery date: the field prints DD/MM/YYYY, the native input under it picks and the board still gets YYYY-MM-DD
describe("DateFilterField", () => {
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

  async function render(value: string) {
    await act(async () => root.render(createElement(DateFilterField, { value, onChange })));
    return {
      shown: host.querySelector<HTMLInputElement>("input:not([type=date])"),
      native: host.querySelector<HTMLInputElement>("input[type=date]"),
    };
  }

  it("prints the day first and keeps the native value as the iso date", async () => {
    const { shown, native } = await render("2026-10-07");
    expect(shown.value).toBe("07/10/2026");
    expect(native.value).toBe("2026-10-07");
  });

  it("shows the hebrew placeholder when there is no date", async () => {
    const { shown } = await render("");
    expect(shown.value).toBe("");
    expect(shown.placeholder).toBe("filter_date_placeholder");
  });

  it("passes a picked date up as YYYY-MM-DD", async () => {
    const { native } = await render("2026-10-07");
    await act(async () => pick(native, "2026-10-12"));
    expect(onChange).toHaveBeenCalledWith("2026-10-12");
  });

  //the popup belongs to the native input: a call on the visible read-only field would open nothing. the mock sits on that
  //one element, so a call on any other input does not count
  it("opens the native input's picker from a click and from Enter, Space and ArrowDown, from no other key", async () => {
    const { shown, native } = await render("2026-10-07");
    const showPicker = vi.fn();
    (native as any).showPicker = showPicker;
    const press = (key: string) => act(async () => { shown.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });

    await act(async () => host.querySelector<HTMLElement>(".board-filters__date").click());
    expect(showPicker).toHaveBeenCalledTimes(1);
    await press("Enter");
    await press(" ");
    await press("ArrowDown");
    expect(showPicker).toHaveBeenCalledTimes(4);
    await press("Tab");
    await press("a");
    expect(showPicker).toHaveBeenCalledTimes(4);
  });

  //the native input cleared its date with these keys, the read-only field takes them over. nothing to clear = no change event
  it("clears the date with Backspace and Delete, and does nothing when there is no date", async () => {
    const { shown } = await render("2026-10-07");
    const press = (key: string) => act(async () => { shown.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
    await press("Backspace");
    await press("Delete");
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("");

    onChange.mockClear();
    const empty = await render("");
    await act(async () => { empty.shown.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true })); });
    expect(onChange).not.toHaveBeenCalled();
  });

  //an old Safari has no showPicker, and a browser can refuse it (no user gesture): the click must not throw, the native
  //input takes the focus instead
  it.each([
    ["has no showPicker", undefined],
    ["refuses to open it", () => { throw new Error("NotAllowedError"); }],
  ])("hands the focus to the native input when the browser %s", async (_case, showPicker) => {
    const { native } = await render("2026-10-07");
    if (showPicker) (native as any).showPicker = showPicker;
    else expect((native as any).showPicker).toBeUndefined();
    await act(async () => host.querySelector<HTMLElement>(".board-filters__date").click());
    expect(document.activeElement).toBe(native);
  });

  //the toolbar wiring: the date field writes the date key of the board's filters and leaves every other filter as it was
  it("is the board's date filter: a pick or a clear changes the date and nothing else", async () => {
    const filters = { ...emptyFilters, date: "2026-10-07", customer: "כהן", status: ["assigned"], city: ["חיפה"] };
    await act(async () => root.render(createElement(BoardFilters, { filters, cities: ["חיפה"], onChange })));
    const shown = host.querySelector<HTMLInputElement>(".board-filters__date input:not([type=date])");
    const native = host.querySelector<HTMLInputElement>("input[type=date]");
    expect(shown.value).toBe("07/10/2026");

    await act(async () => pick(native, "2026-10-12"));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, date: "2026-10-12" });
    await act(async () => pick(native, ""));
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, date: "" });
  });
});
