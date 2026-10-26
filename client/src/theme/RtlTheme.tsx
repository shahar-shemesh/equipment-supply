import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { createTheme, CssBaseline, ThemeProvider } from "@mui/material";
import { prefixer } from "stylis";
import rtlPlugin from "stylis-plugin-rtl";

// https://mui.com/material-ui/customization/right-to-left/
const cacheRtl = createCache({ key: "muirtl", stylisPlugins: [prefixer, rtlPlugin] });

//colors from the actual screens in design/ (blue #0A52BD). the style-guide page says #0A6E8A but no screen uses it,
//so until the designers answer which one wins, the screens win.
//breakpoints stay at the mui defaults (sm 600, md 900, lg 1200), styles/_breakpoints.scss uses the same numbers
const theme = createTheme({
  direction: "rtl",
  typography: { fontFamily: "Rubik, Arial" },
  palette: {
    primary: { main: "#0A52BD", dark: "#084297", light: "#3B75CA" },
    text: { primary: "#1A2B3D", secondary: "#5C6B7A" },
    background: { default: "#F5F7FA", paper: "#FFFFFF" },
    error: { main: "#D32F2F" },
    success: { main: "#2ECC71" },
  },
  shape: { borderRadius: 8 },
  components: {
    MuiButton: { styleOverrides: { root: { textTransform: "none", fontWeight: 500, boxShadow: "none" } } },
    MuiTextField: { defaultProps: { size: "small" } },
    MuiSelect: { defaultProps: { size: "small" } },
    //no scroll lock on any modal (dialog, menu, select, drawer all sit on MuiModal): the lock hides the page scrollbar
    //and pads body by its width, but the board keeps the scrollbar room with scrollbar-gutter (styles/_manager.scss),
    //so the padding only shifted the page 15px on every dialog and menu. with the scrollbar always there nothing has to
    //be compensated. the wheel still scrolls the page under the backdrop, which the short fixed dialogs do not mind
    MuiModal: { defaultProps: { disableScrollLock: true } },
    //popover (menu, select) does not inherit that one: it defaults disableScrollLock to false itself and hands it down
    MuiPopover: { defaultProps: { disableScrollLock: true } },
    //every dialog becomes a full screen page on a phone, without touching each <Dialog>. the nested confirm dialogs too
    MuiDialog: {
      styleOverrides: {
        paper: ({ theme }) => ({
          [theme.breakpoints.down("sm")]: {
            margin: 0,
            width: "100%",
            maxWidth: "100%",
            height: "100%",
            maxHeight: "100%",
            borderRadius: 0,
          },
        }),
      },
    },
    //the full screen paper runs under the iphone home bar (viewport-fit=cover in index.html), so whatever sits last in
    //the dialog gets the safe area added to its bottom padding
    MuiDialogContent: {
      styleOverrides: {
        root: ({ theme }) => ({
          [theme.breakpoints.down("sm")]: { padding: 16, "&:last-child": { paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0px))" } },
        }),
      },
    },
    MuiDialogActions: {
      styleOverrides: {
        root: ({ theme }) => ({
          [theme.breakpoints.down("sm")]: { padding: 16, paddingBottom: "calc(16px + env(safe-area-inset-bottom, 0px))", flexWrap: "wrap", gap: 8 },
        }),
      },
    },
  },
});

export function RtlTheme({ children }: { children: React.ReactNode }) {
  return (
    <CacheProvider value={cacheRtl}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}
