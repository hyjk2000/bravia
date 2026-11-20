import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  Bravia,
  IRCC_CODES,
  type InterfaceInformation,
  type SystemInformation,
} from "@hyjk2000/bravia-sdk";
import type { CharacteristicValue, Logging, PlatformAccessory, Service } from "homebridge";
import type { TvConfig } from "./config.ts";
import type { RuntimeAPI } from "./hap.ts";
import { wake } from "./wake.ts";

interface Input {
  uri: string;
  title: string;
  group: string;
  type: number;
  identifier: number;
  configuredName?: string;
  visibility?: number;
}

const DEFAULT_SOURCES = [
  "extInput:hdmi",
  "extInput:component",
  "extInput:scart",
  "extInput:cec",
  "extInput:widi",
];
// Leave room for the information, TV, speaker and protocol services (HAP limit: 100).
const MAX_INPUTS = 95;

export class Television {
  private readonly tv: Service;
  private readonly speaker: Service;
  private readonly information: Service;
  private readonly inputs = new Map<string, Input>();
  private readonly services = new Map<number, Service>();
  private readonly abort = new AbortController();
  private statusTimer?: NodeJS.Timeout;
  private sourceTimer?: NodeJS.Timeout;
  private stopped = false;
  private power = false;
  private activeIdentifier = 0;
  private currentUri?: string;
  private boot?: Promise<void>;
  private readonly api: RuntimeAPI;
  private readonly log: Logging;
  private readonly config: TvConfig;
  private readonly accessory: PlatformAccessory;
  private readonly client: Bravia;
  private readonly save: () => void;

  constructor(
    api: RuntimeAPI,
    log: Logging,
    config: TvConfig,
    accessory: PlatformAccessory,
    client: Bravia,
    save: () => void,
  ) {
    this.api = api;
    this.log = log;
    this.config = config;
    this.accessory = accessory;
    this.client = client;
    this.save = save;
    const { Service: S, Characteristic: C } = api.hap;
    accessory.category = api.hap.Categories.TELEVISION;
    this.information =
      accessory.getService(S.AccessoryInformation) ?? accessory.addService(S.AccessoryInformation);
    this.tv = accessory.getService(S.Television) ?? accessory.addService(S.Television, config.name);
    this.speaker =
      accessory.getService(S.TelevisionSpeaker) ??
      accessory.addService(S.TelevisionSpeaker, config.soundoutput ?? "speaker");
    this.tv.setPrimaryService();
    this.tv.addLinkedService(this.speaker);
    this.tv
      .setCharacteristic(C.ConfiguredName, config.name)
      .setCharacteristic(C.SleepDiscoveryMode, C.SleepDiscoveryMode.ALWAYS_DISCOVERABLE);
    this.speaker
      .setCharacteristic(C.Active, C.Active.ACTIVE)
      .setCharacteristic(C.VolumeControlType, C.VolumeControlType.ABSOLUTE);
    const interfaceInfo = accessory.context.interfaceInfo as InterfaceInformation | undefined;
    const systemInfo = accessory.context.systemInfo as SystemInformation | undefined;
    this.information
      .setCharacteristic(C.Manufacturer, interfaceInfo?.productName || "Sony")
      .setCharacteristic(C.Model, systemInfo?.model || interfaceInfo?.modelName || "Bravia TV")
      .setCharacteristic(
        C.SerialNumber,
        systemInfo?.serial || systemInfo?.macAddr || accessory.UUID,
      );

    const groups = this.sourceGroups();
    for (const input of (accessory.context.inputs ?? []) as Input[]) {
      if (
        groups.has(input.group) &&
        (input.group !== "applications" ||
          config.applications?.some((filter) => input.title.includes(filter.title)))
      )
        this.inputs.set(input.uri, input);
    }
    this.syncInputs();
    this.tv
      .getCharacteristic(C.Active)
      .onGet(() => this.handle(async () => Number(await this.readPower())))
      .onSet((value) => this.handle(() => this.setPower(Number(value) === C.Active.ACTIVE)));
    this.tv
      .getCharacteristic(C.ActiveIdentifier)
      .onGet(() => this.activeIdentifier)
      .onSet((value) => this.handle(() => this.selectInput(Number(value))));
    const keys = new Map<number, string>([
      [C.RemoteKey.REWIND, IRCC_CODES.Rewind],
      [C.RemoteKey.FAST_FORWARD, IRCC_CODES.Forward],
      [C.RemoteKey.NEXT_TRACK, IRCC_CODES.Next],
      [C.RemoteKey.PREVIOUS_TRACK, IRCC_CODES.Prev],
      [C.RemoteKey.ARROW_UP, IRCC_CODES.Up],
      [C.RemoteKey.ARROW_DOWN, IRCC_CODES.Down],
      [C.RemoteKey.ARROW_LEFT, IRCC_CODES.Left],
      [C.RemoteKey.ARROW_RIGHT, IRCC_CODES.Right],
      [C.RemoteKey.SELECT, IRCC_CODES.Confirm],
      [C.RemoteKey.BACK, IRCC_CODES.Back],
      [C.RemoteKey.EXIT, IRCC_CODES.Exit],
      [C.RemoteKey.PLAY_PAUSE, IRCC_CODES.Play],
      [C.RemoteKey.INFORMATION, IRCC_CODES.Display],
    ]);
    this.tv.getCharacteristic(C.RemoteKey).onSet((value) =>
      this.handle(async () => {
        const code = keys.get(Number(value));
        if (code) await this.client.ircc.sendCode(code);
        else throw new api.hap.HapStatusError(api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
      }),
    );
    this.speaker
      .getCharacteristic(C.VolumeSelector)
      .onSet((value) =>
        this.handle(() =>
          this.client.ircc.sendCode(
            Number(value) === C.VolumeSelector.INCREMENT
              ? IRCC_CODES.VolumeUp
              : IRCC_CODES.VolumeDown,
          ),
        ),
      );
    this.speaker
      .getCharacteristic(C.Mute)
      .onGet(() => this.handle(async () => (this.power ? (await this.readAudio()).mute : false)))
      .onSet((value) =>
        this.handle(async () => {
          if (this.power) await this.client.audio.setAudioMute({ status: Boolean(value) });
        }),
      );
    this.speaker
      .getCharacteristic(C.Volume)
      .onGet(() =>
        this.handle(async () => (this.power ? Number((await this.readAudio()).volume) : 0)),
      )
      .onSet((value) =>
        this.handle(async () => {
          if (this.power)
            await this.client.audio.setAudioVolume({
              target: config.soundoutput ?? "speaker",
              volume: String(value as number),
            });
        }),
      );
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    await this.probeInformation();
    if (this.stopped) return;
    await this.poll();
    if (this.stopped) return;
    await this.scan();
    this.scheduleStatus();
    this.scheduleSources();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearTimeout(this.statusTimer);
    clearTimeout(this.sourceTimer);
  }

  private async handle<T extends CharacteristicValue | void>(
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      if (this.stopped) throw new Error("Plugin is shutting down");
      return await operation();
    } catch (error) {
      this.debug(`${this.config.name}: command failed`, error);
      if (error instanceof this.api.hap.HapStatusError) throw error;
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } finally {
      if (!this.stopped) this.save();
    }
  }

