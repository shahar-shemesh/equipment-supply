import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";

import { ICourier, ICourierPayload } from "../../../../shared/@core";
import { errorMessage, patch, post } from "../../utils/service";

type Props = {
  open: boolean;
  courier: ICourier; //null = הוספת שליח חדש, a row = עריכה of that row
  onClose: () => void;
  onSaved: (courier: ICourier, mode: "add" | "edit") => void;
};

const empty: ICourierPayload = { name: "", id_number: "", phone: "" };

//the add / edit form from the design: three fields and one button. after an add the dialog turns into the
//"השליח נשמר בהצלחה" screen with a button for the next one. an edit has no such screen in the design, the page closes it
export function CourierDialog({ open, courier, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ICourierPayload>(empty);
  const [errors, setErrors] = useState<Partial<ICourierPayload>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(courier ? { name: courier.name, id_number: courier.id_number || "", phone: courier.phone || "" } : empty);
    setErrors({});
    setError("");
    setSaved(false);
  }, [open, courier]);

  function set(key: keyof ICourierPayload, value: string) {
    setForm({ ...form, [key]: value });
    if (errors[key]) setErrors({ ...errors, [key]: undefined });
  }

  //the same rules as courier.validation.ts on the server, here only so the field turns red before the round trip
  function validate() {
    const next: Partial<ICourierPayload> = {};
    if (!form.name.trim()) next.name = t("required");
    if (!/^\d{9}$/.test(form.id_number.replace(/\D/g, ""))) next.id_number = t("courier_id_invalid");
    const digits = form.phone.replace(/\D/g, "");
    if (!/^0[57]\d{8}$/.test(digits) && !/^0[2-4689]\d{7}$/.test(digits)) next.phone = t("courier_phone_invalid");
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function save() {
    if (!validate()) return;
    setBusy(true);
    setError("");
    try {
      const row = courier ? await patch(`/couriers/${courier.id}`, form) : await post("/couriers", form);
      if (!courier) setSaved(true);
      onSaved(row, courier ? "edit" : "add");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function addAnother() {
    setForm(empty);
    setErrors({});
    setSaved(false);
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth className="courier-dialog">
      <DialogContent>
        <IconButton className="courier-dialog__close" aria-label={t("close")} onClick={onClose}><CloseIcon /></IconButton>

        {saved ? (
          <div className="success-dialog courier-dialog__saved">
            <CheckCircleOutlineIcon className="success-dialog__icon" />
            <h2>{t("courier_saved")}</h2>
            <Button variant="contained" onClick={addAnother}>{t("courier_add_another")}</Button>
          </div>
        ) : (
          <form className="courier-dialog__form" noValidate onSubmit={(e) => { e.preventDefault(); save(); }}>
            <h2 className="courier-dialog__title">{t(courier ? "courier_edit_title" : "courier_add_title")}</h2>

            <div className="courier-dialog__field">
              <label htmlFor="courier-name">{t("courier_full_name")}</label>
              <TextField id="courier-name" placeholder={t("courier_name_placeholder")} value={form.name} onChange={(e) => set("name", e.target.value)} error={!!errors.name} helperText={errors.name} fullWidth autoFocus />
            </div>

            <div className="courier-dialog__field">
              <label htmlFor="courier-id">{t("courier_id_number")}</label>
              <TextField id="courier-id" placeholder={t("courier_id_placeholder")} value={form.id_number} onChange={(e) => set("id_number", e.target.value)} error={!!errors.id_number} helperText={errors.id_number} fullWidth inputProps={{ inputMode: "numeric" }} />
            </div>

            <div className="courier-dialog__field">
              <label htmlFor="courier-phone">{t("courier_mobile")}</label>
              <TextField id="courier-phone" placeholder={t("courier_phone_placeholder")} value={form.phone} onChange={(e) => set("phone", e.target.value)} error={!!errors.phone} helperText={errors.phone} fullWidth inputProps={{ inputMode: "tel" }} />
            </div>

            {error && <Alert severity="error">{error}</Alert>}

            <Button type="submit" variant="contained" className="courier-dialog__submit" disabled={busy}>{t("courier_save")}</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
