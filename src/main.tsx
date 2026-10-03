import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import DexPage from "./pages/DexPage";
import "./styles.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route index element={<DexPage />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
