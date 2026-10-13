import axios from "axios";
import i18n from "i18next";

import { statusKeys } from "../../../shared/@utils";
import { actionKeys } from "../../../shared/@rules";

export const TOKEN_KEY = "es_token";
export const USER_KEY = "es_user";

const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((cfg) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

//expired or bad token -> back to the login page. the AuthProvider reads an empty storage on the next mount
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err?.response?.status === 401 && !location.pathname.startsWith("/login")) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export function get(path: string, params?: any) {
  return api.get(path, { params }).then((r) => r.data);
}

export function post(path: string, body?: any) {
  return api.post(path, body).then((r) => r.data);
}

export function patch(path: string, body?: any) {
  return api.patch(path, body).then((r) => r.data);
}

export function del(path: string, body?: any) {
  return api.delete(path, { data: body }).then((r) => r.data);
}

/*──────────────────────────────────────────────────────────────────────────*/

//nest puts validation messages in an array, everything else is a string. the 409 of the transition table comes with its
//parts (shared/@rules.ts) and is worded here in hebrew: which issuance, its status, the action it refused
export function errorMessage(err: any) {
  const data = err?.response?.data;
  if (data?.code === "status_not_allowed" && statusKeys[data.status] && actionKeys[data.action]) {
    return i18n.t("conflict_status_not_allowed", { number: data.sap_number, status: i18n.t(statusKeys[data.status]), action: i18n.t(actionKeys[data.action]) });
  }
  //the only line left on an issuance cannot be removed (issuances.service.removeItem), the body names the issuance
  if (data?.code === "last_item" && data.sap_number) return i18n.t("item_remove_last", { number: data.sap_number });
  //the handover met a line removal that committed between its validation and its lock (issuances.service
  //.reportSelfPickup); the detail dialog reloads on a 409, so the fresh lines are already on screen
  if (data?.code === "revision_changed" && data.sap_number) return i18n.t("handover_revision_changed", { number: data.sap_number });
  const m = data?.message;
  return Array.isArray(m) ? m.join(", ") : m || err?.message || "שגיאה לא ידועה";
}
