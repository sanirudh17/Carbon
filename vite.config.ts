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
  // reshuffles them on every reboot: earlier 1420/1445, then 1599/1600 all
  // ended up inside reserved ranges → bind EACCES. As of the current
  // exclusions (1033-1232, 1432-1531, 1545-1644, 10564-10663, 50000-50059),
  // 2170/2171 sit outside every range. If EACCES strikes again after a
  // reboot, re-check `netsh interface ipv4 show excludedportrange
  // protocol=tcp` and pick ports above the highest reserved boundary.)
  server: {
    port: 2170,
    strictPort: true,
    // Bind IPv4 loopback explicitly: on this machine Node cannot listen on the
    // IPv6 loopback (::1 → EACCES) when IPv6 is disabled, which breaks the
    // default localhost binding. localhost still resolves to 127.0.0.1.
    host: host || '127.0.0.1',
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 2171,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
