import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, DialogActions, DialogContent, IconButton, InputAdornment, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import SearchIcon from "@mui/icons-material/Search";

import { ICourier } from "../../../../shared/@core";
import { errorMessage, post } from "../../utils/service";
import { SortMode, SortToggle, sortRows } from "./SortToggle";

type Props = {
  ids: number[]; //null closes the dialog
  couriers: ICourier[];
  onClose: () => void;
  onDone: () => void;
  onConflict: () => void; //a 409: one of the rows moved on the server, the board behind the dialog reloads
};

//שיוך שליח - pick one courier for the selected issuances. one courier per issuance, the spec's "several couriers" case is not designed
export function AssignCourierDialog({ ids, couriers, onClose, onDone, onConflict }: Props) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [courierId, setCourierId] = useState<number>(null);
  const [sort, setSort] = useState<SortMode>("name"); //"לפי שם" is the one marked in the design
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (ids) {
      setQ("");
      setSort("name");
      setCourierId(null);
      setError("");
    }
  }, [ids]);

  async function confirm() {
    if (!courierId) {
      setError(t("assign_pick_one"));
      return;
    }
    setBusy(true);
    try {
      await post("/issuances/assign", { ids, courier_id: courierId });
      onDone();
    } catch (e) {
      setError(errorMessage(e));
      if (e?.response?.status === 409) onConflict();
    } finally {
      setBusy(false);
    }
  }

  const visible = sortRows(couriers.filter((c) => c.name.includes(q)), sort, (c) => c.name, (c) => c.pending || 0);

  return (
    <Dialog open={!!ids} onClose={onClose} maxWidth="sm" fullWidth className="assign-dialog">
      <DialogContent>
        <div className="dialog-title-row">
          <div>
            <h2>{t("assign_title")}</h2>
            <div className="muted">{t("selected_count", { count: ids?.length || 0 })}</div>
          </div>
          <IconButton onClick={onClose}><CloseIcon /></IconButton>
        </div>

        <TextField
          placeholder={t("search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          fullWidth
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <SortToggle value={sort} onChange={setSort} />

        <ul className="assign-dialog__list">
          {visible.map((c) => (
            <li key={c.id} className={c.id === courierId ? "is-selected" : ""} onClick={() => setCourierId(c.id)}>
              <span>{c.name}</span>
              <span>{c.pending || 0} {t("issuances_short")}</span>
            </li>
          ))}
        </ul>

        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={confirm} disabled={busy}>{t("assign_confirm")}</Button>
        <Button variant="outlined" onClick={onClose}>{t("cancel")}</Button>
      </DialogActions>
    </Dialog>
  );
}
