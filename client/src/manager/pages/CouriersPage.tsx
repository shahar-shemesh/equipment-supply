import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@mui/material";

import { ICourier } from "../../../../shared/@core";
import { get } from "../../utils/service";

//ניהול שליחים - only the list for now. create / edit / excel import (spec 2.7.2) wait for a design
export default function CouriersPage() {
  const { t } = useTranslation();
  const [couriers, setCouriers] = useState<ICourier[]>([]);

  useEffect(() => {
    get("/couriers").then(setCouriers).catch(() => setCouriers([]));
  }, []);

  return (
    <div className="simple-page">
      <h1>{t("couriers_title")}</h1>
      <Alert severity="info">{t("couriers_placeholder")}</Alert>

      {/* data-label feeds the phone layout: the css turns every row into a card and prints the column title before the value */}
      <div className="issuances-table table--stack-phone">
        <table>
          <thead>
            <tr>
              <th>{t("courier_name")}</th>
              <th>{t("courier_employee_id")}</th>
              <th>{t("courier_phone")}</th>
              <th>{t("courier_zones")}</th>
              <th>{t("courier_open_tasks")}</th>
              <th>{t("courier_has_login")}</th>
            </tr>
          </thead>
          <tbody>
            {couriers.map((c) => (
              <tr key={c.id}>
                <td data-label={t("courier_name")}>{c.name}</td>
                <td data-label={t("courier_employee_id")}>{c.employee_id || "-"}</td>
                <td data-label={t("courier_phone")}>{c.phone || "-"}</td>
                <td data-label={t("courier_zones")}>{(c.zones || []).join(", ") || "-"}</td>
                <td data-label={t("courier_open_tasks")}>{c.pending || 0}</td>
                <td data-label={t("courier_has_login")}>{c.user_id ? t("yes") : t("no")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
