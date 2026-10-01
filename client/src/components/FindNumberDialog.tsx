import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, DialogContent, IconButton, TextField } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import EditIcon from "@mui/icons-material/Edit";
import { normalizeSapNumber } from "../../../shared/@utils";
import { errorMessage } from "../utils/service";
import { QrCamera } from "./QrCamera";

//Mounted only while open: each opening gets a fresh camera and lookup session.
export function FindNumberDialog({ lookup, onFound, onClose }: { lookup: (number: string) => Promise<number>; onFound: (id: number) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [manual, setManual] = useState(false);
  const [number, setNumber] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  const active = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  /*──────────────────────────────────────────────────────────────────────────*/

  function close() {
    active.current = false; //an old request must not navigate after closing or reopening
    onClose();
  }

  /*──────────────────────────────────────────────────────────────────────────*/

  async function find(value: string, fromCamera = false) {
    if (pending.current || !active.current) return;
    setError("");
    if (fromCamera) setScanned(true);
    //QR payloads are plain SAP numbers. Never strip digits from arbitrary URLs or JSON.
    if (fromCamera && !/^\d+$/.test(value.trim())) {
      setError(t("find_not_found"));
      return;
    }
    const normalized = normalizeSapNumber(value);
    if (!normalized) {
      setError(t("find_not_found"));
      return;
    }
    setNumber(normalized);
    pending.current = true;
    setBusy(true);
    try {
      const id = await lookup(normalized);
      if (!active.current) return;
      close();
      onFound(id);
    } catch (err) {
      if (!active.current) return;
      const status = err?.response?.status;
      setError(status === 404 ? t("find_not_found") : status === 403 ? t("find_not_mine") : errorMessage(err));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <Dialog open onClose={close} maxWidth="xs" fullWidth className="find-dialog" aria-labelledby="find-number-title">
      <DialogContent>
        <div className="dialog-title-row">
          <h2 id="find-number-title">{t("find_title")}</h2>
          <IconButton onClick={close} aria-label={t("find_close")}><CloseIcon /></IconButton>
        </div>
        {!manual && !scanned && <QrCamera onScan={(text) => void find(text, true)} />}
        {error && <Alert severity="error">{error}</Alert>}
        {busy && <p role="status">{t("find_searching")}</p>}
        {!manual && <Button variant="outlined" startIcon={<EditIcon />} disabled={busy} onClick={() => { setManual(true); setError(""); }} fullWidth>{t("find_manual")}</Button>}
        {manual && (
          <form onSubmit={(e) => { e.preventDefault(); void find(number); }} className="find-dialog__form">
            <TextField label={t("find_number_label")} value={number} onChange={(e) => setNumber(e.target.value)} disabled={busy} autoFocus fullWidth inputProps={{ inputMode: "numeric", enterKeyHint: "go" }} />
            <Button type="submit" variant="contained" disabled={!normalizeSapNumber(number) || busy} fullWidth>{t("find_button")}</Button>
          </form>
        )}
        {(manual || scanned) && <Button disabled={busy} onClick={() => { setManual(false); setScanned(false); setError(""); }} fullWidth>{t("find_scan_again")}</Button>}
      </DialogContent>
    </Dialog>
  );
}
