import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./index.ts"],
  format: "esm",
  platform: "node",
  target: "node24",
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  copy: "../../LICENSE",
});
