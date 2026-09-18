import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

if (import.meta.env.DEV) {
  // Debug handle for the dev console; stripped from production builds.
  import("./store/app").then((m) => ((window as unknown as { __app: unknown }).__app = m.useApp));
  import("./store/timer").then((m) => ((window as unknown as { __timer: unknown }).__timer = m.useTimer));
}
