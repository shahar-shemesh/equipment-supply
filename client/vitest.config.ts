import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

//separate from vite.config.ts so the pwa plugin stays out of the test run. jsdom for window / document / localStorage,
//fake-indexeddb from the setup file for the es-courier database
export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.spec.ts"],
    //the pickers package is esm with directory imports (@mui/material/useMediaQuery) that node's resolver refuses,
    //vite's does not: the specs that render the date filter get it transformed like the app's own code
    server: { deps: { inline: [/@mui\/x-date-pickers/] } },
  },
  resolve: {
    alias: {
      //sw.ts imports a module that only the vite plugin provides
      "virtual:pwa-register": fileURLToPath(new URL("./src/test/pwa-register.stub.ts", import.meta.url)),
    },
  },
});
