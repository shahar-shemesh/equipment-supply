import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { createTheme, CssBaseline, ThemeProvider } from "@mui/material";
import { prefixer } from "stylis";
import rtlPlugin from "stylis-plugin-rtl";

// https://mui.com/material-ui/customization/right-to-left/
const cacheRtl = createCache({ key: "muirtl", stylisPlugins: [prefixer, rtlPlugin] });

//colors from the actual screens in design/ (blue #0A52BD). the style-guide page says #0A6E8A but no screen uses it,
//so until the designers answer which one wins, the screens win
const theme = createTheme({
  direction: "rtl",
  typography: { fontFamily: "Rubik, Arial, sans-serif" },
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
