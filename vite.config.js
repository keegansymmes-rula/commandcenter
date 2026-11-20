import http from "node:http";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Without an agent, Vite's proxy sends `Connection: close`, so every proxied
// /api call opens a fresh TCP connection and leaves one TIME_WAIT behind. On
// this Mac those entries were never reaped (4,000+ per port, none expiring
// over minutes), which pinned ~25% of the ephemeral port range for ::1 ->
// :5173 and :3789; any new connection that drew a pinned port stalled in
// SYN_SENT, so the dashboard intermittently hung ("Failed to fetch", and
// open-terminal clicks that never answered). A keep-alive agent reuses
// connections, and 127.0.0.1 (both the listen address and the target) stays off
// the polluted ::1 pool; Vite otherwise binds ::1 only and has no IPv4 fallback.
const apiAgent = new http.Agent({ keepAlive: true });

export default defineConfig({
  plugins: [react()],
  root: "ui",
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:3789", agent: apiAgent },
    },
  },
  build: {
    outDir: "../dist",
  },
});
