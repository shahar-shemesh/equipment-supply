import { useState } from "react";
import { useTranslation } from "react-i18next";
import { InputAdornment, TextField } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";

import { ICourier } from "../../../../shared/@core";

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
      <div className="widget">
        <div className="widget__header">{t("widget_courier_load")}</div>
        <div className="widget__body">
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
        </div>
      </div>

      <div className="widget">
        <div className="widget__header">{t("widget_by_city")}</div>
        <div className="widget__body">
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
        </div>
      </div>
    </aside>
  );
}
