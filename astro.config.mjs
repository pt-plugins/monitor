import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://pt-plugins.github.io",
  base: "/monitor",
  srcDir: "./src",
  outDir: "./dist",
  publicDir: "./public",
});
