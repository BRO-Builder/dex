import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import DexPage from "./pages/DexPage";
import VotingPage from "./pages/VotingPage";
import "./styles.css";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route index element={<DexPage />} />
        <Route path="voting" element={<VotingPage />} />

        { /* Legacy routes for old links */ }
        <Route path="bro-builder-voting.php" element={<VotingPage />} />

        <Route path="*" element={<DexPage />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
