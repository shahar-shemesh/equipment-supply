import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, InputAdornment, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";
import Inventory2OutlinedIcon from "@mui/icons-material/Inventory2Outlined";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import CheckIcon from "@mui/icons-material/Check";

import { IDeliveryTask } from "../../../../shared/@core";
import { groupByAddress } from "../../../../shared/@utils";
import { useAuth } from "../../utils/auth";
import { get } from "../../utils/service";
import { greetingKey, todayLong } from "../../utils/format";
import { TaskCard, TaskGroupCard } from "../components/TaskCard";
import { FindIssuanceDialog } from "../components/FindIssuanceDialog";

type Tab = "all" | "pending" | "done";

//לוח משלוחים - the courier home. tabs + search + one card per issuance, same address collapses to a group card
export default function DeliveryBoard() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState(""); //debounced copy of search
  const [data, setData] = useState<{ rows: IDeliveryTask[]; counts: any }>({ rows: [], counts: { all: 0, pending: 0, done: 0 } });
  const [findOpen, setFindOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    get("/delivery/tasks", { tab, search: query }).then(setData).catch(() => setData({ rows: [], counts: { all: 0, pending: 0, done: 0 } }));
  }, [tab, query]);

  const groups = groupByAddress(data.rows);

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

      {/* segmented control from the component library */}
      <div className="segmented">
        <button type="button" className={tab === "all" ? "is-active" : ""} onClick={() => setTab("all")}>
          <Inventory2OutlinedIcon fontSize="small" /> {t("tab_all")} ({data.counts.all})
        </button>
        <button type="button" className={tab === "pending" ? "is-active" : ""} onClick={() => setTab("pending")}>
          <AccessTimeIcon fontSize="small" /> {t("tab_pending")} ({data.counts.pending})
        </button>
        <button type="button" className={tab === "done" ? "is-active" : ""} onClick={() => setTab("done")}>
          <CheckIcon fontSize="small" /> {t("tab_done")} ({data.counts.done})
        </button>
      </div>

      <div className="delivery-board__list">
        {groups.length === 0 && <div className="delivery-board__empty">{t("courier_empty")}</div>}
        {groups.map((g) => (g.rows.length > 1 ? <TaskGroupCard key={g.key} tasks={g.rows} /> : <TaskCard key={g.rows[0].id} task={g.rows[0]} />))}
      </div>

      <FindIssuanceDialog open={findOpen} onClose={() => setFindOpen(false)} />
    </div>
  );
}
