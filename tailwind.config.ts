import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  // Dark mode is opt-in via a .dark class on <html>, set before paint by the
  // inline script in app/layout.tsx and toggled by ThemeToggle.
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        // Inter is loaded in app/layout.tsx via next/font and exposed
        // as --font-sans; the system stack covers the flash before it resolves.
        sans: [
          "var(--font-sans)",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "sans-serif",
        ],
      },
      // Small entrance animations for cards, menus, and toasts.
      keyframes: {
        "fade-slide-up": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        // Exit mirror of fade-slide-up, for toasts dismissing back down.
        "fade-slide-down": {
          from: { opacity: "1", transform: "translateY(0)" },
          to: { opacity: "0", transform: "translateY(6px)" },
        },
        "fade-scale": {
          from: { opacity: "0", transform: "scale(0.97)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        // Exit mirror of fade-scale, for dropdown panels closing.
        "fade-scale-out": {
          from: { opacity: "1", transform: "scale(1)" },
          to: { opacity: "0", transform: "scale(0.97)" },
        },
        // Overshoot pop for a checkbox that just turned on.
        "check-pop": {
          "0%": { transform: "scale(0.8)" },
          "60%": { transform: "scale(1.15)" },
          "100%": { transform: "scale(1)" },
        },
      },
      animation: {
        "fade-slide-up": "fade-slide-up 150ms ease-out",
        // Slower entrance for hero moments; reuses the same keyframes.
        "fade-slide-up-slow": "fade-slide-up 400ms ease-out",
        "fade-slide-down": "fade-slide-down 120ms ease-in",
        "fade-scale": "fade-scale 150ms ease-out",
        "fade-scale-out": "fade-scale-out 120ms ease-in",
        "check-pop": "check-pop 220ms ease-out",
      },
      // Warm brand-tinted shadows (rgb from hearth-800 #5e3c28), three tiers.
      boxShadow: {
        card: "0 1px 2px 0 rgb(94 60 40 / 0.05)",
        lift: "0 6px 16px -4px rgb(94 60 40 / 0.10)",
        pop: "0 16px 40px -12px rgb(94 60 40 / 0.18)",
        // Same elevation as the plain shadow-lg dropdown panels used, named
        // for what it's for so new panels reach for this instead of raw
        // shadow-lg.
        menu: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
      },
      colors: {
        // Hearth palette: one warm-paper ground rising to a single ember
        // accent (the fireplace). 600 is the primary accent used by
        // .btn-primary and focus rings; 50 is the app's warm-paper
        // background. The ramp is pulled toward RED (a deep terracotta ember,
        // not orange) so it does not drift yellow - warm mid tones gain
        // luminance on the dark ground and read yellow if left too orange, so
        // the 400-600 steps in particular are red-leaning.
        hearth: {
          50: "#faf4f0",
          100: "#f6e4dc",
          200: "#eec6b7",
          300: "#e09f85",
          400: "#d07257",
          500: "#c14f34",
          600: "#b8442a",
          700: "#98371f",
          800: "#7d2f1b",
          900: "#682816",
        },
        // The pre-redesign hearth brown. Used across the homeowner/landing UI
        // (side pill, active nav highlight, links, hover tints). NOT the filled
        // CTA button color - that is `oak` below, scoped to .btn-primary only.
        bark: {
          50: "#fbf7f2",
          100: "#f3e9dd",
          200: "#e8d8bf",
          300: "#d9bc94",
          400: "#c19a66",
          500: "#a9743f",
          600: "#915d32",
          700: "#73482b",
          900: "#4a2e1c",
        },
        // Oak brown: warmer, more golden than bark (whose darker shades read as
        // mahogany). Scoped to the FILLED CTA buttons only (.btn-primary in
        // globals.css); the rest of the brown UI stays on bark.
        oak: {
          500: "#a67c49",
          600: "#8a6a3c",
          700: "#6f5636",
        },
      },
    },
  },
  plugins: [],
};

export default config;
