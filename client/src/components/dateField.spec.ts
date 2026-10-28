import dayjs from "dayjs";
import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateField, pickedDate } from "./DateField";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

//what the picker hands the caller: the iso day, "" for an emptied field, nothing while a date is typed halfway
describe("pickedDate", () => {
  it("prints a whole date as YYYY-MM-DD, an empty field as the empty string", () => {
    expect(pickedDate(dayjs("2026-10-12"))).toBe("2026-10-12");
    expect(pickedDate(null)).toBe("");
  });

  it("hands nothing for a date typed halfway, so the caller keeps its date", () => {
    expect(pickedDate(dayjs("x"))).toBeUndefined();
    expect(pickedDate(dayjs(NaN))).toBeUndefined();
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

//jsdom has no matchMedia and the picker then takes its desktop variant (a calendar popup under the field). a matchMedia
//that matches nothing is a touch screen to it: the calendar opens in a dialog with its own ok button
function touchScreen() {
  (window as any).matchMedia = (media: string) => ({ media, matches: false, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
}

//the calendar (popup or dialog) is rendered into the body, outside the host
const calendar = () => document.querySelector<HTMLElement>("[role=dialog]");
const button = (within: ParentNode, text: string) => Array.from(within.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === text);
const key = (target: Element, init: KeyboardEventInit) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })); });

//the date field on mui's picker: it prints DD/MM/YYYY and the caller still gets YYYY-MM-DD
describe("DateField", () => {
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
    delete (window as any).matchMedia;
  });

  async function render(value: string, props: any = {}) {
    await act(async () => root.render(createElement(DateField, { value, onChange, label: "the_label", ...props })));
    return {
      field: host.querySelector<HTMLInputElement>(".MuiPickersTextField-root input"), //the picker's hidden input holds the printed value
      open: host.querySelector<HTMLButtonElement>("button[title=open_calendar]"),
      clear: host.querySelector<HTMLButtonElement>("button[title='נקה ערך']"),
      section: (index: number) => host.querySelector<HTMLElement>(`[data-sectionindex="${index}"] [contenteditable]`),
    };
  }

  it("prints the day first, the label and the calendar button, nothing when there is no date", async () => {
    const { field, open, clear } = await render("2026-10-07");
    expect(field.value).toBe("07/10/2026");
    expect(host.textContent).toContain("the_label");
    expect(open).toBeTruthy();
    expect(clear).toBeTruthy();

    const empty = await render("");
    expect(empty.field.value).toBe("");
    expect(empty.clear).toBeNull(); //nothing to clear
  });

  it("opens the calendar from its button and passes a picked day up as YYYY-MM-DD", async () => {
    const { open } = await render("2026-10-07");
    expect(calendar()).toBeNull();
    await act(async () => open.click());
    expect(calendar()).toBeTruthy();
    await act(async () => button(calendar(), "12").click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("2026-10-12");
  });

  //the arrows step the focused section of the typed date, every step is a whole date
  it("takes a date typed into the field: a step on the day section goes up at once", async () => {
    const { section } = await render("2026-10-07");
    await act(async () => section(0).focus());
    await key(section(0), { key: "ArrowDown" });
    expect(onChange).toHaveBeenLastCalledWith("2026-10-06");
    await key(section(0), { key: "ArrowUp" });
    await key(section(0), { key: "ArrowUp" });
    expect(onChange).toHaveBeenLastCalledWith("2026-10-08");
  });

  //delete with no section picked wipes the whole field: no date is none
  it("clears the date with the x button and with delete over the whole field", async () => {
    const { clear, section } = await render("2026-10-07");
    await act(async () => clear.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    await key(section(0), { key: "Delete" });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  //a disabled field (an issuance past editing) prints its date and takes nothing: no popup, no clear
  it("disabled: prints the date, the calendar button is off and the sections take no keys", async () => {
    const { field, open, clear, section } = await render("2026-10-07", { disabled: true });
    expect(field.value).toBe("07/10/2026");
    expect(open.disabled).toBe(true);
    expect(clear).toBeNull();
    expect(section(0).getAttribute("aria-disabled")).toBe("true");
    await act(async () => open.click());
    expect(calendar()).toBeNull();
    await key(section(0), { key: "Delete" });
    expect(onChange).not.toHaveBeenCalled();
  });

  //what the iphone gets: the calendar button opens a dialog instead of the popup, the date goes up on its ok button
  it("on a touch screen the calendar opens in a dialog and ok passes the picked day up", async () => {
    touchScreen();
    const { open } = await render("2026-10-07");
    expect(document.querySelector(".MuiDialog-root")).toBeNull();
    await act(async () => open.click());
    expect(document.querySelector(".MuiDialog-root")).toBeTruthy();
    await act(async () => button(calendar(), "12").click());
    await act(async () => button(calendar(), "אישור").click());
    expect(onChange).toHaveBeenLastCalledWith("2026-10-12");
  });
});
