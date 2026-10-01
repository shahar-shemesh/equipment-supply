import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import DragIndicatorIcon from "@mui/icons-material/DragIndicator";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

import { IDeliveryTask, IssuanceStatus, ReportSyncState, TaskStatus } from "../../../../shared/@core";
import { StatusBadge } from "../../components/StatusBadge";
import { displayNumber, fullAddress } from "../../utils/format";
import { SyncChip } from "./SyncChip";

//what the courier card should show as status: an open task is ממתין, a closed one shows how it ended.
//a report saved on this device already moved task.status and issuance.status (the overlay in the data layer)
function cardStatus(task: IDeliveryTask) {
  return task.status === TaskStatus.pending ? IssuanceStatus.assigned : task.issuance.status;
}

//the chip next to the badge says only what the courier still has to care about: the report is on this device only, or
//the server refused it. a report the server took is the normal ending and the task screen says so, the board does not
function cardChip(task: IDeliveryTask) {
  const r = task.local_report;
  if (!r || r.state === ReportSyncState.synced) return null;
  return <SyncChip state={r.state} short />;
}

export function TaskCard({ task }: { task: IDeliveryTask }) {
  const navigate = useNavigate();
  const i = task.issuance;
  return (
    <div className="task-card" onClick={() => navigate(`/courier/tasks/${task.id}`)}>
      {/* drag handle like the design. reordering the route is not implemented, the handle is only visual for now */}
      <DragIndicatorIcon className="task-card__handle" />
      <div className="task-card__number">{displayNumber(i)}</div>
      <div className="task-card__city">{i.address_city}</div>
      <div className="task-card__address">{fullAddress(i)}</div>
      <div className="task-card__customer">
        <div>{i.customer_name}</div>
        <div className="muted">{i.customer_phone}</div>
      </div>
      <div className="task-card__status">
        <StatusBadge status={cardStatus(task)} />
        {cardChip(task)}
      </div>
    </div>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//two or more issuances to the same customer + address, collapsed into one card with sub rows
export function TaskGroupCard({ tasks }: { tasks: IDeliveryTask[] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const first = tasks[0].issuance;

  const delivered = tasks.filter((x) => cardStatus(x) === IssuanceStatus.delivered).length;
  const pending = tasks.filter((x) => x.status === TaskStatus.pending).length;
  //group badge: all waiting -> ממתין, all delivered -> נמסר, otherwise נמסר חלקית like the design
  const groupStatus = pending === tasks.length ? IssuanceStatus.assigned : delivered === tasks.length ? IssuanceStatus.delivered : IssuanceStatus.partially_delivered;

  return (
    <div className={`task-card task-card--group ${open ? "is-open" : ""}`}>
      <div className="task-card__row" onClick={() => setOpen(!open)}>
        <DragIndicatorIcon className="task-card__handle" />
        <div className="task-card__number">{t("group_count", { count: tasks.length })}</div>
        <div className="task-card__city">{first.address_city}</div>
        <div className="task-card__address">{fullAddress(first)}</div>
        <div className="task-card__customer">
          <div>{first.customer_name}</div>
          <div className="muted">{first.customer_phone}</div>
        </div>
        <div className="task-card__status"><StatusBadge status={groupStatus} /></div>
        {open ? <ExpandLessIcon className="task-card__chevron" /> : <ExpandMoreIcon className="task-card__chevron" />}
      </div>

      {open && tasks.map((task) => (
        <div key={task.id} className="task-card__sub" onClick={() => navigate(`/courier/tasks/${task.id}`)}>
          <div className="task-card__number">{displayNumber(task.issuance)}</div>
          <div className="task-card__status">
            <StatusBadge status={cardStatus(task)} />
            {cardChip(task)}
          </div>
        </div>
      ))}
    </div>
  );
}
