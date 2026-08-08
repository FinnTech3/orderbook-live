import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative base so the same build works at a domain root (Vercel) or under
  // a subpath (GitHub Pages serves this at /orderbook-live/). The app has no
  // client-side routing, so relative asset paths resolve correctly anywhere.
  base: "./",
  plugins: [react()],
  build: { target: "es2022", sourcemap: true },
  server: { port: 5173 },
});
