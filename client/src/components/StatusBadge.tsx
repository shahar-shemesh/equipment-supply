import { useTranslation } from "react-i18next";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import BlockIcon from "@mui/icons-material/Block";
import RemoveCircleIcon from "@mui/icons-material/RemoveCircle";
import PersonIcon from "@mui/icons-material/Person";

import { IssuanceStatus, Priority } from "../../../shared/@core";
import { statusKeys } from "../../../shared/@utils";

const icons: Partial<Record<IssuanceStatus, any>> = {
  [IssuanceStatus.assigned]: AccessTimeIcon,
  [IssuanceStatus.delivered]: CheckCircleIcon,
  [IssuanceStatus.not_delivered]: BlockIcon,
  [IssuanceStatus.partially_delivered]: RemoveCircleIcon,
  [IssuanceStatus.self_pickup]: PersonIcon,
};

export function StatusBadge({ status, managerView = false }: { status: IssuanceStatus; managerView?: boolean }) {
  const { t } = useTranslation();
  //same status, two words: the courier sees ממתין, the manager board says שובץ למשנע
  const key = managerView && status === IssuanceStatus.assigned ? "status_assigned_manager" : statusKeys[status];
  const Icon = icons[status];
  return (
    <span className={`status-badge status-badge--${status}`}>
      {Icon && <Icon fontSize="inherit" />}
      {t(key)}
    </span>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

export function PriorityBadge({ priority }: { priority: Priority }) {
  const { t } = useTranslation();
  if (priority !== Priority.urgent) return null;
  return <span className="priority-badge">{t("priority_urgent")}</span>;
}
