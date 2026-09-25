import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: false },
      // Regex so that only the public link page (/u/<token>) is proxied, not /users.
      "^/u/": { target: API, changeOrigin: false },
      "/webhooks": { target: API, changeOrigin: false },
    },
  },
});
