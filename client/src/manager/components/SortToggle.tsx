import { useTranslation } from "react-i18next";
import { ToggleButton, ToggleButtonGroup } from "@mui/material";

export type SortMode = "name" | "load";

//the "לפי שם / לפי עומס" pair of the spec (4.1, 4.2), the same two buttons over the courier load, the cities and the assign
//list. the list itself goes through sortRows below, after the search filtered it, so the count and the order see the same rows
export function SortToggle({ value, onChange }: { value: SortMode; onChange: (next: SortMode) => void }) {
  const { t } = useTranslation();

  return (
    //exclusive hands back null when the pressed button is the selected one, which is not a change
    <ToggleButtonGroup className="sort-toggle" size="small" exclusive value={value} onChange={(_, next) => next && onChange(next)} aria-label={t("sort_by")}>
      <ToggleButton value="name">{t("sort_by_name")}</ToggleButton>
      <ToggleButton value="load">{t("sort_by_load")}</ToggleButton>
    </ToggleButtonGroup>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//by name in hebrew order, or the busiest first with the name deciding a tie. returns a new array, the input stays as it was
export function sortRows<T>(rows: T[], mode: SortMode, nameOf: (row: T) => string, loadOf: (row: T) => number) {
  const byName = (a: T, b: T) => nameOf(a).localeCompare(nameOf(b), "he");
  return [...rows].sort(mode === "load" ? (a, b) => loadOf(b) - loadOf(a) || byName(a, b) : byName);
}
