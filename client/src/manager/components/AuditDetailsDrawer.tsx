import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Drawer, IconButton } from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import FilterListIcon from "@mui/icons-material/FilterList";

import { IAuditEntry } from "../../../../shared/@core";
import { actionLabel, actorLabel, changeRows, detailRows, entityIdLabel, entityTypeLabel, issuanceLabel, roleLabel, summary } from "../../utils/auditFormat";
import { formatDateTime } from "../../utils/format";
import { AuditRef } from "./AuditFilters";

type Props = {
  entry: IAuditEntry | null; //null closes the drawer
  onClose: () => void;
  onFilterIssuance: (ref: AuditRef) => void; //"every event of this issuance": the page sets the issuance chip
  onFilterActor: (ref: AuditRef) => void;
};

/*──────────────────────────────────────────────────────────────────────────*/

//one event, readable: the general rows, the before / after table of an edit, the other details as label / value, and
//the raw row folded away at the end. nothing here writes anything
export function AuditDetailsDrawer({ entry, onClose, onFilterIssuance, onFilterActor }: Props) {
  const { t } = useTranslation();
  const e = entry;
  const changes = e ? changeRows(e, t) : [];
  const details = e ? detailRows(e, t) : [];

  return (
    //"right" lands on the visual left, the end side: mui mirrors the anchor under direction rtl and the stylis plugin
    //flips the css again (ManagerLayout.tsx has the same note for its "left"). full width on a phone, see _manager.scss
    <Drawer anchor="right" open={!!e} onClose={onClose} className="audit-drawer">
      {e && (
        <div className="audit-drawer__body">
          <div className="dialog-title-row">
            <h2>{t("audit_drawer_title")}</h2>
            <IconButton onClick={onClose} aria-label={t("close")}><CloseIcon /></IconButton>
          </div>

          <div className="audit-drawer__action">{actionLabel(e.action, t)}</div>
          <p className="audit-drawer__summary">{summary(e, t)}</p>

          <section className="detail-dialog__section">
            <div className="kv"><label>{t("audit_drawer_at")}</label><span>{formatDateTime(e.at)}</span></div>
            <div className="kv"><label>{t("audit_drawer_actor")}</label><span>{actorLabel(e, t)}{e.actor_role ? ` (${roleLabel(e.actor_role, t)})` : ""}</span></div>
            <div className="kv"><label>{t("audit_drawer_entity_type")}</label><span>{entityTypeLabel(e.entity_type, t)}</span></div>
            {/* the issuance number on a delivery or a rejected report too; the task or report id itself is in the details */}
            {entityIdLabel(e, t) && <div className="kv"><label>{t("audit_drawer_entity_ref")}</label><span>{entityIdLabel(e, t)}</span></div>}
            {e.batch_id && <div className="kv"><label>{t("audit_drawer_batch")}</label><span>{t("yes")}</span></div>}
          </section>

          {changes.length > 0 && (
            <section className="detail-dialog__section">
              <h3>{t("audit_drawer_changes")}</h3>
              <table className="audit-changes">
                <thead>
                  <tr><th>{t("audit_changes_field")}</th><th>{t("audit_changes_from")}</th><th>{t("audit_changes_to")}</th></tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.field}><td>{c.label}</td><td>{c.from}</td><td>{c.to}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {details.length > 0 && (
            <section className="detail-dialog__section">
              <h3>{t("audit_drawer_details")}</h3>
              {details.map((d) => (
                <div key={d.key} className="kv"><label>{d.label}</label><span>{d.value}</span></div>
              ))}
            </section>
          )}

          <TechnicalDetails entry={e} />

          <div className="audit-drawer__actions">
            {e.issuance_id != null && (
              <Button variant="outlined" startIcon={<FilterListIcon />} onClick={() => onFilterIssuance({ id: e.issuance_id, label: issuanceLabel(e) })}>
                {t("audit_drawer_filter_issuance")}
              </Button>
            )}
            {e.actor_user_id != null && (
              <Button variant="outlined" startIcon={<FilterListIcon />} onClick={() => onFilterActor({ id: e.actor_user_id, label: actorLabel(e, t) })}>
                {t("audit_drawer_filter_actor")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//the raw row, folded away. the json is built when the manager unfolds it, not when the drawer opens: a seed or an
//import row carries a details object of some size and the fold is rarely opened. the flag lives here, not in the
//drawer, so it goes away with the body and the next row starts folded
function TechnicalDetails({ entry }: { entry: IAuditEntry }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <details className="audit-drawer__technical" onToggle={(ev) => setOpen(ev.currentTarget.open)}>
      <summary>{t("audit_drawer_technical")}</summary>
      {open && <pre>{JSON.stringify(entry, null, 2)}</pre>}
    </details>
  );
}