  private async probeInformation(): Promise<void> {
    const { Characteristic: C } = this.api.hap;
    let interfaceInfo = this.accessory.context.interfaceInfo as InterfaceInformation | undefined;
    let systemInfo = this.accessory.context.systemInfo as SystemInformation | undefined;
    try {
      interfaceInfo = (await this.client.system.getInterfaceInformation()).result[0];
      this.accessory.context.interfaceInfo = interfaceInfo;
    } catch (error) {
      this.debug(`${this.config.name}: interface information unavailable`, error);
    }
    if (this.stopped) return;
    try {
      systemInfo = (await this.client.system.getSystemInformation()).result[0];
      this.accessory.context.systemInfo = systemInfo;
    } catch (error) {
      this.debug(`${this.config.name}: system information unavailable`, error);
    }
    if (this.stopped) return;
    this.information
      .setCharacteristic(C.Manufacturer, interfaceInfo?.productName || "Sony")
      .setCharacteristic(C.Model, systemInfo?.model || interfaceInfo?.modelName || "Bravia TV")
      .setCharacteristic(
        C.SerialNumber,
        systemInfo?.serial || systemInfo?.macAddr || this.accessory.UUID,
      );
    this.save();
  }

  private async readPower(): Promise<boolean> {
    const on = (await this.client.system.getPowerStatus()).result[0].status === "active";
    if (!this.stopped) {
      this.power = on;
      this.tv.updateCharacteristic(this.api.hap.Characteristic.Active, Number(on));
      if (!on) {
        this.currentUri = undefined;
        this.updateIdentifier(0);
      }
    }
    return on;
  }

