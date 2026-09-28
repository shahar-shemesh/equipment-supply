import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Button, CircularProgress, InputAdornment, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import CheckIcon from "@mui/icons-material/Check";
import RefreshIcon from "@mui/icons-material/Refresh";

import { groupByAddress } from "../../../../shared/@utils";
import { useAuth } from "../../utils/auth";
import { greetingKey, todayLong } from "../../utils/format";
import { scopeOf } from "../offline/identity";
import { Tab, refresh, refreshIfStale } from "../offline/store";
import { useBoard } from "../offline/useCourierData";
import { TaskCard, TaskGroupCard } from "../components/TaskCard";
import { FindIssuanceDialog } from "../components/FindIssuanceDialog";

//לוח משלוחים - the courier home. tabs + search + one card per issuance, same address collapses to a group card.
//everything shown comes from the local snapshot (useBoard), the server is only asked to refresh that snapshot
export default function DeliveryBoard() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const scope = scopeOf(user);

  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState(""); //debounced copy of search
  const [findOpen, setFindOpen] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const { data, error } = useBoard(scope, tab, query);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  //a snapshot older than five minutes is pulled again when the board opens. a failed pull keeps the rows on screen
  useEffect(() => {
    if (!scope || !navigator.onLine) return;
    let cancelled = false;
    refreshIfStale(scope, 5 * 60_000).then((r) => {
      if (!cancelled) setRefreshFailed(!r.ok);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  async function refreshNow() {
    setRefreshing(true);
    const r = await refresh(scope);
    setRefreshFailed(!r.ok);
    setRefreshing(false);
  }

  const counts = data?.counts || { all: 0, pending: 0, done: 0 };
  const groups = groupByAddress(data?.rows || []);

  return (
    <div className="delivery-board">
      <div className="delivery-board__head">
        <div>
          <h1>{t(greetingKey())} {user?.display_name?.split(" ")[0]}</h1>
          <div className="delivery-board__date">{todayLong()}</div>
        </div>
        <Button variant="outlined" startIcon={<QrCodeScannerIcon />} onClick={() => setFindOpen(true)}>
          {t("find_issuance")}
        </Button>
      </div>

      <TextField
        className="delivery-board__search"
        placeholder={t("courier_search_placeholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        fullWidth
        InputProps={{ endAdornment: <InputAdornment position="end"><span className="search-fab"><SearchIcon /></span></InputAdornment> }}
      />

      {/* segmented control from the component library. the counts cover the whole snapshot, not the search results */}
      <div className="segmented">
        <button type="button" className={tab === "all" ? "is-active" : ""} onClick={() => setTab("all")}>
          <Inventory2OutlinedIcon fontSize="small" /> {t("tab_all")} ({counts.all})
        </button>
        <button type="button" className={tab === "pending" ? "is-active" : ""} onClick={() => setTab("pending")}>
          <AccessTimeIcon fontSize="small" /> {t("tab_pending")} ({counts.pending})
        </button>
        <button type="button" className={tab === "done" ? "is-active" : ""} onClick={() => setTab("done")}>
          <CheckIcon fontSize="small" /> {t("tab_done")} ({counts.done})
        </button>
      </div>

      {error && <Alert severity="error">{t(error)}</Alert>}
      {refreshFailed && data?.ready && <Alert severity="warning" onClose={() => setRefreshFailed(false)}>{t("offline_refresh_failed")}</Alert>}

      <div className="delivery-board__list">
        {!data && !error && <div className="page-loading"><CircularProgress /></div>}
        {/* three states: nothing was ever downloaded, downloaded but empty, rows */}
        {data && groups.length === 0 && !data.ready && (
          <div className="delivery-board__empty">
            <div>{t("offline_no_data")}</div>
            {navigator.onLine && (
              <Button variant="outlined" startIcon={<RefreshIcon />} disabled={refreshing} onClick={refreshNow}>{t("offline_refresh")}</Button>
            )}
          </div>
        )}
        {data && groups.length === 0 && data.ready && <div className="delivery-board__empty">{t("courier_empty")}</div>}
        {groups.map((g) => (g.rows.length > 1 ? <TaskGroupCard key={g.key} tasks={g.rows} /> : <TaskCard key={g.rows[0].id} task={g.rows[0]} />))}
      </div>

      <FindIssuanceDialog open={findOpen} onClose={() => setFindOpen(false)} />
    </div>
  );
}
