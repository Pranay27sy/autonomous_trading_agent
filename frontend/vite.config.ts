/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (uvicorn on :8000); Vite proxies /api to it.
// In production FastAPI serves the built files from dist/.
export default defineConfig({
  plugins: [react()],
  // changeOrigin: false keeps the browser's Host (localhost:5173) so it matches the
  // Origin header; the API refuses writes whose Origin and Host differ (CSRF guard).
  server: { port: 5173, proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } } },
  build: { sourcemap: true, chunkSizeWarningLimit: 700 },
  test: { environment: "jsdom" },
});
