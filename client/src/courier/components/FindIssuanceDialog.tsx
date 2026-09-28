import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";

import { useAuth } from "../../utils/auth";
import { errorMessage, get } from "../../utils/service";
import { scopeOf } from "../offline/identity";
import { lookupLocal, refresh } from "../offline/store";

//סריקת QR קוד - the camera is not wired yet (which library, and what the QR encodes, are both open),
//so the dialog shows the camera frame from the design and works through the manual number entry
export function FindIssuanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const scope = scopeOf(user);
  const [manual, setManual] = useState(false);
  const [number, setNumber] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function close() {
    setManual(false);
    setNumber("");
    setError("");
    onClose();
  }

  //the device first: a hit there is the task the courier already has. a miss only means "not on this device", so the
  //server is asked when there is a network; offline the miss proves nothing and the message says so
  async function find(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const local = scope ? await lookupLocal(scope, number) : null;
      if (local) {
        close();
        navigate(`/courier/tasks/${local}`);
        return;
      }
      if (!navigator.onLine) {
        setError(t("offline_lookup_unavailable"));
        return;
      }
      const res = await get("/delivery/lookup", { number });
      //a task assigned after the last snapshot: pull it in first, or the task page would not find it on the device
      if (scope) await refresh(scope);
      close();
      navigate(`/courier/tasks/${res.task_id}`);
    } catch (err) {
      const status = err?.response?.status;
      setError(status === 404 ? t("find_not_found") : status === 403 ? t("find_not_mine") : errorMessage(err));
    } finally {
      setBusy(false);
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
            <TextField label={t("find_number_label")} value={number} onChange={(e) => setNumber(e.target.value)} autoFocus fullWidth inputProps={{ inputMode: "numeric", enterKeyHint: "go" }} />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" disabled={!number || busy} fullWidth>{t("find_button")}</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