  private async setPower(on: boolean): Promise<void> {
    if (this.config.mac) {
      if (on) await wake(this.config.mac, this.config.woladdress ?? "255.255.255.255");
      else await this.client.ircc.sendCode(IRCC_CODES.PowerOff);
    } else {
      await this.client.system.setPowerStatus({ status: on });
    }
    if (!this.stopped) {
      this.power = on;
      this.tv.updateCharacteristic(this.api.hap.Characteristic.Active, Number(on));
      if (!on) {
        this.currentUri = undefined;
        this.updateIdentifier(0);
      }
    }
  }

  private async selectInput(identifier: number): Promise<void> {
    const input = [...this.inputs.values()].find((entry) => entry.identifier === identifier);
    if (!input || !this.services.has(identifier))
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
    if (!this.power) {
      this.boot ??= (async () => {
        await this.setPower(true);
        await delay(this.config.starttimeout ?? 5000, undefined, { signal: this.abort.signal });
      })().finally(() => {
        this.boot = undefined;
      });
    }
    if (this.boot) await this.boot;
    if (this.stopped) return;
    if (input.type === this.api.hap.Characteristic.InputSourceType.APPLICATION) {
      await this.client.appControl.setActiveApp({ uri: input.uri });
    } else {
      await this.client.avContent.setPlayContent({ uri: input.uri });
    }
    this.updateIdentifier(identifier);
  }

  private async readAudio() {
    const values = (await this.client.audio.getVolumeInformation()).result[0];
    const output = values.find((value) => value.target === (this.config.soundoutput ?? "speaker"));
    if (!output) throw new Error("Configured audio output is unavailable");
    return output;
  }

  private updateIdentifier(identifier: number): void {
    this.activeIdentifier = identifier;
    this.tv.updateCharacteristic(this.api.hap.Characteristic.ActiveIdentifier, identifier);
  }

