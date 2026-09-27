import { useTranslation } from "react-i18next";
import { Alert } from "@mui/material";

//דוחות - the diagram has "דאשבורד - נדרש להגדיר KPI" with a question mark, nothing to build yet
export default function ReportsPage() {
  const { t } = useTranslation();
  return (
    <div className="simple-page">
      <h1>{t("reports_title")}</h1>
      <Alert severity="info">{t("reports_placeholder")}</Alert>
    </div>
  );
}
