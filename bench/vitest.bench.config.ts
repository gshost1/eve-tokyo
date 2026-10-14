import { defineConfig } from "vitest/config";

// eve's unit-config aliases, without its hermetic guard or AI Gateway mock:
// the bench writes results and (model layer) calls the real gateway.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^#compiled\/(.+)\.js$/, replacement: new URL("./.generated/compiled/$1.js", import.meta.url).pathname },
      { find: /^#(.+)\.js$/, replacement: new URL("./src/$1.ts", import.meta.url).pathname },
    ],
  },
  test: { environment: "node", include: ["src/eve-tokyo/**/*.test.ts"], testTimeout: 60 * 60 * 1000 },
});
