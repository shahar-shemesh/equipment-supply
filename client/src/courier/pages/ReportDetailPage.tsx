import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress } from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";

import { EvidenceUploadState, IssuanceStatus, ReportSyncState } from "../../../../shared/@core";
import { reasonKeys } from "../../../../shared/@utils";
import { StatusBadge } from "../../components/StatusBadge";
import { useAuth } from "../../utils/auth";
import { displayNumber, formatDateTime } from "../../utils/format";
import { scopeOf } from "../offline/identity";
import { evidenceOf, retryReport } from "../offline/store";
import { kickSync } from "../offline/sync";
import { useReports, useTask } from "../offline/useCourierData";
import { SyncChip } from "../components/SyncChip";
import { EvidenceLine } from "../components/EvidenceLine";

//the preserved report, read only: what the courier signed, as it was saved on this device, whatever the server said
//about it since. this is the page the courier shows the manager when a report was rejected, the manager never gets it
//any other way (no unsynchronized report reaches the server)
export default function ReportDetailPage() {
  const { t } = useTranslation();
  const { operationId } = useParams();
  const { user } = useAuth();
  const scope = scopeOf(user);
  const { data: reports, loading, error } = useReports(scope);
  const report = reports.find((r) => r.operation_id === operationId) || null;
  //the task hook says whether the task is still in the snapshot (id 0 until the report is known: the hook idles then)
  const { data: taskData } = useTask(scope, report?.task_id ?? 0);
  const [busy, setBusy] = useState(false);

  async function retry() {
    setBusy(true);
    try {
      await retryReport(scope, report.operation_id);
      await kickSync("retry");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <Alert severity="error">{t(error)}</Alert>;
  if (loading) return <div className="page-loading"><CircularProgress /></div>;
  if (!report) {
    return (
      <div className="report-detail">
        <Link to="/courier" className="task-detail__back"><ChevronLeftIcon fontSize="small" /> {t("back")}</Link>
        <Alert severity="warning">{t("sync_report_not_found")}</Alert>
      </div>
    );
  }

  const d = report.display;
  const s = report.sync;
  const taskGone = !!taskData && !taskData.task;
  //once the server holds the evidence the manager can see it, the notice must not say otherwise
  const kept = [EvidenceUploadState.received, EvidenceUploadState.reviewed].includes(evidenceOf(report).state);
  const retryable = s.state === ReportSyncState.queued || s.state === ReportSyncState.auth;

  return (
    <div className="report-detail task-detail">
      <Link to="/courier" className="task-detail__back"><ChevronLeftIcon fontSize="small" /> {t("back")}</Link>
      <h1>{t("sync_report_of", { number: displayNumber(d as any) })}</h1>

      {taskGone && <Alert severity="warning">{t(kept ? "sync_report_task_gone_kept" : "sync_report_task_gone")}</Alert>}

      <section className="task-section report-detail__sync">
        <div className="report-detail__chips">
          <StatusBadge status={report.outcome as any as IssuanceStatus} />
          <SyncChip state={s.state} />
        </div>
        <div className="muted small">{t("sync_saved_at", { time: formatDateTime(report.client_reported_at) })}</div>
        {report.ack && <div className="muted small">{t("sync_received_at", { time: formatDateTime(report.ack.reported_at) })}</div>}
        {s.state === ReportSyncState.queued && s.next_at && <div className="muted small">{t("sync_next_try", { time: formatDateTime(s.next_at) })}</div>}
        {s.state === ReportSyncState.conflict && s.conflict_code && <Alert severity="warning" icon={false}>{t(`conflict_${s.conflict_code}`)}</Alert>}
        <EvidenceLine report={report} scope={scope} />
        {s.last_error && s.state !== ReportSyncState.synced && <div className="report-detail__error small">{t("sync_last_error", { error: s.last_error })}</div>}
        {retryable && <Button variant="outlined" disabled={busy} onClick={retry}>{t("sync_retry")}</Button>}
      </section>

      <section className="task-section">
        <h2>{t("customer_details")}</h2>
        <div className="kv"><label>{t("customer_full_name")}</label><span>{d.customer_name}</span></div>
        <div className="kv"><label>{t("customer_phone")}</label><span>{d.customer_phone || "-"}</span></div>
        <div className="kv"><label>{t("customer_address")}</label><span>{[d.address_street, d.address_building].filter(Boolean).join(", ")}, {d.address_city}</span></div>
      </section>

      <section className="task-section task-section--readonly">
        <h2>{t("delivery_report")}</h2>
        {d.items.map((item) => {
          const a = report.payload.items.find((x) => x.item_id === item.id);
          return (
            <div key={item.id} className="kv">
              <label>{item.product_name}{item.catalog_number ? ` (${item.catalog_number})` : ""}</label>
              <span>
                {a?.delivered ? t("item_delivered") : `${t("item_not_delivered")}${a?.reason ? ` - ${t(reasonKeys[a.reason])}` : ""}`}
                {/* the reason and the free text next to each other read as one sentence without the dash */}
                {!a?.delivered && a?.reason_details ? <span className="muted small"> - {a.reason_details}</span> : null}
              </span>
            </div>
          );
        })}
        {d.recipient ? (
          <>
            <div className="kv"><label>{t("recipient_section")}</label><span>{d.recipient.name} {d.recipient.phone ? `(${d.recipient.phone})` : ""}</span></div>
            {d.recipient.id_number && <div className="kv"><label>{t("recipient_id_number")}</label><span>{d.recipient.id_number}</span></div>}
            {report.payload.signature_png && (
              <div className="kv"><label>{t("signature")}</label><img className="signature-image" src={report.payload.signature_png} alt="" /></div>
            )}
          </>
        ) : (
          //nothing was delivered: no one received and no one signed, by the rule
          <div className="kv"><label>{t("recipient_section")}</label><span className="muted">{t("no_handover_report")}</span></div>
        )}
      </section>
    </div>
  );
}
