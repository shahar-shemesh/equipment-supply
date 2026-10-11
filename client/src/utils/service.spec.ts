import { beforeAll, describe, expect, it } from "vitest";
import i18n from "i18next";

import Translation from "../../../shared/i18n";
import { errorMessage } from "./service";

//the wording of a server error on the board. the 409 of the transition table comes with its parts and is said in hebrew,
//everything else is the server's message as it was

beforeAll(async () => {
  await i18n.init(Translation as any);
});

function axiosError(data: any, status = 409) {
  return { response: { status, data }, message: "Request failed" };
}

describe("errorMessage", () => {
  it("words a status_not_allowed 409 in hebrew with the issuance, its status and the action", () => {
    const err = axiosError({ statusCode: 409, message: "issuance 1234567 is partially_delivered, assign is not allowed", code: "status_not_allowed", sap_number: "1234567", status: "partially_delivered", action: "assign" });
    expect(errorMessage(err)).toBe('לא ניתן לבצע שיוך שליח להנפקה 1234567: היא בסטטוס "נמסר חלקית"');
  });

  it("falls back to the server message when the code or its parts are unknown", () => {
    expect(errorMessage(axiosError({ statusCode: 409, message: "a courier with id number 1 already exists" }))).toBe("a courier with id number 1 already exists");
    expect(errorMessage(axiosError({ statusCode: 409, message: "x", code: "status_not_allowed", status: "weird", action: "assign" }))).toBe("x");
    expect(errorMessage(axiosError({ statusCode: 400, message: ["a", "b"] }, 400))).toBe("a, b");
    expect(errorMessage({ message: "Network Error" })).toBe("Network Error");
    expect(errorMessage({})).toBe("שגיאה לא ידועה");
  });
});
