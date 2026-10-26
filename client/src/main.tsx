import React from "react";
import ReactDOM from "react-dom/client";
import { LicenseInfo } from "@mui/x-license";

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Translation from "../../shared/i18n";

import { RtlTheme } from "./theme/RtlTheme";
import { AuthProvider } from "./utils/auth";
import { AppRouter } from "./routers/AppRouter";
import { registerServiceWorker } from "./courier/offline/sw";

import "./styles/index.scss";
//Rubik is bundled, not fetched from google fonts: the service worker used to intercept that stylesheet and its own
//fetch of it is blocked by the csp on sw.js (connect-src). hebrew and latin only, the four weights the theme uses;
//the woff2 files land in /assets and are precached with the rest of the shell
import "@fontsource/rubik/hebrew-400.css";
import "@fontsource/rubik/hebrew-500.css";
import "@fontsource/rubik/hebrew-600.css";
import "@fontsource/rubik/hebrew-700.css";
import "@fontsource/rubik/latin-400.css";
import "@fontsource/rubik/latin-500.css";
import "@fontsource/rubik/latin-600.css";
import "@fontsource/rubik/latin-700.css";

i18n.use(initReactI18next).init(Translation as any);

//the data grid premium on the manager board. without a key the grid draws the mui watermark, see .env.example
if (import.meta.env.VITE_MUI_X_LICENSE_KEY) LicenseInfo.setLicenseKey(import.meta.env.VITE_MUI_X_LICENSE_KEY);

//the offline shell (built app only, the dev server has no worker). a new build applies itself at the next quiet moment, see sw.ts
if (import.meta.env.PROD && "serviceWorker" in navigator) registerServiceWorker();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  // <React.StrictMode>
  <RtlTheme>
    <AuthProvider>
      <AppRouter />
    </AuthProvider>
  </RtlTheme>
  // </React.StrictMode>
);
