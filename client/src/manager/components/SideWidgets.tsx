import { useState } from "react";
import { useTranslation } from "react-i18next";
import { InputAdornment, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";

import { ICourier } from "../../../../shared/@core";
import { useBreakpoint } from "../../utils/useBreakpoint";

//the two boxes on the side of the board: עומס שליחים and משלוחים לפי עיר
export function SideWidgets({ couriers, byCity }: { couriers: ICourier[]; byCity: { city: string; count: number }[] }) {
  const { t } = useTranslation();
  const [courierQ, setCourierQ] = useState("");
  const [cityQ, setCityQ] = useState("");

  const maxLoad = Math.max(...couriers.map((c) => c.pending || 0), 1);
  const visibleCouriers = couriers.filter((c) => c.name.includes(courierQ));
  const visibleCities = byCity.filter((c) => c.city.includes(cityQ));

  return (
    <aside className="side-widgets">
      <Widget title={t("widget_courier_load")}>
        <TextField
          placeholder={t("widget_courier_search")}
          value={courierQ}
          onChange={(e) => setCourierQ(e.target.value)}
          fullWidth
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <ul className="widget__list">
          {visibleCouriers.map((c) => (
            <li key={c.id}>
              <span>{c.name}</span>
              <span className="widget__count">{c.pending || 0}</span>
              {/* bar like the wireframe, relative to the busiest courier */}
              <i className="widget__bar" style={{ width: `${((c.pending || 0) / maxLoad) * 100}%` }} />
            </li>
          ))}
        </ul>
      </Widget>

      <Widget title={t("widget_by_city")}>
        <TextField
          placeholder={t("widget_city_search")}
          value={cityQ}
          onChange={(e) => setCityQ(e.target.value)}
          fullWidth
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
        />
        <ul className="widget__list">
          {visibleCities.map((c) => (
            <li key={c.city}>
              <span>{c.city}</span>
              <span className="widget__count">{c.count}</span>
            </li>
          ))}
        </ul>
      </Widget>
    </aside>
  );
}

/*──────────────────────────────────────────────────────────────────────────*/

//one box with the blue header from the design (the chevron in it is there already). the header toggles the body:
//open on tablet / desktop where there is room, closed on a phone where the table comes first and the widgets are extra
function Widget({ title, children }: { title: string; children: React.ReactNode }) {
  const { phone } = useBreakpoint();
  const [open, setOpen] = useState<boolean>(null); //null = the user did not touch it, follow the screen size
  const isOpen = open ?? !phone;

  return (
    <div className={`widget ${isOpen ? "" : "widget--collapsed"}`}>
      <button type="button" className="widget__header" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
        {title}
        <ExpandMoreIcon className="widget__chevron" />
      </button>
      {isOpen && <div className="widget__body">{children}</div>}
    </div>
  );
}
