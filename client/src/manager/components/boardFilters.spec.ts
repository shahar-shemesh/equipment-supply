import dayjs from "dayjs";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardFilters, CityFilterField, emptyFilters, initialFilters, toQuery } from "./BoardFilters";

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

//the popups (the calendar, the city list) are rendered into the body, outside the host
const calendar = () => document.querySelector<HTMLElement>("[role=dialog]");
const button = (within: ParentNode, text: string) => Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);
const cityOptions = () => Array.from(document.querySelectorAll<HTMLElement>("[role=listbox] [role=option]"));

//what the browser does when text is typed into the search box: the focus, the new value and an input event
function type(input: HTMLInputElement, value: string) {
  input.focus();
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

//the toolbar wiring: the date field (components/DateField.tsx, its own spec) writes the date key of the board's filters
//and leaves every other filter as it was
describe("board date filter", () => {
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

  it("a pick or a clear changes the date and nothing else", async () => {
    const filters = { ...emptyFilters, date: "2026-10-07", customer: "כהן", status: ["assigned"], city: ["חיפה"] };
    await act(async () => root.render(createElement(BoardFilters, { filters, cities: ["חיפה"], onChange })));
    expect(host.querySelector<HTMLInputElement>(".board-filters__date input").value).toBe("07/10/2026");
    expect(host.querySelector(".board-filters__date").textContent).toContain("filter_date");

    await act(async () => host.querySelector<HTMLButtonElement>("button[title=open_calendar]").click());
    await act(async () => button(calendar(), "12").click());
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, date: "2026-10-12" });
    await act(async () => host.querySelector<HTMLButtonElement>("button[title='נקה ערך']").click());
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, date: "" });
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

//the city filter: the field searches, the list has a checkbox per city, nothing picked is every city
describe("CityFilterField", () => {
  const cities = ["תל אביב", "חיפה", "באר שבע"];
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

  async function render(value: string[]) {
    await act(async () => root.render(createElement(CityFilterField, { value, cities, onChange })));
    return {
      input: host.querySelector<HTMLInputElement>("input[role=combobox]"),
      open: host.querySelector<HTMLButtonElement>("button[title=filter_city_open]"),
    };
  }

  it("lists every city with a checkbox, the picked ones checked, and a click picks one more without closing the list", async () => {
    const { open } = await render(["חיפה"]);
    await act(async () => open.click());
    expect(cityOptions().map((o) => o.textContent)).toEqual(cities);
    expect(cityOptions().map((o) => o.querySelector<HTMLInputElement>("input[type=checkbox]").checked)).toEqual([false, true, false]);
    await act(async () => cityOptions()[0].click());
    expect(onChange).toHaveBeenCalledWith(["חיפה", "תל אביב"]);
    expect(cityOptions()).toHaveLength(3);
  });

  it("narrows the list to the typed text, marks the match, and says so when no city has it", async () => {
    const { input } = await render([]);
    expect(input.placeholder).toBe("filter_city_search");
    await act(async () => type(input, "באר"));
    expect(cityOptions().map((o) => o.textContent)).toEqual(["באר שבע"]);
    expect(cityOptions()[0].querySelector("mark").textContent).toBe("באר");
    await act(async () => cityOptions()[0].click());
    expect(onChange).toHaveBeenCalledWith(["באר שבע"]);

    await act(async () => type(input, "ירושלים"));
    expect(cityOptions()).toHaveLength(0);
    expect(document.body.textContent).toContain("filter_city_none");
  });

  //limitTags: the field at rest shows one chip and counts the rest, so the toolbar's row keeps its height
  it("shows the picked cities as chips, one with a count while the field rests, and takes one off with its x", async () => {
    const { input } = await render(["חיפה", "תל אביב"]);
    expect(input.placeholder).toBe("");
    const chips = () => Array.from(host.querySelectorAll<HTMLElement>(".MuiChip-root"));
    expect(chips().map((c) => c.textContent)).toEqual(["חיפה"]);
    expect(host.textContent).toContain("+1");
    await act(async () => chips()[0].querySelector<SVGElement>(".MuiChip-deleteIcon").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onChange).toHaveBeenCalledWith(["תל אביב"]);
  });

  //the toolbar wiring: the city field writes the city key of the board's filters and leaves every other filter as it was
  it("is the board's city filter: a pick changes the cities and nothing else", async () => {
    const filters = { ...emptyFilters, date: "2026-10-07", customer: "כהן", status: ["assigned"], city: ["חיפה"] };
    await act(async () => root.render(createElement(BoardFilters, { filters, cities, onChange })));
    await act(async () => host.querySelector<HTMLButtonElement>("button[title=filter_city_open]").click());
    await act(async () => cityOptions()[2].click());
    expect(onChange).toHaveBeenLastCalledWith({ ...filters, city: ["חיפה", "באר שבע"] });
  });
});
