import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
  site: "https://status.bsgun.cn",
  base: "/",
  srcDir: "./src",
  outDir: "./dist",
  publicDir: "./public",
});
