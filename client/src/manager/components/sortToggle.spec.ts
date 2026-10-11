import { describe, expect, it } from "vitest";

import { sortRows } from "./SortToggle";

//the one sort behind the three "לפי שם / לפי עומס" toggles. the search runs before it, so these rows are what the list shows

const couriers = [
  { name: "דוד", pending: 2 },
  { name: "אברהם", pending: 5 },
  { name: "יוסי", pending: 5 },
  { name: "בני", pending: 0 },
];

describe("sortRows", () => {
  it("by name is the hebrew alphabet", () => {
    expect(sortRows(couriers, "name", (c) => c.name, (c) => c.pending).map((c) => c.name)).toEqual(["אברהם", "בני", "דוד", "יוסי"]);
  });

  it("by load is the busiest first, a tie by name", () => {
    expect(sortRows(couriers, "load", (c) => c.name, (c) => c.pending).map((c) => c.name)).toEqual(["אברהם", "יוסי", "דוד", "בני"]);
  });

  it("leaves the input alone and copes with an empty list", () => {
    const before = couriers.map((c) => c.name);
    sortRows(couriers, "load", (c) => c.name, (c) => c.pending);
    expect(couriers.map((c) => c.name)).toEqual(before);
    expect(sortRows([], "name", () => "", () => 0)).toEqual([]);
  });
});
