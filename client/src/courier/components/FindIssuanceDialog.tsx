import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";

import { errorMessage, get } from "../../utils/service";

//סריקת QR קוד - the camera is not wired yet (which library, and what the QR encodes, are both open),
//so the dialog shows the camera frame from the design and works through the manual number entry
export function FindIssuanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [manual, setManual] = useState(false);
  const [number, setNumber] = useState("");
  const [error, setError] = useState("");

  function close() {
    setManual(false);
    setNumber("");
    setError("");
    onClose();
  }

  async function find(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await get("/delivery/lookup", { number });
      close();
      navigate(`/courier/tasks/${res.task_id}`);
    } catch (err) {
      const status = err?.response?.status;
      setError(status === 404 ? t("find_not_found") : status === 403 ? t("find_not_mine") : errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="xs" fullWidth className="find-dialog">
      <DialogContent>
        <div className="dialog-title-row">
          <h2>{t("find_title")}</h2>
          <IconButton onClick={close}><CloseIcon /></IconButton>
        </div>

        {!manual && (
          <>
            <div className="find-dialog__camera">
              <div className="find-dialog__frame" />
              <span>{t("find_camera_hint")}</span>
            </div>
            <Alert severity="info" icon={false}>{t("find_camera_todo")}</Alert>
            <Button variant="outlined" startIcon={<EditIcon />} onClick={() => setManual(true)} fullWidth>
              {t("find_manual")}
            </Button>
          </>
        )}

        {manual && (
          <form onSubmit={find} className="find-dialog__form">
            <TextField label={t("find_number_label")} value={number} onChange={(e) => setNumber(e.target.value)} autoFocus fullWidth inputProps={{ inputMode: "numeric" }} />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" disabled={!number} fullWidth>{t("find_button")}</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
