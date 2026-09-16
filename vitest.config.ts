import { defineConfig } from "vitest/config";

// Scope the root suite to test/. Without this, vitest's default glob reaches into
// web/, whose tests resolve under a DIFFERENT tsconfig (bundler resolution, the `@/`
// alias, a DOM lib) and only happen to pass while they stay dependency-free. Run
// those with `pnpm test:web`, which uses web/'s own toolchain — or `pnpm test:all`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
