import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import { componentGretaTagger } from "@questlabs/greta-tagger";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: "0.0.0.0",
    port: 5173,
    // HMR is bound to an unreachable port ON PURPOSE — do NOT change to hmr:false.
    // The preview iframe must stay frozen on the old stable version while the agent
    // writes files; PreviewPanel remounts the iframe after streaming to show the new
    // version. Pointing the HMR socket at 9999 (not proxied) means the client can
    // never connect, so neither hot updates NOR full-page reloads reach the iframe.
    // hmr:false does the opposite — it makes Vite fall back to full reload on every
    // file change, which updates the preview live mid-stream (not what we want).
    hmr: {
      overlay: false,
      port: 9999,
      clientPort: 9999,
    },
    watch: {
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
  // Pre-bundle every pre-installed package at server start. Without this,
  // Vite only optimizes deps the template imports; when the agent writes code
  // importing new packages, Vite stops to re-optimize and stalls all requests
  // for 10-30s (browser checks/screenshots time out).
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router-dom",
      "@tanstack/react-query",
      "@hookform/resolvers",
      "react-hook-form",
      "zod",
      "clsx",
      "class-variance-authority",
      "tailwind-merge",
      "lucide-react",
      "framer-motion",
      "recharts",
      "sonner",
      "next-themes",
      "date-fns",
      "cmdk",
      "vaul",
      "zustand",
      "input-otp",
      "embla-carousel-react",
      "react-day-picker",
      "react-resizable-panels",
      "@radix-ui/react-accordion",
      "@radix-ui/react-alert-dialog",
      "@radix-ui/react-aspect-ratio",
      "@radix-ui/react-avatar",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-collapsible",
      "@radix-ui/react-context-menu",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-hover-card",
      "@radix-ui/react-label",
      "@radix-ui/react-menubar",
      "@radix-ui/react-navigation-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-progress",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slider",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-toast",
      "@radix-ui/react-toggle",
      "@radix-ui/react-toggle-group",
      "@radix-ui/react-tooltip",
    ],
  },
  plugins: [componentGretaTagger(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
