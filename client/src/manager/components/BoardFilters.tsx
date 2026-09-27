import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, InputAdornment, MenuItem, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";

import { IssuanceStatus, Priority } from "../../../../shared/@core";
import { priorityKeys } from "../../../../shared/@utils";

export const emptyFilters = { search: "", status: "", priority: "", customer: "", city: "", date: "" };

//the statuses the manager can filter by. deleted rows never show on the board
const statusOptions = [
  IssuanceStatus.unassigned,
  IssuanceStatus.assigned,
  IssuanceStatus.delivered,
  IssuanceStatus.partially_delivered,
  IssuanceStatus.not_delivered,
  IssuanceStatus.self_pickup,
];

export function BoardFilters({ filters, cities, onChange }: { filters: any; cities: string[]; onChange: (f: any) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(filters.search || "");

  //free text goes to the server after a short pause, the dropdowns go right away
  useEffect(() => {
    if (search === (filters.search || "")) return;
    const timer = setTimeout(() => onChange({ ...filters, search }), 400);
    return () => clearTimeout(timer);
  }, [search]);

  function set(key: string, value: string) {
    onChange({ ...filters, [key]: value });
  }

  const dirty = Object.keys(emptyFilters).some((k) => !!filters[k]);

  return (
    <div className="board-filters">
      <TextField
        id="board-search"
        className="board-filters__search"
        placeholder={t("board_search_placeholder")}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        fullWidth
        InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
      />

      <div className="board-filters__row">
        <TextField type="date" label={t("filter_date")} value={filters.date} onChange={(e) => set("date", e.target.value)} InputLabelProps={{ shrink: true }} />

        <TextField select label={t("filter_status")} value={filters.status} onChange={(e) => set("status", e.target.value)}>
          <MenuItem value="">{t("filter_all")}</MenuItem>
          {statusOptions.map((s) => (
            <MenuItem key={s} value={s}>{t(s === IssuanceStatus.assigned ? "status_assigned_manager" : `status_${s}`)}</MenuItem>
          ))}
        </TextField>

        <TextField select label={t("filter_priority")} value={filters.priority} onChange={(e) => set("priority", e.target.value)}>
          <MenuItem value="">{t("filter_all")}</MenuItem>
          {Object.values(Priority).map((p) => (
            <MenuItem key={p} value={p}>{t(priorityKeys[p])}</MenuItem>
          ))}
        </TextField>

        <TextField label={t("filter_customer")} value={filters.customer} onChange={(e) => set("customer", e.target.value)} />

        <TextField select label={t("filter_city")} value={filters.city} onChange={(e) => set("city", e.target.value)}>
          <MenuItem value="">{t("filter_all")}</MenuItem>
          {(cities || []).map((c) => (
            <MenuItem key={c} value={c}>{c}</MenuItem>
          ))}
        </TextField>

        {dirty && (
          <Button variant="text" onClick={() => { setSearch(""); onChange(emptyFilters); }}>
            {t("filter_clear")}
          </Button>
        )}
      </div>
    </div>
  );
}
