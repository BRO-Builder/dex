import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import ApproverPage from "./pages/ApproverPage";
import "./styles.css";
import "./build-pool.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApproverPage />
  </StrictMode>,
);
