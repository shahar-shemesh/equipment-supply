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

      <div className="issuances-table">
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
                <td>{c.name}</td>
                <td>{c.employee_id || "-"}</td>
                <td>{c.phone || "-"}</td>
                <td>{(c.zones || []).join(", ") || "-"}</td>
                <td>{c.pending || 0}</td>
                <td>{c.user_id ? t("yes") : t("no")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
