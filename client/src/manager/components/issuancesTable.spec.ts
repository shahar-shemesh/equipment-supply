import { describe, expect, it, vi } from "vitest";

//the grid package is esm with directory imports that vitest's node resolver refuses, and nothing here renders it
vi.mock("@mui/x-data-grid-premium", () => ({ DataGridPremium: () => null }));
vi.mock("@mui/x-data-grid-premium/locales", () => ({ heIL: { components: { MuiDataGrid: { defaultProps: { localeText: {} } } } } }));

import { selectionToIds, sortModelToState } from "./IssuancesTable";

//the two adapters between the grid's models and the board's state. the grid itself is not rendered here (jsdom has no
//layout for it); the mapping is what the bulk actions and the list request depend on

describe("selectionToIds", () => {
  it("include keeps the checked ids that are selectable on the page, in page order", () => {
    expect(selectionToIds({ type: "include", ids: new Set([3, 1, 99]) }, [1, 2, 3])).toEqual([1, 3]);
    expect(selectionToIds({ type: "include", ids: new Set() }, [1, 2, 3])).toEqual([]);
  });

  it("exclude is every selectable id except the unchecked ones", () => {
    expect(selectionToIds({ type: "exclude", ids: new Set([2]) }, [1, 2, 3])).toEqual([1, 3]);
    expect(selectionToIds({ type: "exclude", ids: new Set() }, [1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe("sortModelToState", () => {
  it("one entry becomes the key and direction the server understands, none is the default order", () => {
    expect(sortModelToState([{ field: "customer", sort: "desc" }])).toEqual({ key: "customer", dir: "desc" });
    expect(sortModelToState([{ field: "city", sort: "asc" }])).toEqual({ key: "city", dir: "asc" });
    expect(sortModelToState([{ field: "city", sort: null }])).toEqual({ key: "city", dir: "asc" });
    expect(sortModelToState([])).toBeNull();
  });
});
