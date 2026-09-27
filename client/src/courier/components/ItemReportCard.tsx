import { useTranslation } from "react-i18next";
import { MenuItem, TextField } from "@mui/material";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";

import { IIssuanceItem, NonDeliveryReason } from "../../../../shared/@core";
import { reasonKeys } from "../../../../shared/@utils";

export type ItemAnswer = { delivered?: boolean; reason?: NonDeliveryReason | ""; reason_details?: string };

type Props = {
  item: IIssuanceItem;
  index: number;
  answer: ItemAnswer;
  errors: Record<string, string>;
  onChange: (next: ItemAnswer) => void;
};

const DETAILS_MAX = 100; //the design shows 00/100 under the text area

//one product block of the delivery report: the item fields, the נמסר / לא נמסר toggle, and the reason when not delivered
export function ItemReportCard({ item, index, answer, errors, onChange }: Props) {
  const { t } = useTranslation();

  return (
    <div className="item-report">
      <h3>{t("item_n", { n: index + 1 })}</h3>
      <div className="item-report__fields">
        <div><label>{t("item_product")}</label><span>{item.product_name}</span></div>
        <div><label>{t("item_catalog")}</label><span>{item.catalog_number || "-"}</span></div>
        <div><label>{t("item_station")}</label><span>{item.station_number || "-"}</span></div>
        <div><label>{t("item_serial")}</label><span>{item.serial_number || "-"}</span></div>
        <div><label>{t("item_quantity")}</label><span>{item.quantity}</span></div>
      </div>

      <div className="item-report__question">{t("item_delivered_q")}</div>
      <div className="toggle-pair">
        <button type="button" className={answer.delivered === true ? "is-active" : ""} onClick={() => onChange({ delivered: true })}>
          <Inventory2OutlinedIcon /> {t("item_delivered")}
        </button>
        <button type="button" className={answer.delivered === false ? "is-active" : ""} onClick={() => onChange({ ...answer, delivered: false })}>
          <Inventory2OutlinedIcon /> {t("item_not_delivered")}
        </button>
      </div>
      {errors.delivered && <div className="field-error">{errors.delivered}</div>}

      {answer.delivered === false && (
        <div className="item-report__reason">
          <label>{t("reason_label")}<span className="req">*</span></label>
          <TextField select fullWidth value={answer.reason || ""} error={!!errors.reason} helperText={errors.reason} onChange={(e) => onChange({ ...answer, reason: e.target.value as NonDeliveryReason })}>
            {Object.values(NonDeliveryReason).map((r) => (
              <MenuItem key={r} value={r}>{t(reasonKeys[r])}</MenuItem>
            ))}
          </TextField>

          <label>{t("reason_details_label")}<span className="req">*</span></label>
          <TextField
            multiline
            minRows={3}
            fullWidth
            placeholder={t("reason_details_placeholder")}
            value={answer.reason_details || ""}
            error={!!errors.reason_details}
            helperText={errors.reason_details}
            inputProps={{ maxLength: DETAILS_MAX }}
            onChange={(e) => onChange({ ...answer, reason_details: e.target.value })}
          />
          <div className="char-count">{(answer.reason_details || "").length}/{DETAILS_MAX}</div>
        </div>
      )}
    </div>
  );
}
