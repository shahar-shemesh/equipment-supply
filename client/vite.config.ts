import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

//service workers, web locks and persistent storage need a secure context, so a tablet on the lan needs https. a mkcert
//pair in CLIENT_TLS_KEY / CLIENT_TLS_CERT turns it on for both the dev server and the preview, otherwise plain http
const tlsKey = process.env.CLIENT_TLS_KEY;
const tlsCert = process.env.CLIENT_TLS_CERT;
const https = tlsKey && tlsCert && existsSync(tlsKey) && existsSync(tlsCert) ? { key: readFileSync(tlsKey), cert: readFileSync(tlsCert) } : undefined;

//the same proxy for dev and preview: npm run preview serves the built app (with the service worker) and still needs the api
const proxy = {
  "/api": {
    target: "http://localhost:3000",
    changeOrigin: true,
  },
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    //the offline shell: the built assets are precached, a navigation to any courier route offline serves index.html.
    //prompt mode: a new build waits for the עדכון button, it never reloads on its own. /api is kept out of the html
    //fallback on purpose, and no api response is ever cached by the worker (the data layer keeps the courier's data)
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      manifest: {
        name: "מערכת הנפקה דיגיטלית",
        short_name: "הנפקות",
        lang: "he",
        dir: "rtl",
        start_url: "/courier",
        display: "standalone",
        theme_color: "#0A52BD",
        background_color: "#F5F7FA",
        //an svg only. ios ignores manifest icons and raster pngs are not produced here
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: "CacheFirst",
            options: { cacheName: "google-fonts-files", expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    host: true, //so a tablet on the same wifi can open the courier screens
    https,
    proxy,
    //the shared folder sits one level above the client
    fs: { allow: [".."] },
  },
  preview: { https, proxy },
  //vite 5 still calls the legacy sass api by default and prints a deprecation warning on every start
  css: { preprocessorOptions: { scss: { api: "modern-compiler" } } },
});
