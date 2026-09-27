import dayjs from "dayjs";
import "dayjs/locale/he";

import { IIssuance } from "../../../shared/@core";

dayjs.locale("he");

export function formatDate(d?: string | Date) {
  return d ? dayjs(d).format("DD/MM/YYYY") : "-";
}

export function formatDateTime(d?: string | Date) {
  return d ? dayjs(d).format("DD/MM/YYYY, HH:mm") : "-";
}

//"יום שני, 6 ביולי 2026" like the courier home screen
export function todayLong() {
  return dayjs().format("dddd, D [ב]MMMM YYYY");
}

export function greetingKey() {
  const h = new Date().getHours();
  return h < 12 ? "greeting_morning" : h < 17 ? "greeting_noon" : "greeting_evening";
}

/*──────────────────────────────────────────────────────────────────────────*/

//the number as the design prints it: prefix letter + number (ס' 1234567)
export function displayNumber(i: IIssuance) {
  return `${i.number_prefix ? i.number_prefix + " " : ""}${i.sap_number}`;
}

export function fullAddress(i: IIssuance) {
  return [i.address_street, i.address_building].filter(Boolean).join(", ");
}
