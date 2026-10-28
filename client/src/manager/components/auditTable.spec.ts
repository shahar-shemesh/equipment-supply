import { describe, expect, it, vi } from "vitest";

//the grid package is esm with directory imports that vitest's node resolver refuses, and nothing here renders it
vi.mock("@mui/x-data-grid-premium", () => ({ DataGridPremium: () => null }));
vi.mock("@mui/x-data-grid-premium/locales", () => ({ heIL: { components: { MuiDataGrid: { defaultProps: { localeText: {} } } } } }));

import { orderFromModel } from "./AuditTable";

//the adapter between the grid's sort model and the one order the server has. the grid itself is not rendered here
//(jsdom has no layout for it); the page spec drives the stubbed grid through both header clicks
describe("orderFromModel", () => {
  it("asc is asc; desc, a null sort and no entry are all the newest first default", () => {
    expect(orderFromModel([{ field: "at", sort: "asc" }])).toBe("asc");
    expect(orderFromModel([{ field: "at", sort: "desc" }])).toBe("desc");
    expect(orderFromModel([{ field: "at", sort: null }])).toBe("desc");
    expect(orderFromModel([])).toBe("desc");
  });
});
