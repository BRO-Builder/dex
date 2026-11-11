import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: {
        Buffer: true,
      }
    })
  ],
  appType: "spa",
  publicDir: false,
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        buildPool: "build-pool.html",
        portfolio: "portfolio.html",
        approver: "approver.html",
      },
    },
  },
});
