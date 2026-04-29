import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      include: [
        "src/persistence/**/*.ts",
        "src/tools/runtime/**/*.ts",
        "src/tools/http/**/*.ts",
        "src/tools/sleep/**/*.ts"
      ],
      exclude: [
        "src/tools/runtime/secretRedaction.ts"
      ],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90
      }
    }
  }
});
