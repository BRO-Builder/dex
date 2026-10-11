import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import BuildPoolPage from "./pages/BuildPoolPage";
import "./styles.css";
import "./build-pool.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BuildPoolPage />
  </StrictMode>,
);
