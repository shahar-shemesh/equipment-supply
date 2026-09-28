import { useMediaQuery, useTheme } from "@mui/material";

//the ts side of styles/_breakpoints.scss. phone < 600, tablet 600..1199, desktop >= 1200 (mui sm and lg).
//compact = under 900 (phone + portrait tablet), where the board table turns into cards.
//use it only where the markup itself changes (table -> cards, nav -> drawer), plain css handles the rest
export function useBreakpoint() {
  const theme = useTheme();
  const phone = useMediaQuery(theme.breakpoints.down("sm"));
  const compact = useMediaQuery(theme.breakpoints.down("md"));
  const desktop = useMediaQuery(theme.breakpoints.up("lg"));
  return { phone, compact, tablet: !phone && !desktop, desktop };
}
