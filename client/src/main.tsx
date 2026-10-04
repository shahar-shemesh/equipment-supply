import React from "react";
import ReactDOM from "react-dom/client";

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Translation from "../../shared/i18n";

import { RtlTheme } from "./theme/RtlTheme";
import { AuthProvider } from "./utils/auth";
import { AppRouter } from "./routers/AppRouter";
import { registerServiceWorker } from "./courier/offline/sw";

import "./styles/index.scss";

i18n.use(initReactI18next).init(Translation as any);

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
