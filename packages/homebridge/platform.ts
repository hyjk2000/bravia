import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { BraviaError, type Bravia } from "@hyjk2000/bravia-sdk";
import type { DynamicPlatformPlugin, Logging, PlatformAccessory } from "homebridge";
import type { SerializedPlatformAccessory } from "homebridge/lib/platformAccessory.js";
import { Authentication } from "./authentication.ts";
import { parseConfig, type BraviaPlatformConfig, type TvConfig } from "./config.ts";
import type { RuntimeAPI } from "./hap.ts";
import { Television } from "./television.ts";

export const PLUGIN_NAME = "@hyjk2000/homebridge-bravia";
export const PLATFORM_NAME = "BraviaPlatform";

const STATE_DIRECTORY = "hyjk2000-homebridge-bravia";
const STATE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

interface DeviceState {
  version: 1;
  plugin: typeof PLUGIN_NAME;
  uuid: string;
  clientId: string;
  cookie?: string;
  accessory?: SerializedPlatformAccessory;
}

interface ConfiguredDevice {
  config: TvConfig;
  uuid: string;
  baseUrl: string;
}

interface Device extends ConfiguredDevice {
  state: DeviceState;
  accessory: PlatformAccessory;
  authentication: Authentication;
  client?: Bravia;
  television?: Television;
  published: boolean;
  persistedJson?: string;
  bridgedAccessoryJson?: string;
  retryTimer?: NodeJS.Timeout;
}

function baseUrl(config: TvConfig): string {
  const host = config.ip.includes(":") ? `[${config.ip}]` : config.ip;
  return new URL(`http://${host}:${config.port ?? 80}`).origin;
}

function failureDescription(error: unknown): string {
  if (error instanceof BraviaError) {
    return `TV API code ${error.id}`;
  }
  if (typeof error === "object" && error !== null) {
    if ("name" in error && error.name === "TimeoutError") {
      return "request timed out";
    }
    if ("code" in error && typeof error.code === "string" && /^[A-Z_0-9]+$/.test(error.code)) {
      return error.code;
    }
    if (
      "response" in error &&
      typeof error.response === "object" &&
      error.response !== null &&
      "status" in error.response &&
      typeof error.response.status === "number"
    ) {
      return `HTTP status ${error.response.status}`;
    }
  }
  // Error objects may contain HTTP headers and credentials; never pass them to the logger.
  return "connection or initialization error";
}

function isDeviceState(value: unknown, uuid: string): value is DeviceState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const state = value as Partial<DeviceState>;
  return (
    state.version === 1 &&
    state.plugin === PLUGIN_NAME &&
    state.uuid === uuid &&
    typeof state.clientId === "string" &&
    state.clientId.length > 0 &&
    (state.cookie === undefined || typeof state.cookie === "string")
  );
}

export class BraviaPlatform implements DynamicPlatformPlugin {
  private readonly configured: ConfiguredDevice[];
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly devices: Device[] = [];
  private readonly stateDirectory: string;
  private readonly cleanupAllowed: boolean;
  private readonly blockedIdentities = new Set<string>();
  private stopped = false;
  private launched = false;
  private readonly log: Logging;
  private readonly api: RuntimeAPI;

