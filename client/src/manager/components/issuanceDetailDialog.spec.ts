import { act, createElement } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssuanceStatus } from "../../../../shared/@core";

const service = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../utils/service", () => ({ get: service.get, patch: service.patch, del: service.del, errorMessage: (e: any) => String(e?.message || e) }));
//the handover form over this dialog is not what these specs look at, and it drags the courier's report form along
vi.mock("./SelfPickupReportDialog", () => ({ SelfPickupReportDialog: () => null }));

import { IssuanceDetailDialog } from "./IssuanceDetailDialog";

//the delivery date of the detail dialog on the shared date field (components/DateField.tsx): the loaded date is
//printed DD/MM/YYYY, a pick patches the issuance with YYYY-MM-DD, a status past editing disables the field
describe("IssuanceDetailDialog delivery date", () => {
  let root: Root;
  let host: HTMLDivElement;
  let onChanged: any;

  const issuance = (status: IssuanceStatus) => ({
    id: 7, status, delivery_date: "2026-10-07", sap_number: "1000001", number_prefix: "ס'", priority: "normal",
    customer_name: "כהן", address_street: "הרצל", address_building: "3", address_city: "חולון", items: [], current_task: null,
  });

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    onChanged = vi.fn();
    service.get.mockReset();
    service.patch.mockReset();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  //the dialog is rendered into the body; its date field is the one pickers field in it
  async function render(status: IssuanceStatus) {
    service.get.mockResolvedValue(issuance(status));
    await act(async () => root.render(createElement(IssuanceDetailDialog, { id: 7, onClose: vi.fn(), onChanged, onAssign: vi.fn() })));
    const field = document.querySelector<HTMLElement>(".detail-dialog .MuiPickersTextField-root");
    return { input: field.querySelector("input"), open: field.querySelector<HTMLButtonElement>("button[title=open_calendar]") };
  }

  it("prints the loaded date and patches the issuance with a picked day", async () => {
    const { input, open } = await render(IssuanceStatus.unassigned);
    expect(service.get).toHaveBeenCalledWith("/issuances/7");
    expect(input.value).toBe("07/10/2026");

    service.patch.mockResolvedValue({ ...issuance(IssuanceStatus.unassigned), delivery_date: "2026-10-12" });
    await act(async () => open.click());
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")).find((b) => b.textContent === "12").click());
    expect(service.patch).toHaveBeenCalledWith("/issuances/7", { delivery_date: "2026-10-12" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("12/10/2026"); //the server's answer is what the dialog shows
  });

  it("is disabled once the issuance takes no edit, the date still printed", async () => {
    const { input, open } = await render(IssuanceStatus.delivered);
    expect(input.value).toBe("07/10/2026");
    expect(open.disabled).toBe(true);
    await act(async () => open.click());
    expect(service.patch).not.toHaveBeenCalled();
  });
});
