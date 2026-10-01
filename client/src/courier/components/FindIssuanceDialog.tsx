import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FindNumberDialog } from "../../components/FindNumberDialog";
import { useAuth } from "../../utils/auth";
import { get } from "../../utils/service";
import { scopeOf } from "../offline/identity";
import { lookupLocal, refresh } from "../offline/store";

export function FindIssuanceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const scope = scopeOf(user);

  //A local miss only means "not on this device"; the server still checks courier ownership.
  async function lookup(number: string) {
    const local = scope ? await lookupLocal(scope, number) : null;
    if (local) return local;
    if (!navigator.onLine) throw new Error(t("offline_lookup_unavailable"));
    const res = await get("/delivery/lookup", { number });
    //The task page reads the device snapshot, including tasks assigned since the last refresh.
    if (scope) await refresh(scope);
    return res.task_id;
  }

  return open ? <FindNumberDialog lookup={lookup} onClose={onClose} onFound={(id) => navigate(`/courier/tasks/${id}`)} /> : null;
}