  constructor(log: Logging, config: BraviaPlatformConfig | undefined, api: RuntimeAPI) {
    this.log = log;
    this.api = api;
    const tvs = parseConfig(config, log);
    const candidates: ConfiguredDevice[] = [];
    for (const tv of tvs) {
      try {
        const origin = baseUrl(tv);
        const identity = tv.mac
          ? `mac:${tv.mac.replace(/[:-]/g, "").toLowerCase()}`
          : `ip:${new URL(origin).hostname.toLowerCase()}`;
        candidates.push({
          config: tv,
          uuid: api.hap.uuid.generate(`${PLUGIN_NAME}:${identity}`),
          baseUrl: origin,
        });
      } catch {
        log.error("[%s] Could not construct the TV address; this TV is skipped.", tv.name);
      }
    }
    const counts = new Map<string, number>();
    for (const device of candidates) {
      counts.set(device.uuid, (counts.get(device.uuid) ?? 0) + 1);
    }
    this.configured = candidates.filter((device) => {
      if (counts.get(device.uuid)! > 1) {
        log.error("[%s] Duplicate TV identity; this TV is skipped.", device.config.name);
        return false;
      }
      return true;
    });
    // An invalid entry is not an intentional removal. Preserve all old state until config is valid.
    this.cleanupAllowed =
      config !== undefined &&
      config.compatibilitymode !== true &&
      Array.isArray(config.tvs) &&
      this.configured.length === config.tvs.length;
    this.stateDirectory = join(api.user.storagePath(), "plugin-persist", STATE_DIRECTORY);
    api.on("didFinishLaunching", () => {
      void this.launch().catch((error: unknown) => {
        if (!this.stopped) {
          this.log.error("Could not initialize BraviaPlatform (%s).", failureDescription(error));
        }
      });
    });
    api.on("shutdown", () => this.shutdown());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private async launch(): Promise<void> {
    if (this.stopped || this.launched) {
      return;
    }
    this.launched = true;
    try {
      mkdirSync(this.stateDirectory, { recursive: true, mode: 0o700 });
      chmodSync(this.stateDirectory, 0o700);
    } catch {
      this.log.error(
        "Could not create private BRAVIA storage; check Homebridge storage permissions.",
      );
    }
    this.removeObsoleteAccessories();
    this.removeObsoleteState();
    // Each task catches its own failure, so one offline or unpaired TV cannot block another.
    await Promise.all(this.configured.map((configured) => this.startDevice(configured)));
  }

  private async startDevice(configured: ConfiguredDevice): Promise<void> {
    if (this.stopped || this.blockedIdentities.has(configured.uuid)) {
      return;
    }
    try {
      const state = this.loadState(configured.uuid);
      const cachedAccessory = this.cached.get(configured.uuid);
      let accessory = cachedAccessory;
      if (!accessory && state.accessory) {
        try {
          if (
            state.accessory.UUID !== configured.uuid ||
            state.accessory.plugin !== PLUGIN_NAME ||
            state.accessory.platform !== PLATFORM_NAME
          ) {
            throw new Error("Stored accessory identity does not match.");
          }
          accessory = this.api.platformAccessory.deserialize(state.accessory);
        } catch {
          this.log.warn(
            "[%s] Could not restore stored TV services; creating a new accessory.",
            configured.config.name,
          );
        }
      }
      accessory ??= new this.api.platformAccessory(
        configured.config.name,
        configured.uuid,
        this.api.hap.Categories.TELEVISION,
      );
      accessory.displayName = configured.config.name;
      accessory.category = this.api.hap.Categories.TELEVISION;
      const authentication = new Authentication({
        config: configured.config,
        baseUrl: configured.baseUrl,
        cookie: state.cookie,
        clientId: state.clientId,
        log: this.log,
      });
      const device: Device = {
        ...configured,
        state,
        accessory,
        authentication,
        published: configured.config.externalaccessory === false && cachedAccessory !== undefined,
      };
      this.devices.push(device);
      this.markUnavailable(device);
      // Publish restored services before any network request, including while the TV is offline.
      this.publishDevice(device);
      this.saveDevice(device);
      await this.connectDevice(device);
    } catch (error) {
      if (!this.stopped) {
        this.log.error(
          "[%s] Could not initialize TV (%s).",
          configured.config.name,
          failureDescription(error),
        );
      }
    }
  }

  private async connectDevice(device: Device): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      device.client = await device.authentication.authenticate();
      if (this.stopped) {
        return;
      }
      device.state.cookie = device.client.cookie;
      this.saveDevice(device);
      device.television = new Television(
        this.api,
        this.log,
        device.config,
        device.accessory,
        device.client,
        () => {
          if (!this.stopped) {
            this.saveDevice(device);
          }
        },
      );
      await device.television.start();
      if (this.stopped) {
        device.television.stop();
        return;
      }
      this.publishDevice(device);
      this.saveDevice(device);
    } catch (error) {
      if (this.stopped) {
        return;
      }
      this.log.error(
        "[%s] Could not start TV (%s); initialization will be retried.",
        device.config.name,
        failureDescription(error),
      );
      try {
        device.television?.stop();
        device.television = undefined;
        this.markUnavailable(device);
        this.publishDevice(device);
        this.saveDevice(device);
      } catch (publishError) {
        this.log.error(
          "[%s] Could not restore unavailable TV (%s).",
          device.config.name,
          failureDescription(publishError),
        );
      }
      this.scheduleRetry(device);
    }
  }

  private markUnavailable(device: Device): void {
    const service = device.accessory.getService(this.api.hap.Service.Television);
    if (!service) {
      return;
    }
    const unavailable = () => {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    };
    service
      .getCharacteristic(this.api.hap.Characteristic.Active)
      .onGet(unavailable)
      .onSet(unavailable);
  }

  private scheduleRetry(device: Device): void {
    if (this.stopped || device.retryTimer) {
      return;
    }
    const delay = Math.max(1, Math.min(device.config.updaterate ?? 5000, 2_147_483_647));
    device.retryTimer = setTimeout(() => {
      device.retryTimer = undefined;
      if (!this.stopped) {
        void this.connectDevice(device).catch(() => {
          if (!this.stopped) {
            this.log.error("[%s] Could not retry TV initialization.", device.config.name);
            this.scheduleRetry(device);
          }
        });
      }
    }, delay);
  }

  private publishDevice(device: Device): void {
    if (
      this.stopped ||
      device.published ||
      !device.accessory.getService(this.api.hap.Service.Television)
    ) {
      return;
    }
    if (device.config.externalaccessory === false) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [device.accessory]);
    } else {
      this.api.publishExternalAccessories(PLUGIN_NAME, [device.accessory]);
    }
    device.published = true;
  }

  private loadState(uuid: string): DeviceState {
    const path = join(this.stateDirectory, `${uuid}.json`);
    try {
      if (!lstatSync(path).isFile()) {
        throw new Error("Private state must be a regular file.");
      }
      chmodSync(path, 0o600);
      const state: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isDeviceState(state, uuid)) {
        throw new Error("Invalid private device state.");
      }
      return state;
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        this.log.warn(
          "Could not read private TV state for %s; creating a fresh controller session.",
          uuid,
        );
      }
    }
    return { version: 1, plugin: PLUGIN_NAME, uuid, clientId: `Homebridge:${randomUUID()}` };
  }

  private saveDevice(device: Device): void {
    let temporaryPath: string | undefined;
    try {
      if (device.client) {
        device.state.cookie = device.client.cookie;
      }
      if (device.accessory.getService(this.api.hap.Service.Television)) {
        // Homebridge's serializer requires both identifiers, including for external accessories.
        device.accessory._associatedPlugin = PLUGIN_NAME;
        device.accessory._associatedPlatform = PLATFORM_NAME;
        const serialized = this.api.platformAccessory.serialize(device.accessory);
        if (device.config.externalaccessory !== false) {
          device.state.accessory = serialized;
        } else {
          delete device.state.accessory;
          if (!this.stopped && device.published) {
            const accessoryJson = JSON.stringify(serialized);
            if (accessoryJson !== device.bridgedAccessoryJson) {
              this.api.updatePlatformAccessories([device.accessory]);
              device.bridgedAccessoryJson = accessoryJson;
            }
          }
        }
      } else {
        delete device.state.accessory;
      }
      const stateJson = JSON.stringify(device.state);
      if (stateJson === device.persistedJson) {
        return;
      }
      const path = join(this.stateDirectory, `${device.uuid}.json`);
      temporaryPath = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporaryPath, stateJson, { flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, path);
      temporaryPath = undefined;
      device.persistedJson = stateJson;
    } catch {
      this.log.error(
        "[%s] Could not save private TV state; check Homebridge storage permissions.",
        device.config.name,
      );
    } finally {
      if (temporaryPath) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // A failed write may not have created its temporary file.
        }
      }
    }
  }

  private removeObsoleteAccessories(): void {
    const configured = new Map(this.configured.map((device) => [device.uuid, device.config]));
    for (const [uuid, accessory] of this.cached) {
      const config = configured.get(uuid);
      if (config?.externalaccessory === false || (!config && !this.cleanupAllowed)) {
        continue;
      }
      try {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        if (!config) {
          this.cached.delete(uuid);
        }
      } catch (error) {
        this.log.error("Could not remove an obsolete bridged TV (%s).", failureDescription(error));
        if (config) {
          this.blockedIdentities.add(uuid);
        }
      }
    }
  }

  private removeObsoleteState(): void {
    if (!this.cleanupAllowed) {
      return;
    }
    const active = new Set(this.configured.map((device) => `${device.uuid}.json`));
    try {
      for (const entry of readdirSync(this.stateDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || !STATE_FILE.test(entry.name) || active.has(entry.name)) {
          continue;
        }
        try {
          const path = join(this.stateDirectory, entry.name);
          const uuid = entry.name.slice(0, -5);
          const value: unknown = JSON.parse(readFileSync(path, "utf8"));
          if (isDeviceState(value, uuid)) {
            unlinkSync(path);
          }
        } catch {
          this.log.warn("Could not inspect or remove an obsolete private TV state file.");
        }
      }
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        this.log.warn("Could not inspect private TV state for obsolete devices.");
      }
    }
  }

  private shutdown(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    for (const device of this.devices) {
      if (device.retryTimer) {
        clearTimeout(device.retryTimer);
        device.retryTimer = undefined;
      }
      try {
        device.authentication.stop();
      } catch {
        this.log.warn("[%s] Could not close the PIN server cleanly.", device.config.name);
      }
      try {
        device.television?.stop();
      } catch {
        this.log.warn("[%s] Could not stop TV activity cleanly.", device.config.name);
      }
      this.saveDevice(device);
    }
  }
}
