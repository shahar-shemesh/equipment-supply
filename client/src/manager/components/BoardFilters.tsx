import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Autocomplete, Button, Checkbox, InputAdornment, MenuItem, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import dayjs from "dayjs";

import { IssuanceStatus, Priority } from "../../../../shared/@core";
import { priorityKeys } from "../../../../shared/@utils";
import { DateField } from "../../components/DateField";
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
        <DateField className="board-filters__date" label={t("filter_date")} value={filters.date} onChange={(next) => set("date", next)} />

        <TextField select label={t("filter_priority")} value={filters.priority} onChange={(e) => set("priority", e.target.value)}>
          <MenuItem value="">{t("filter_all")}</MenuItem>
          {Object.values(Priority).map((p) => (
            <MenuItem key={p} value={p}>{t(priorityKeys[p])}</MenuItem>
          ))}
        </TextField>

        <TextField label={t("filter_customer")} value={filters.customer} onChange={(e) => set("customer", e.target.value)} />

        <CityFilterField value={filters.city || []} cities={cities || []} onChange={(next) => set("city", next)} />

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

//any number of cities: the field is the search box over the cities of the board, the list has a checkbox per city and
//stays open while they are picked, the picked ones sit in the field as chips. nothing picked = every city
export function CityFilterField({ value, cities, onChange }: { value: string[]; cities: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation();

  return (
    <Autocomplete
      multiple
      disableCloseOnSelect
      className="board-filters__city"
      options={cities}
      value={value}
      onChange={(_, next) => onChange(next)}
      limitTags={1}
      ChipProps={{ size: "small" }}
      noOptionsText={t("filter_city_none")}
      openText={t("filter_city_open")}
      closeText={t("close")}
      clearText={t("clear")}
      renderOption={(props, city, { selected, inputValue }) => {
        const { key, ...rest } = props;
        return (
          <li key={key} {...rest} className={`${rest.className} board-filters__city-option`}>
            <Checkbox size="small" checked={selected} tabIndex={-1} />
            <Highlight text={city} query={inputValue} />
          </li>
        );
      }}
      renderInput={(params) => <TextField {...params} label={t("filter_city")} placeholder={value.length ? "" : t("filter_city_search")} />}
    />
  );
}

//the typed text in bold inside a city, the way a search result marks its match. mui's filter ignores the case and the
//spaces around the text, this follows it
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  const at = q ? text.toLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</>;
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
