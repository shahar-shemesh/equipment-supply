import { useTranslation } from "react-i18next";
import { Checkbox, IconButton } from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";

import { IIssuance } from "../../../../shared/@core";
import { PriorityBadge, StatusBadge } from "../../components/StatusBadge";
import { displayNumber, fullAddress } from "../../utils/format";

type Props = {
  row: IIssuance;
  checked: boolean;
  canSelect: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMenu: (anchor: HTMLElement) => void; //the kebab. the menu itself lives in IssuancesTable, one instance for all cards
};

//one issuance as a card, the phone version of a table row. same columns, four lines: number + status,
//customer + city, destination, courier + priority. the kebab sits in the top corner on the end side
export function IssuanceCard({ row, checked, canSelect, onToggle, onOpen, onMenu }: Props) {
  const { t } = useTranslation();

  return (
    <div className={`issuance-card ${checked ? "is-selected" : ""}`}>
      <IconButton className="issuance-card__menu" size="small" aria-label={t("row_actions")} onClick={(e) => onMenu(e.currentTarget)}>
        <MoreVertIcon />
      </IconButton>

      <div className="issuance-card__row issuance-card__row--head">
        <Checkbox size="small" checked={checked} disabled={!canSelect} onChange={onToggle} />
        <button type="button" className="link-button issuance-card__number" onClick={onOpen}>{displayNumber(row)}</button>
        <StatusBadge status={row.status} managerView />
      </div>

      <div className="issuance-card__row">
        <span className="issuance-card__customer">{row.customer_name}</span>
        <span><label>{t("col_city")}</label>{row.address_city}</span>
      </div>

      <div className="issuance-card__row">
        <span><label>{t("col_destination")}</label>{fullAddress(row)}</span>
      </div>

      <div className="issuance-card__row">
        <span><label>{t("col_courier")}</label>{row.current_task?.courier?.name || <span className="muted">{t("detail_no_courier")}</span>}</span>
        <PriorityBadge priority={row.priority} />
      </div>
    </div>
  );
}
