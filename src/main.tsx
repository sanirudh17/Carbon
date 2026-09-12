import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Tell the Rust side the UI is mounted so it can force each hidden window's
// first WebView2 present off-screen (prevents a white flash on the first
// hotkey press — a cloaked prewarm alone never truly presents).
import { emit } from "@tauri-apps/api/event";
emit("carbon-ui-ready").catch(() => {});
