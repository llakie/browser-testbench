import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  resolve: {
    alias: {
      vue: "vue/dist/vue.esm-bundler.js",
    },
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve("src/ui/client/app.ts"),
      formats: ["es"],
      fileName: () => "app.js",
    },
    minify: true,
    outDir: resolve("dist/public/ui"),
    sourcemap: true,
  },
});
