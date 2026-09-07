import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  // (Windows dynamically excludes TCP port ranges for Hyper-V/WSL and
  // reshuffles them on every reboot: 1420/1445, then 1599/1600, then
  // 2170/2171 all ended up inside reserved ranges → bind EACCES.
  // Current exclusions (1033-1232, 2077-2176, 4218-4317, 8825-8924,
  // 50000-50059): 3210/3211 sit outside every range. If EACCES strikes
  // again after a reboot, re-check `netsh interface ipv4 show
  // excludedportrange protocol=tcp` and pick ports clear of all ranges.)
  server: {
    port: 3210,
    strictPort: true,
    // Bind IPv4 loopback explicitly: on this machine Node cannot listen on the
    // IPv6 loopback (::1 → EACCES) when IPv6 is disabled, which breaks the
    // default localhost binding. localhost still resolves to 127.0.0.1.
    host: host || '127.0.0.1',
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 3211,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
