import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 8686,
    strictPort: true,
  },
  build: {
    manifest: true,
    minify: "terser",
    terserOptions: { compress: { passes: 2 }, mangle: true },
  },
});
