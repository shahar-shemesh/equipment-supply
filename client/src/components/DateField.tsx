import { useTranslation } from "react-i18next";
import CalendarMonthIcon from "@mui/icons-material/CalendarMonth";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { heIL } from "@mui/x-date-pickers/locales";
import dayjs, { Dayjs } from "dayjs";
import "dayjs/locale/he";

//the hebrew texts of the picker: the dialog buttons, the toolbar, the field placeholders
const pickerText = heIL.components.MuiLocalizationProvider.defaultProps.localeText;

//what the picker hands over: the iso day, "" for a field emptied (the x button, delete over every section), nothing for
//a date typed halfway. that one is an invalid day and the caller keeps the date it has until the typed one is whole
export function pickedDate(next: Dayjs | null): string | undefined {
  if (next === null) return "";
  return next.isValid() ? next.format("YYYY-MM-DD") : undefined;
}

/*──────────────────────────────────────────────────────────────────────────*/

type Props = {
  value: string; //YYYY-MM-DD, "" for none
  onChange: (next: string) => void;
  label?: string; //none when the caller prints its own label above the field (the detail dialog)
  disabled?: boolean;
  className?: string;
};

//a date on mui's own picker: a calendar under the field on a desktop, where the field also takes a date typed as
//DD/MM/YYYY, and a dialog on a touch screen, opened from the calendar button. the board's delivery date filter and the
//detail dialog's delivery date. it replaced native date inputs: safari on an iphone ignores showPicker() on a hidden
//one, and a visible one prints the browser's own order. the value in and out stays YYYY-MM-DD. the provider sits here
//and not at the app root so the pickers package stays in the manager's chunk, out of the courier's offline shell
//(vite.config.ts keeps the board's chunk out of the precache)
export function DateField({ value, onChange, label, disabled, className }: Props) {
  const { t } = useTranslation();

  function changed(next: Dayjs | null) {
    const date = pickedDate(next);
    if (date !== undefined) onChange(date);
  }

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="he" localeText={pickerText}>
      <DatePicker
        className={className}
        label={label}
        value={value ? dayjs(value) : null}
        onChange={changed}
        disabled={disabled}
        format="DD/MM/YYYY"
        slots={{ openPickerIcon: CalendarMonthIcon }}
        slotProps={{
          //the theme's small size is set on MuiTextField, the picker renders its own MuiPickersTextField
          textField: { size: "small" },
          //the calendar button leads, like the search icon of the board's search field; the x that clears the date trails
          field: { clearable: true, openPickerButtonPosition: "start", clearButtonPosition: "end" },
          openPickerButton: { title: t("open_calendar") },
          //the touch screen dialog keeps mui's centred box on a phone, see _manager.scss
          dialog: { className: "date-field__dialog" },
        }}
      />
    </LocalizationProvider>
  );
}
