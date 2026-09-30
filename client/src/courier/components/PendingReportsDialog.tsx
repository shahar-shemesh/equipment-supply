import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, Dialog, DialogContent, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import SyncIcon from "@mui/icons-material/Sync";

import { EvidenceUploadState, IssuanceStatus, ReportSyncState } from "../../../../shared/@core";
import { StatusBadge } from "../../components/StatusBadge";
import { displayNumber, formatDateTime } from "../../utils/format";
import { LocalReport } from "../offline/db";
import { requestPersistentStorage } from "../offline/storage";
import { evidenceOf, needsAttention, retryAll, retryReport } from "../offline/store";
import { kickSync } from "../offline/sync";
import { useReports } from "../offline/useCourierData";
import { SyncChip } from "./SyncChip";
import { EvidenceLine } from "./EvidenceLine";

const QUEUED = [ReportSyncState.queued, ReportSyncState.syncing, ReportSyncState.auth];
const RETRYABLE = [ReportSyncState.queued, ReportSyncState.auth];

type Props = { open: boolean; onClose: () => void; scope: string | null };

//דוחות שנשמרו במכשיר: every report on this device in three lists, with a retry where the state allows one and a link to
//the preserved report. rejected reports stay here indefinitely (nothing prunes them), the courier shows them to the manager
export function PendingReportsDialog({ open, onClose, scope }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: reports, error } = useReports(scope);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  //the answer of the one navigator.storage.persist() call of this session (cached in storage.ts, so this never asks again)
  useEffect(() => {
    if (!open || !scope) return;
    requestPersistentStorage(scope).then(setPersistent);
  }, [open, scope]);

  const queued = reports.filter((r) => QUEUED.includes(r.sync.state));
  //a conflict leaves the attention list once a manager marked its evidence reviewed; it never leaves the device
  const attention = reports.filter(needsAttention);
  const reviewed = reports.filter((r) => r.sync.state === ReportSyncState.conflict && evidenceOf(r).state === EvidenceUploadState.reviewed);
  const synced = reports.filter((r) => r.sync.state === ReportSyncState.synced);

  async function retryOne(r: LocalReport) {
    setBusy(true);
    try {
      await retryReport(scope, r.operation_id);
      await kickSync("retry");
    } finally {
      setBusy(false);
    }
  }

  async function retryEvery() {
    setBusy(true);
    try {
      await retryAll(scope);
      await kickSync("retry");
    } finally {
      setBusy(false);
    }
  }

  function view(r: LocalReport) {
    onClose();
    navigate(`/courier/reports/${r.operation_id}`);
  }

  function section(title: string, rows: LocalReport[]) {
    if (!rows.length) return null;
    return (
      <div className="pending-dialog__section">
        <h3>{title} ({rows.length})</h3>
        {rows.map((r) => (
          <div key={r.operation_id} className="pending-dialog__row">
            <div className="pending-dialog__head">
              <span className="pending-dialog__number">{displayNumber(r.display as any)}</span>
              <span>{r.display.customer_name}</span>
              {/* the outcome enum shares its values with the issuance statuses, the badge draws it the same way */}
              <StatusBadge status={r.outcome as any as IssuanceStatus} />
            </div>
            <div className="pending-dialog__state">
              <SyncChip state={r.sync.state} />
              <span className="muted small">{t("sync_saved_at", { time: formatDateTime(r.client_reported_at) })}</span>
              {r.ack && <span className="muted small">{t("sync_received_at", { time: formatDateTime(r.ack.reported_at) })}</span>}
              {r.sync.state === ReportSyncState.queued && r.sync.next_at && <span className="muted small">{t("sync_next_try", { time: formatDateTime(r.sync.next_at) })}</span>}
            </div>
            {r.sync.state === ReportSyncState.conflict && r.sync.conflict_code && <div className="pending-dialog__error">{t(`conflict_${r.sync.conflict_code}`)}</div>}
            <EvidenceLine report={r} scope={scope} />
            {r.sync.last_error && r.sync.state !== ReportSyncState.synced && <div className="pending-dialog__error small">{t("sync_last_error", { error: r.sync.last_error })}</div>}
            <div className="pending-dialog__actions">
              <button type="button" className="link-button" onClick={() => view(r)}>{t("sync_view_report")}</button>
              {RETRYABLE.includes(r.sync.state) && (
                <button type="button" className="link-button" disabled={busy} onClick={() => retryOne(r)}>{t("sync_retry")}</button>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth className="pending-dialog">
      <DialogContent>
        <div className="dialog-title-row">
          <h2>{t("sync_reports_title")}</h2>
          <IconButton onClick={onClose} aria-label={t("close")}><CloseIcon /></IconButton>
        </div>

        {error && <Alert severity="error">{t(error)}</Alert>}

        {queued.some((r) => RETRYABLE.includes(r.sync.state)) && (
          <Button variant="outlined" startIcon={<SyncIcon />} disabled={busy} onClick={retryEvery} className="pending-dialog__retry-all">
            {t("sync_retry_all")}
          </Button>
        )}

        {reports.length === 0 && !error && <div className="pending-dialog__empty">{t("sync_reports_empty")}</div>}

        {section(t("sync_section_queued"), queued)}
        {section(t("sync_section_attention"), attention)}
        {section(t("sync_section_reviewed"), reviewed)}
        {section(t("sync_section_synced"), synced)}

        {/* persist() is a request, not a promise: "clear site data" and an eviction still delete everything */}
        {persistent !== null && <div className="pending-dialog__storage muted small">{t(persistent ? "offline_storage_persistent" : "offline_storage_not_persistent")}</div>}
      </DialogContent>
    </Dialog>
  );
}
