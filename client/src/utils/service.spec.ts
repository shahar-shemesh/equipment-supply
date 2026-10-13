import { beforeAll, describe, expect, it } from "vitest";
import i18n from "i18next";

import Translation from "../../../shared/i18n";
import { clearSession, errorMessage, takeSessionEnd, TOKEN_KEY, USER_KEY } from "./service";

//the wording of a server error on the board (the 409 of the transition table comes with its parts and is said in hebrew,
//everything else is the server's message as it was), and the note a session leaves for the login page

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

  it("words the refusal of the last line with the issuance number and what to do instead", () => {
    const err = axiosError({ statusCode: 409, message: "issuance 1234567 has one item left, delete the issuance instead", code: "last_item", sap_number: "1234567" });
    expect(errorMessage(err)).toBe("לא ניתן להסיר את הפריט האחרון מהנפקה 1234567. כדי לבטל אותה יש למחוק את ההנפקה");
    //without the number there is nothing to word, the server message stands
    expect(errorMessage(axiosError({ statusCode: 409, message: "x", code: "last_item" }))).toBe("x");
  });

  it("words the handover's refusal when a line left the issuance meanwhile", () => {
    const err = axiosError({ statusCode: 409, message: "issuance 1234567 changed meanwhile, reload it and report again", code: "revision_changed", sap_number: "1234567" });
    expect(errorMessage(err)).toBe("הנפקה 1234567 השתנתה בינתיים, הנתונים נטענו מחדש. יש לדווח שוב");
    //the courier's 409 of the same code carries no issuance number and is worded by the sync, not here
    expect(errorMessage(axiosError({ statusCode: 409, message: "x", code: "revision_changed" }))).toBe("x");
  });

  it("falls back to the server message when the code or its parts are unknown", () => {
    expect(errorMessage(axiosError({ statusCode: 409, message: "a courier with id number 1 already exists" }))).toBe("a courier with id number 1 already exists");
    expect(errorMessage(axiosError({ statusCode: 409, message: "x", code: "status_not_allowed", status: "weird", action: "assign" }))).toBe("x");
    expect(errorMessage(axiosError({ statusCode: 400, message: ["a", "b"] }, 400))).toBe("a, b");
    expect(errorMessage({ message: "Network Error" })).toBe("Network Error");
    expect(errorMessage({})).toBe("שגיאה לא ידועה");
  });
});

/*──────────────────────────────────────────────────────────────────────────*/

describe("clearSession / takeSessionEnd", () => {
  it("removes both keys and leaves a note the login page reads once", () => {
    localStorage.setItem(TOKEN_KEY, "t");
    localStorage.setItem(USER_KEY, "{}");
    clearSession({ reason: "logout", sent: 2 });
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
    expect(takeSessionEnd()).toEqual({ reason: "logout", sent: 2 });
    expect(takeSessionEnd()).toBeNull();

    //an end without a note drops a stale one, and junk in storage reads as no note
    clearSession({ reason: "expired" });
    clearSession();
    expect(takeSessionEnd()).toBeNull();
    sessionStorage.setItem("es_session_end", "{nope");
    expect(takeSessionEnd()).toBeNull();
    sessionStorage.setItem("es_session_end", JSON.stringify({ reason: "other" }));
    expect(takeSessionEnd()).toBeNull();
  });
});
