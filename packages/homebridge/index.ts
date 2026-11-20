import type { API } from "homebridge";
import { BraviaPlatform, PLATFORM_NAME, PLUGIN_NAME } from "./platform.ts";

export default function initialize(api: API): void {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, BraviaPlatform);
}
