import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Checkbox, InputAdornment, ListItemText, MenuItem, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import dayjs from "dayjs";

import { IssuanceStatus, Priority } from "../../../../shared/@core";
import { priorityKeys } from "../../../../shared/@utils";
import { StatusBadge } from "../../components/StatusBadge";

//status and city are lists (the quick actions, the multi select), everything else is one value or nothing
export const emptyFilters = { search: "", status: [] as string[], priority: "", customer: "", city: [] as string[], date: "" };

//the board opens on today's deliveries
export function initialFilters() {
  return { ...emptyFilters, date: dayjs().format("YYYY-MM-DD") };
}

//the query string form of the filters: a list joins with a comma (the server reads it as IN), an empty list or an
//empty string sends nothing at all
export function toQuery(filters: any) {
  const q: Record<string, string> = {};
  for (const key of Object.keys(filters)) {
    const v = filters[key];
    const value = Array.isArray(v) ? v.filter(Boolean).join(",") : v;
    if (value) q[key] = value;
  }
  return q;
}

//the statuses the manager can filter by. deleted rows never show on the board
const statusOptions = [
  IssuanceStatus.unassigned,
  IssuanceStatus.assigned,
  IssuanceStatus.delivered,
  IssuanceStatus.partially_delivered,
  IssuanceStatus.not_delivered,
  IssuanceStatus.self_pickup,
];

/*──────────────────────────────────────────────────────────────────────────*/

export function BoardFilters({ filters, cities, onChange }: { filters: any; cities: string[]; onChange: (f: any) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(filters.search || "");

  //free text goes to the server after a short pause, the dropdowns go right away
  useEffect(() => {
    if (search === (filters.search || "")) return;
    const timer = setTimeout(() => onChange({ ...filters, search }), 400);
    return () => clearTimeout(timer);
  }, [search]);

  function set(key: string, value: any) {
    onChange({ ...filters, [key]: value });
  }

  const dirty = Object.keys(emptyFilters).some((k) => (Array.isArray(filters[k]) ? filters[k].length > 0 : !!filters[k]));

  return (
    <div className="board-filters">
      <div className="board-filters__top">
        <TextField
          id="board-search"
          className="board-filters__search"
          placeholder={t("board_search_placeholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
        />

        <StatusQuickActions value={filters.status || []} onChange={(next) => set("status", next)} />
      </div>

      <div className="board-filters__row">
        <TextField type="date" label={t("filter_date")} value={filters.date} onChange={(e) => set("date", e.target.value)} InputLabelProps={{ shrink: true }} />

        <TextField select label={t("filter_priority")} value={filters.priority} onChange={(e) => set("priority", e.target.value)}>
          <MenuItem value="">{t("filter_all")}</MenuItem>
          {Object.values(Priority).map((p) => (
            <MenuItem key={p} value={p}>{t(priorityKeys[p])}</MenuItem>
          ))}
        </TextField>

        <TextField label={t("filter_customer")} value={filters.customer} onChange={(e) => set("customer", e.target.value)} />

        {/* any number of cities, the field prints the picked ones. nothing picked = every city */}
        <TextField
          select
          label={t("filter_city")}
          value={filters.city || []}
          //browser autofill hands a multiple select one comma string instead of the array, mui documents the split
          onChange={(e) => set("city", typeof e.target.value === "string" ? (e.target.value as string).split(",") : e.target.value)}
          SelectProps={{ multiple: true, renderValue: (picked: any) => (picked as string[]).join(", ") }}
        >
          {(cities || []).map((c) => (
            <MenuItem key={c} value={c}>
              <Checkbox size="small" checked={(filters.city || []).includes(c)} />
              <ListItemText primary={c} />
            </MenuItem>
          ))}
        </TextField>

        {dirty && (
          <Button variant="text" className="board-filters__clear" onClick={() => { setSearch(""); onChange(emptyFilters); }}>
            {t("filter_clear")}
          </Button>
        )}
      </div>
    </div>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//the six statuses as toggle buttons in the colors of the board badges. any number can be on at once and the server
//gets them as one list; none on is no status filter
function StatusQuickActions({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation();

  function toggle(s: IssuanceStatus) {
    onChange(value.includes(s) ? value.filter((x) => x !== s) : [...value, s]);
  }

  return (
    <div className="board-filters__quick" role="group" aria-label={t("filter_status")}>
      {statusOptions.map((s) => (
        <button key={s} type="button" className={`status-quick ${value.includes(s) ? "is-active" : ""}`} aria-pressed={value.includes(s)} onClick={() => toggle(s)}>
          <StatusBadge status={s} managerView />
        </button>
      ))}
    </div>
  );
}
