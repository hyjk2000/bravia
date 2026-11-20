import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  copy: "../../LICENSE",
});
