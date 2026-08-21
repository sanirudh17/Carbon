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
  // (Windows dynamically excludes TCP port ranges for Hyper-V/WSL. Earlier
  // Carbon versions used 1420/1445, but both are now inside the machine's
  // excluded ranges (1316-1415, 1425-1524) → bind EACCES. 1599 is outside
  // all current exclusion ranges and verifies binding cleanly.)
  server: {
    port: 1599,
    strictPort: true,
    // Bind IPv4 loopback explicitly: on this machine Node cannot listen on the
    // IPv6 loopback (::1 → EACCES) when IPv6 is disabled, which breaks the
    // default localhost binding. localhost still resolves to 127.0.0.1.
    host: host || '127.0.0.1',
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1600,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
