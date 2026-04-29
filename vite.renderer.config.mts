import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@renderer": resolve(__dirname, "src/renderer"),
      "@shared": resolve(__dirname, "src/shared"),
    },
  },
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["pdfjs-dist"],
  },
  build: {
    rollupOptions: {
      output: {
        // Split heavy edit-only dependencies out of the main bundle so V8
        // parses smaller chunks at boot. pdf-lib, the @signpdf chain, and
        // node-forge are only used for editing/signing — not for view-only
        // PDF rendering, which lives in pdfjs-dist. Even when imported
        // statically by edit components, having them in separate chunks
        // gives Rollup more flexibility and improves V8's optimization
        // heuristics on the main bundle.
        manualChunks(id) {
          if (id.includes("node_modules/pdf-lib")) return "pdf-lib";
          if (id.includes("node_modules/@signpdf")) return "signpdf";
          if (id.includes("node_modules/node-forge")) return "crypto-forge";
          if (id.includes("node_modules/framer-motion")) return "motion";
          if (id.includes("node_modules/@dnd-kit")) return "dnd-kit";
        },
      },
    },
  },
});
