import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Autocomplete, Button, Checkbox, Chip, InputAdornment, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import dayjs from "dayjs";

import { AuditAction } from "../../../../shared/@core";
import { DateField } from "../../components/DateField";
import { actionLabel } from "../../utils/auditFormat";

//an id with the text its chip prints. set from the drawer only, so the label is what the open row had
export type AuditRef = { id: number; label: string };

export type AuditFilterState = {
  q: string;
  actions: AuditAction[];
  from: string; //YYYY-MM-DD, "" for none
  to: string;
  actor: AuditRef | null;
  issuance: AuditRef | null;
};

export const emptyAuditFilters: AuditFilterState = { q: "", actions: [], from: "", to: "", actor: null, issuance: null };

export const SEARCH_MAX = 100; //Q_MAX of audit.validation.ts on the server, a longer value is a 400 there

//the query string form: the action list joins with a comma (the server reads it as IN), the chips send their ids, an
//empty value sends nothing at all. the two days go as date times in the zone they were picked in: the server reads a
//bare date as utc midnight, two or three hours before the warehouse's day starts; the end is exclusive, the next midnight
export function toAuditQuery(f: AuditFilterState) {
  const q: Record<string, string | number> = {};
  if (f.q.trim()) q.q = f.q.trim();
  if (f.actions.length) q.action = f.actions.join(",");
  if (f.from) q.from = dayjs(f.from).startOf("day").format();
  if (f.to) q.to = dayjs(f.to).add(1, "day").startOf("day").format();
  if (f.actor) q.actor_user_id = f.actor.id;
  if (f.issuance) q.issuance_id = f.issuance.id;
  return q;
}

//a window that ends before it starts. the same day twice is fine (the server reads a bare "to" as the end of that day).
//iso days compare as text
export function rangeInvalid(f: AuditFilterState) {
  return !!(f.from && f.to && f.from > f.to);
}

export function isDirty(f: AuditFilterState) {
  return !!(f.q || f.actions.length || f.from || f.to || f.actor || f.issuance);
}

const actionOptions = Object.values(AuditAction);

/*──────────────────────────────────────────────────────────────────────────*/

//the toolbar of the audit page on the board's classes: the search box and the chips on the first line, the action multi
//select, the two dates and the clear button on the second. every change goes up at once except the free text, which
//waits 400 ms like the board's. memoized like the table: the two pickers are not cheap to render and the drawer
//opening is none of their business
export const AuditFilters = memo(function AuditFilters({ filters, onChange }: { filters: AuditFilterState; onChange: (f: AuditFilterState) => void }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState(filters.q || "");

  //the filters as they are when the pause ends, not as the effect closed over them: an action picked while the text
  //waits would otherwise be undone by the stale copy
  const latest = useRef(filters);
  latest.current = filters;

  useEffect(() => {
    if (search === (filters.q || "")) return;
    const timer = setTimeout(() => onChange({ ...latest.current, q: search }), 400);
    return () => clearTimeout(timer);
  }, [search]);

  function set<K extends keyof AuditFilterState>(key: K, value: AuditFilterState[K]) {
    onChange({ ...filters, [key]: value });
  }

  const invalid = rangeInvalid(filters);
  const dateClass = `board-filters__date audit-filters__date ${invalid ? "is-invalid" : ""}`;

  return (
    <div className="board-filters audit-filters">
      <div className="board-filters__top">
        <TextField
          id="audit-search"
          className="board-filters__search"
          placeholder={t("audit_search_placeholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          inputProps={{ maxLength: SEARCH_MAX }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon /></InputAdornment> }}
        />

        {(filters.issuance || filters.actor) && (
          <div className="audit-filters__chips">
            {filters.issuance && <Chip size="small" className="audit-filters__chip" label={t("audit_filter_issuance", { number: filters.issuance.label })} onDelete={() => set("issuance", null)} />}
            {filters.actor && <Chip size="small" className="audit-filters__chip" label={t("audit_filter_actor", { name: filters.actor.label })} onDelete={() => set("actor", null)} />}
          </div>
        )}
      </div>

      <div className="board-filters__row">
        <ActionFilterField value={filters.actions} onChange={(next) => set("actions", next)} />

        <DateField className={dateClass} label={t("audit_filter_from")} value={filters.from} onChange={(next) => set("from", next)} />
        <DateField className={dateClass} label={t("audit_filter_to")} value={filters.to} onChange={(next) => set("to", next)} />

        {isDirty(filters) && (
          <Button variant="text" className="board-filters__clear" onClick={() => { setSearch(""); onChange(emptyAuditFilters); }}>
            {t("audit_filter_clear")}
          </Button>
        )}
      </div>

      {invalid && <div className="field-error audit-filters__range-error" role="alert">{t("audit_filter_range_invalid")}</div>}
    </div>
  );
});

/*──────────────────────────────────────────────────────────────────────────*/

//any number of actions, the city field's pattern (BoardFilters.tsx): a checkbox per action, the list stays open while
//they are picked, the picked ones sit in the field as chips. nothing picked = every action
export function ActionFilterField({ value, onChange }: { value: AuditAction[]; onChange: (next: AuditAction[]) => void }) {
  const { t } = useTranslation();

  return (
    <Autocomplete
      multiple
      disableCloseOnSelect
      className="audit-filters__actions"
      options={actionOptions}
      value={value}
      onChange={(_, next) => onChange(next)}
      getOptionLabel={(a) => actionLabel(a, t)}
      limitTags={1}
      ChipProps={{ size: "small" }}
      noOptionsText={t("audit_filter_actions_none")}
      openText={t("audit_filter_actions_open")}
      closeText={t("close")}
      clearText={t("clear")}
      renderOption={(props, action, { selected }) => {
        const { key, ...rest } = props;
        return (
          <li key={key} {...rest} className={`${rest.className} board-filters__city-option`}>
            <Checkbox size="small" checked={selected} tabIndex={-1} />
            {actionLabel(action, t)}
          </li>
        );
      }}
      renderInput={(params) => <TextField {...params} label={t("audit_filter_actions")} placeholder={value.length ? "" : t("audit_filter_actions_search")} />}
    />
  );
}
