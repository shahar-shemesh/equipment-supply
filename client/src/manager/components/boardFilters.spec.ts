import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import { emptyFilters, initialFilters, toQuery } from "./BoardFilters";

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
