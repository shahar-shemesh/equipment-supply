import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, //so a tablet on the same wifi can open the courier screens
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
    //the shared folder sits one level above the client
    fs: { allow: [".."] },
  },
  //vite 5 still calls the legacy sass api by default and prints a deprecation warning on every start
  css: { preprocessorOptions: { scss: { api: "modern-compiler" } } },
});
