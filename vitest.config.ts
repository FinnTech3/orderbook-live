import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"],
      include: ["src/lib/**/*.ts"],
      thresholds: { statements: 85, branches: 80, functions: 90 },
    },
  },
});
