import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/themes.css";
import "./styles/base.css";
import { applyStoredTheme } from "@/shell/theme";
import { App } from "./App";
import { registerSw } from "./registerSw";

applyStoredTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Only the built app (what the Worker serves); the Vite dev server runs without it.
if (import.meta.env.PROD) void registerSw();
