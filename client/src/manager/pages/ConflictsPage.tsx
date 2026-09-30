import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert } from "@mui/material";

import { ConflictReviewStatus, IDeliveryConflict } from "../../../../shared/@core";
import { errorMessage, get } from "../../utils/service";
import { displayNumber, formatDateTime } from "../../utils/format";
import { ConflictDetailDialog } from "../components/ConflictDetailDialog";

const PAGE_SIZE = 20;

//דוחות לבדיקה - delivery reports the tablets signed after the issuance had changed, kept on the server as evidence.
//reading and "סימון כנבדק" only: nothing on this page changes a delivery, and the intro line says so. the list carries
//no signatures or answers, those come with the row when it is opened
export default function ConflictsPage() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ConflictReviewStatus>(ConflictReviewStatus.pending);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ rows: IDeliveryConflict[]; total: number }>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openId, setOpenId] = useState<number>(null);

  async function load() {
    setLoading(true);
    setError("");
    try {
      setData(await get("/conflicts", { status: tab, page, page_size: PAGE_SIZE }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [tab, page]);

  function pick(next: ConflictReviewStatus) {
    setTab(next);
    setPage(1);
  }

  const from = data.total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(page * PAGE_SIZE, data.total);
  const lastPage = Math.max(Math.ceil(data.total / PAGE_SIZE), 1);

  return (
    <div className="conflicts-page">
      <h1>{t("conflicts_title")}</h1>
      <p className="conflicts-page__intro muted">{t("conflicts_intro")}</p>

      {/* the courier board's pill, two segments here */}
      <div className="segmented conflicts-page__tabs">
        <button type="button" className={tab === ConflictReviewStatus.pending ? "is-active" : ""} onClick={() => pick(ConflictReviewStatus.pending)}>{t("conflicts_tab_pending")}</button>
        <button type="button" className={tab === ConflictReviewStatus.reviewed ? "is-active" : ""} onClick={() => pick(ConflictReviewStatus.reviewed)}>{t("conflicts_tab_reviewed")}</button>
      </div>

      {error && <Alert severity="error">{error}</Alert>}

      <div className="board__range">
        <span>{t("conflicts_range", { from, to, total: data.total })}</span>
        <button type="button" className="board__page-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>{"›"}</button>
        <button type="button" className="board__page-btn" disabled={page >= lastPage} onClick={() => setPage(page + 1)}>{"‹"}</button>
      </div>

      <div className={`issuances-table table--stack-phone ${loading ? "issuances-table--loading" : ""}`}>
        <table>
          <thead>
            <tr>
              <th>{t("col_number")}</th>
              <th>{t("col_customer")}</th>
              <th>{t("conflict_courier")}</th>
              <th>{t("col_conflict_reason")}</th>
              <th>{t("col_reported_at")}</th>
              <th>{t("col_received_at")}</th>
              <th>{t("col_review")}</th>
              <th className="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {data.rows.length === 0 && !loading && (
              <tr><td colSpan={8} className="issuances-table__empty">{t("conflicts_empty")}</td></tr>
            )}
            {data.rows.map((r) => (
              <tr key={r.id} className="conflicts-page__row" onClick={() => setOpenId(r.id)}>
                <td data-label={t("col_number")} className="issuances-table__number">{r.issuance ? displayNumber(r.issuance) : r.issuance_id}</td>
                <td data-label={t("col_customer")} className="col-wrap">{r.issuance?.customer_name || "-"}</td>
                <td data-label={t("conflict_courier")}>{r.courier?.name || "-"}</td>
                <td data-label={t("col_conflict_reason")} className="col-wrap">{t(`conflict_reason_${r.rejection_code}`)}</td>
                <td data-label={t("col_reported_at")}>{r.client_reported_at ? formatDateTime(r.client_reported_at) : "-"}</td>
                <td data-label={t("col_received_at")}>{formatDateTime(r.received_at)}</td>
                <td data-label={t("col_review")} className="col-wrap">
                  {r.review_status === ConflictReviewStatus.reviewed ? t("conflict_reviewed_by", { name: r.reviewed_by_name || "", time: formatDateTime(r.reviewed_at) }) : t("conflicts_tab_pending")}
                </td>
                <td className="col-actions"><button type="button" className="link-button">{t("conflict_open")}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConflictDetailDialog id={openId} onClose={() => setOpenId(null)} onChanged={load} />
    </div>
  );
}
