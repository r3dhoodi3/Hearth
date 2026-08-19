import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Test harness for pure logic in src/lib and (where useful) React components.
//
// Defaults to the node environment because almost everything worth testing
// here is pure TypeScript with no DOM. A file that does need a DOM opts in
// per-file with a docblock comment at the top:
//
//   // @vitest-environment jsdom
//
// There is no global setup file. A component test pulls in what it needs at
// the top of the file:
//
//   import "@testing-library/jest-dom/vitest";  // toBeInTheDocument() etc.
//   import { render, screen } from "@testing-library/react";
//
// Globals are OFF on purpose: tests import `describe`/`it`/`expect` from
// "vitest" explicitly, so tsconfig.json needs no "types" entry and stays the
// single source of truth for the app build.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirrors the "@/*" -> "./src/*" path mapping in tsconfig.json.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