  private async poll(): Promise<void> {
    try {
      if (!(await this.readPower()) || this.stopped) return;
      try {
        const uri = (await this.client.avContent.getPlayingContentInfo()).result[0].uri;
        if (!this.stopped) {
          this.currentUri = uri;
          const identifier = this.inputs.get(uri)?.identifier ?? 0;
          this.updateIdentifier(this.services.has(identifier) ? identifier : 0);
        }
      } catch (error) {
        // Apps and standby displays may not expose playing-content information.
        if (!this.stopped) {
          this.currentUri = undefined;
          this.updateIdentifier(0);
        }
        this.debug(`${this.config.name}: playing content unavailable`, error);
      }
    } catch (error) {
      if (!this.stopped)
        this.tv.updateCharacteristic(
          this.api.hap.Characteristic.Active,
          new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE),
        );
      this.debug(`${this.config.name}: status unavailable`, error);
    } finally {
      if (!this.stopped) this.save();
    }
  }

  private scheduleStatus(): void {
    if (this.stopped) return;
    this.statusTimer = setTimeout(() => {
      void this.poll()
        .catch((error) =>
          this.log.error(`${this.config.name}: status refresh failed`, String(error)),
        )
        .finally(() => this.scheduleStatus());
    }, this.config.updaterate ?? 5000);
    this.statusTimer.unref();
  }

  private scheduleSources(): void {
    if (this.stopped || this.config.channelupdaterate === 0) return;
    this.sourceTimer = setTimeout(() => {
      void this.scan()
        .catch((error) =>
          this.log.error(`${this.config.name}: source refresh failed`, String(error)),
        )
        .finally(() => this.scheduleSources());
    }, this.config.channelupdaterate ?? 30000);
    this.sourceTimer.unref();
  }

  private sourceType(source: string): number {
    const T = this.api.hap.Characteristic.InputSourceType;
    if (source.includes("hdmi")) return T.HDMI;
    if (source.includes("component")) return T.COMPONENT_VIDEO;
    if (source.includes("scart")) return T.S_VIDEO;
    if (source.includes("widi")) return T.AIRPLAY;
    if (source.includes("tv:") || source.includes("dvb")) return T.TUNER;
    return T.OTHER;
  }

  private sourceGroups(): Set<string> {
    const groups = new Set(this.config.sources === undefined ? DEFAULT_SOURCES : undefined);
    if (this.config.sources) for (const entry of this.config.sources) groups.add(entry.source);
    if (this.config.tvsource) groups.add(this.config.tvsource);
    if (this.config.applications?.length) groups.add("applications");
    return groups;
  }

  private async scan(): Promise<void> {
    if (this.stopped || !this.power) return;
    const groups = this.sourceGroups();
    for (const [uri, input] of this.inputs) if (!groups.has(input.group)) this.inputs.delete(uri);
    for (const group of groups) {
      if (this.stopped) return;
      try {
        const found: { title?: string | null; uri: string }[] = [];
        if (group === "applications") {
          const apps = (await this.client.appControl.getApplicationList()).result[0];
          const filters = this.config.applications ?? [];
          found.push(
            ...apps
              .filter((app) => filters.some((filter) => app.title.includes(filter.title)))
              .sort((a, b) => a.title.localeCompare(b.title)),
          );
        } else {
          let start = 0;
          while (!this.stopped) {
            const page = (
              await this.client.avContent.getContentList({ source: group, stIdx: start, cnt: 100 })
            ).result[0];
            found.push(...page);
            if (page.length < 100) break;
            start += page.length;
          }
        }
        if (this.stopped) return;
        const uris = new Set(found.map((input) => input.uri));
        // Only a successful complete scan is allowed to delete cached inputs.
        for (const [uri, input] of this.inputs)
          if (input.group === group && !uris.has(uri)) this.inputs.delete(uri);
        for (const item of found) {
          const previous = this.inputs.get(item.uri);
          const nextIdentifier = Number(this.accessory.context.nextInputIdentifier ?? 1);
          this.inputs.set(item.uri, {
            ...previous,
            uri: item.uri,
            title: item.title || item.uri,
            group,
            type:
              group === "applications"
                ? this.api.hap.Characteristic.InputSourceType.APPLICATION
                : this.sourceType(group),
            identifier: previous?.identifier ?? nextIdentifier,
          });
          if (!previous) this.accessory.context.nextInputIdentifier = nextIdentifier + 1;
        }
      } catch (error) {
        this.debug(`${this.config.name}: cannot scan ${group}`, error);
      }
    }
    if (!this.stopped) {
      this.syncInputs();
      this.save();
    }
  }

  private syncInputs(): void {
    const { Service: S, Characteristic: C } = this.api.hap;
    const exposed = [...this.inputs.values()].slice(0, MAX_INPUTS);
    if (this.inputs.size > MAX_INPUTS)
      this.log.warn(
        `${this.config.name}: exposing only ${MAX_INPUTS} inputs to respect HomeKit's service limit; narrow sources/applications.`,
      );
    const wanted = new Set(exposed.map((input) => this.subtype(input.uri)));
    for (let index = this.accessory.services.length - 1; index >= 0; index--) {
      const service = this.accessory.services[index]!;
      if (service.UUID === S.InputSource.UUID && !wanted.has(service.subtype ?? "")) {
        this.tv.removeLinkedService(service);
        this.accessory.removeService(service);
      }
    }
    this.services.clear();
    for (const input of exposed) {
      const service =
        this.accessory.getServiceById(S.InputSource, this.subtype(input.uri)) ??
        this.accessory.addService(S.InputSource, input.title, this.subtype(input.uri));
      service
        .updateCharacteristic(C.Identifier, input.identifier)
        .updateCharacteristic(C.ConfiguredName, input.configuredName ?? input.title)
        .updateCharacteristic(C.InputSourceType, input.type)
        .updateCharacteristic(C.IsConfigured, C.IsConfigured.CONFIGURED)
        .updateCharacteristic(
          C.CurrentVisibilityState,
          input.visibility ?? C.CurrentVisibilityState.SHOWN,
        )
        .updateCharacteristic(
          C.TargetVisibilityState,
          input.visibility ?? C.TargetVisibilityState.SHOWN,
        );
      service.getCharacteristic(C.ConfiguredName).onSet((value) => {
        input.configuredName = value as string;
        service.updateCharacteristic(C.ConfiguredName, input.configuredName);
        this.persistInputs();
        this.save();
      });
      service.getCharacteristic(C.TargetVisibilityState).onSet((value) => {
        input.visibility = Number(value);
        service.updateCharacteristic(C.CurrentVisibilityState, input.visibility);
        service.updateCharacteristic(C.TargetVisibilityState, input.visibility);
        this.persistInputs();
        this.save();
      });
      this.tv.addLinkedService(service);
      this.services.set(input.identifier, service);
    }
    const identifier = this.currentUri
      ? (this.inputs.get(this.currentUri)?.identifier ?? 0)
      : this.activeIdentifier;
    this.updateIdentifier(this.services.has(identifier) ? identifier : 0);
    this.persistInputs();
  }

  private persistInputs(): void {
    this.accessory.context.inputs = [...this.inputs.values()];
  }

  private debug(message: string, error: unknown): void {
    if (this.config.debug) this.log.info(message, String(error));
    else this.log.debug(message, String(error));
  }

  private subtype(uri: string): string {
    return createHash("sha256").update(uri).digest("hex");
  }
}
