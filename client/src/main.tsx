import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initializeVisualMode } from "./visual-harness";
import "./theme/global.css";

initializeVisualMode(import.meta.env.MODE, window, location.search);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
