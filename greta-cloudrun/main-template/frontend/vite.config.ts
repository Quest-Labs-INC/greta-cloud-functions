import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { componentGretaTagger } from "@questlabs/greta-tagger";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "0.0.0.0",
    port: 5173,
    hmr: {
      overlay: false,
    },
    watch: {
      // Only watch src/ — ignore everything else so bulk writes to other dirs don't trigger HMR
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/dist-static/**',
        '**/public/**',
        '**/backend/**',
      ],
      // Wait 1s of file stability before triggering HMR — prevents storm from rapid bulk writes
      stabilityThreshold: 1000,
    },
  },

  plugins: [componentGretaTagger(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
