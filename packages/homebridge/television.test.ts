import { expect, test } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { API, Logging } from "homebridge";
import { Bravia } from "@hyjk2000/bravia-sdk";
import { Television } from "./television.ts";

// Use Homebridge's real HAP implementation, not characteristic/service doubles.
const require = createRequire(import.meta.url);
const { HomebridgeAPI } = require("homebridge/lib/api.js") as { HomebridgeAPI: new () => API };
const quiet = () => {};
const log: Logging = Object.assign(quiet, {
  prefix: "test",
  info: quiet,
  success: quiet,
  warn: quiet,
  error: quiet,
  debug: quiet,
  log: quiet,
});

async function fixture(overrides: { channelupdaterate?: number; updaterate?: number } = {}) {
  const state = {
    power: true,
    uri: "extInput:hdmi?port=1",
    volume: 20,
    mute: false,
    failScan: false,
    failCommand: false,
    failPlayingContent: false,
    app: "",
    calls: [] as string[],
    inputs: [1, 2, 3].map((port) => ({ title: `HDMI ${port}`, uri: `extInput:hdmi?port=${port}` })),
  };
  let heldReply: { method: string; received: () => void; release: Promise<void> } | undefined;
  const holdStatusReply = (method: "getPlayingContentInfo" | "getPowerStatus") => {
    const received = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    heldReply = { method, received: received.resolve, release: release.promise };
    return { received: received.promise, release: release.resolve };
  };
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      const reply = (value: unknown) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (request.url?.endsWith("IRCC")) {
        state.calls.push(body);
        response.end("");
        return;
      }
      const { id, method, params } = JSON.parse(body) as {
        id: number;
        method: string;
        params: Record<string, unknown>[];
      };
      state.calls.push(method);
      let result: unknown[] = [];
      const input = params[0] ?? {};
      if (
        (method === "getContentList" && state.failScan) ||
        (method === "setPlayContent" && state.failCommand) ||
        (method === "getPlayingContentInfo" && state.failPlayingContent)
      ) {
        reply({ id, error: [7, "Unavailable"] });
        return;
      }
      switch (method) {
        case "getInterfaceInformation":
          result = [{ productName: "Sony", modelName: "Bravia" }];
          break;
        case "getSystemInformation":
          result = [{ model: "XR-55", serial: "123" }];
          break;
        case "getPowerStatus":
          result = [{ status: state.power ? "active" : "standby" }];
          break;
        case "setPowerStatus":
          state.power = Boolean(input.status);
          break;
        case "getPlayingContentInfo":
          result = [{ uri: state.uri }];
          break;
        case "getContentList":
          result = [
            state.inputs.slice(Number(input.stIdx), Number(input.stIdx) + Number(input.cnt)),
          ];
          break;
        case "getApplicationList":
          result = [
            [
              { title: "Video", uri: "app:video" },
              { title: "Music", uri: "app:music" },
            ],
          ];
          break;
        case "setActiveApp":
          state.app = String(input.uri);
          break;
        case "setPlayContent":
          state.uri = String(input.uri);
          break;
        case "getVolumeInformation":
          result = [[{ target: "speaker", volume: state.volume, mute: state.mute }]];
          break;
        case "setAudioVolume":
          state.volume = Number(input.volume);
          break;
        case "setAudioMute":
          state.mute = Boolean(input.status);
          break;
        default:
          reply({ id, error: [12, "Unknown method"] });
          return;
      }
      if (heldReply?.method === method) {
        const held = heldReply;
        heldReply = undefined;
        held.received();
        await held.release;
      }
      reply({ id, result });
    })().catch(() => {
      response.statusCode = 500;
      response.end("Fixture failed");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  expect(address).toHaveProperty("port", expect.any(Number));
  const api = new HomebridgeAPI();
  const accessory = new api.platformAccessory(
    "Living Room",
    api.hap.uuid.generate("test-television"),
  );
  const config = {
    name: "Living Room",
    ip: "127.0.0.1",
    port: address.port,
    sources: [{ source: "extInput:hdmi" }],
    applications: [{ title: "Video" }],
    starttimeout: 1,
    channelupdaterate: 25,
    updaterate: 60_000,
    ...overrides,
  };
  const client = new Bravia({ baseUrl: `http://127.0.0.1:${address.port}` });
  // Exercise real scheduled refreshes and live HTTP; await persistence signals, not sleeps.
  const observers = new Set<() => void>();
  const save = () => {
    for (const observe of observers) observe();
  };
  const until = (predicate: () => boolean): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const observe = () => {
      if (predicate()) {
        observers.delete(observe);
        resolve();
      }
    };
    observers.add(observe);
    observe();
    return promise;
  };
  const tv = new Television(api, log, config, accessory, client, save);
  const C = api.hap.Characteristic;
  const television = accessory.getService(api.hap.Service.Television)!;
  const speaker = accessory.getService(api.hap.Service.TelevisionSpeaker)!;
  return {
    state,
    api,
    accessory,
    config,
    client,
    tv,
    C,
    television,
    speaker,
    holdStatusReply,
    until,
    close: async () => {
      tv.stop();
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

test("stable input identities and user names survive reordered scans, failures, removals and restore", async () => {
  const f = await fixture();
  try {
    await f.tv.start();
    const original = f.accessory.context.inputs as { uri: string; identifier: number }[];
    const first = original.find((input) => input.uri.endsWith("port=1"))!;
    expect(f.television.getCharacteristic(f.C.ActiveIdentifier).value).toBe(first.identifier);
    const service = f.accessory.services.find(
      (s) =>
        s.UUID === f.api.hap.Service.InputSource.UUID &&
        s.getCharacteristic(f.C.Identifier).value === first.identifier,
    )!;
    await service.getCharacteristic(f.C.ConfiguredName).handleSetRequest("Console");
    await service
      .getCharacteristic(f.C.TargetVisibilityState)
      .handleSetRequest(f.C.TargetVisibilityState.HIDDEN);
    f.state.inputs.reverse();
    await f.until(() => f.state.calls.filter((method) => method === "getContentList").length >= 2);
    expect(service.getCharacteristic(f.C.Identifier).value).toBe(first.identifier);
    expect(service.getCharacteristic(f.C.ConfiguredName).value).toBe("Console");
    const saved = f.api.platformAccessory.deserialize(
      f.api.platformAccessory.serialize(f.accessory),
    );
    const cached = new Television(f.api, log, f.config, saved, f.client, quiet);
    try {
      const restored = saved.services.find(
        (s) =>
          s.UUID === f.api.hap.Service.InputSource.UUID &&
          s.getCharacteristic(f.C.Identifier).value === first.identifier,
      )!;
      expect(restored.getCharacteristic(f.C.ConfiguredName).value).toBe("Console");
      expect(restored.getCharacteristic(f.C.CurrentVisibilityState).value).toBe(
        f.C.CurrentVisibilityState.HIDDEN,
      );
    } finally {
      cached.stop();
    }
    f.state.failScan = true;
    const before = f.state.calls.filter((method) => method === "getContentList").length;
    f.state.inputs = [];
    await f.until(
      () => f.state.calls.filter((method) => method === "getContentList").length > before,
    );
    expect(
      f.accessory.services.filter((s) => s.UUID === f.api.hap.Service.InputSource.UUID),
    ).toHaveLength(4);
    f.state.failScan = false;
    await f.until(
      () =>
        f.accessory.services.filter((s) => s.UUID === f.api.hap.Service.InputSource.UUID).length ===
        1,
    );
    // An independently discovered application must survive every physical-input refresh.
    expect(
      (f.accessory.context.inputs as { uri: string }[]).some((input) => input.uri === "app:video"),
    ).toBe(true);
    expect(f.television.getCharacteristic(f.C.ActiveIdentifier).value).toBe(0);
    f.state.inputs = [{ title: "HDMI 1", uri: first.uri }];
    await f.until(
      () =>
        f.accessory.services.filter((s) => s.UUID === f.api.hap.Service.InputSource.UUID).length ===
        2,
    );
    const replacement = (f.accessory.context.inputs as { uri: string; identifier: number }[]).find(
      (input) => input.uri === first.uri,
    )!;
    expect(replacement.identifier).not.toBe(first.identifier); // Removed IDs are never recycled for a different service.
    expect(f.television.getCharacteristic(f.C.ActiveIdentifier).value).toBe(replacement.identifier);
    f.tv.stop();
    const restored = f.api.platformAccessory.deserialize(
      f.api.platformAccessory.serialize(f.accessory),
    );
    const restarted = new Television(f.api, log, f.config, restored, f.client, quiet);
    try {
      const restoredInputs = restored.services.filter(
        (s) => s.UUID === f.api.hap.Service.InputSource.UUID,
      );
      expect(
        restoredInputs.some(
          (s) => s.getCharacteristic(f.C.Identifier).value === replacement.identifier,
        ),
      ).toBe(true);
    } finally {
      restarted.stop();
    }
  } finally {
    await f.close();
  }
});

test("selected HDMI input survives a source refresh before the next status poll", async () => {
  const f = await fixture();
  try {
    await f.tv.start();
    const inputs = f.accessory.context.inputs as { uri: string; identifier: number }[];
    const selected = inputs.find((input) => input.uri.endsWith("port=2"))!;
    const active = f.television.getCharacteristic(f.C.ActiveIdentifier);
    await active.handleSetRequest(selected.identifier);
    const scans = f.state.calls.filter((method) => method === "getApplicationList").length;
    await f.until(
      () => f.state.calls.filter((method) => method === "getApplicationList").length > scans,
    );
    expect(active.value).toBe(selected.identifier);
    expect(await active.handleGetRequest()).toBe(selected.identifier);
  } finally {
    await f.close();
  }
});

test("a delayed status poll cannot undo a successful HomeKit input selection", async () => {
  const f = await fixture({ updaterate: 25, channelupdaterate: 0 });
  try {
    await f.tv.start();
    const inputs = f.accessory.context.inputs as { uri: string; identifier: number }[];
    const selected = inputs.find((input) => input.uri.endsWith("port=2"))!;
    const external = inputs.find((input) => input.uri.endsWith("port=3"))!;
    const active = f.television.getCharacteristic(f.C.ActiveIdentifier);
    const delayed = f.holdStatusReply("getPlayingContentInfo");
    try {
      await delayed.received;
      await active.handleSetRequest(selected.identifier);
      const observed: unknown[] = [];
      active.on("change", ({ newValue }) => {
        observed.push(newValue);
      });
      f.state.uri = external.uri;
      delayed.release();
      await f.until(() => active.value === external.identifier);
      expect(observed).toEqual([external.identifier]);
    } finally {
      delayed.release();
    }
  } finally {
    await f.close();
  }
});

test("unavailable playing content does not clear a selected app, but a known input can replace it", async () => {
  const f = await fixture({ updaterate: 25, channelupdaterate: 0 });
  try {
    await f.tv.start();
    const inputs = f.accessory.context.inputs as { uri: string; identifier: number }[];
    const app = inputs.find((input) => input.uri === "app:video")!;
    const hdmi = inputs.find((input) => input.uri === f.state.uri)!;
    const active = f.television.getCharacteristic(f.C.ActiveIdentifier);

    f.state.failPlayingContent = true;
    await active.handleSetRequest(app.identifier);
    const polls = f.state.calls.filter((method) => method === "getPlayingContentInfo").length;
    await f.until(
      () =>
        f.state.calls.filter((method) => method === "getPlayingContentInfo").length >= polls + 2,
    );
    expect(active.value).toBe(app.identifier);
    expect(await active.handleGetRequest()).toBe(app.identifier);

    f.state.failPlayingContent = false;
    await f.until(() => active.value === hdmi.identifier);
    expect(await active.handleGetRequest()).toBe(hdmi.identifier);
  } finally {
    await f.close();
  }
});

test("a delayed HomeKit power read cannot undo power-on and input selection", async () => {
  const f = await fixture();
  try {
    await f.tv.start();
    const delayed = f.holdStatusReply("getPowerStatus");
    const power = f.television.getCharacteristic(f.C.Active);
    const active = f.television.getCharacteristic(f.C.ActiveIdentifier);
    const selected = (f.accessory.context.inputs as { uri: string; identifier: number }[]).find(
      (input) => input.uri.endsWith("port=2"),
    )!;
    f.state.power = false;
    const reading = power.handleGetRequest();
    try {
      await delayed.received;
      await power.handleSetRequest(f.C.Active.ACTIVE);
      await active.handleSetRequest(selected.identifier);
    } finally {
      delayed.release();
      await expect(reading).resolves.toBe(f.C.Active.ACTIVE);
    }
    expect(power.value).toBe(f.C.Active.ACTIVE);
    expect(await active.handleGetRequest()).toBe(selected.identifier);
  } finally {
    await f.close();
  }
});

test("a rejected HomeKit selection does not invalidate an in-flight power read", async () => {
  const f = await fixture();
  try {
    await f.tv.start();
    const power = f.television.getCharacteristic(f.C.Active);
    const active = f.television.getCharacteristic(f.C.ActiveIdentifier);
    const selected = (f.accessory.context.inputs as { uri: string; identifier: number }[]).find(
      (input) => input.uri.endsWith("port=2"),
    )!;
    f.state.power = false;
    f.state.failCommand = true;
    const delayed = f.holdStatusReply("getPowerStatus");
    const reading = power.handleGetRequest();
    try {
      await delayed.received;
      await expect(active.handleSetRequest(selected.identifier)).rejects.toThrow();
    } finally {
      delayed.release();
      await expect(reading).resolves.toBe(f.C.Active.INACTIVE);
    }
    expect(await active.handleGetRequest()).toBe(0);
  } finally {
    await f.close();
  }
});

test("HomeKit commands await TV success, propagate errors, wake before selecting, and control audio/apps", async () => {
  const f = await fixture();
  try {
    await f.tv.start();
    const inputs = f.accessory.context.inputs as { uri: string; identifier: number }[];
    const physical = inputs.find((input) => input.uri.endsWith("port=2"))!;
    f.state.failCommand = true;
    await expect(
      f.television.getCharacteristic(f.C.ActiveIdentifier).handleSetRequest(physical.identifier),
    ).rejects.toThrow();
    expect(await f.television.getCharacteristic(f.C.ActiveIdentifier).handleGetRequest()).toBe(
      inputs.find((input) => input.uri.endsWith("port=1"))!.identifier,
    );
    f.state.failCommand = false;
    await f.television.getCharacteristic(f.C.Active).handleSetRequest(f.C.Active.INACTIVE);
    expect(f.state.power).toBe(false);
    await f.television
      .getCharacteristic(f.C.ActiveIdentifier)
      .handleSetRequest(physical.identifier);
    expect(f.state.power).toBe(true);
    expect(f.state.uri).toBe(physical.uri);
    expect(f.state.calls.lastIndexOf("setPowerStatus")).toBeLessThan(
      f.state.calls.lastIndexOf("setPlayContent"),
    );
    await f.speaker.getCharacteristic(f.C.Volume).handleSetRequest(36);
    await f.speaker.getCharacteristic(f.C.Mute).handleSetRequest(true);
    expect(await f.speaker.getCharacteristic(f.C.Volume).handleGetRequest()).toBe(36);
    expect(await f.speaker.getCharacteristic(f.C.Mute).handleGetRequest()).toBe(true);
    const app = inputs.find((input) => input.uri === "app:video")!;
    await f.television.getCharacteristic(f.C.ActiveIdentifier).handleSetRequest(app.identifier);
    expect(f.state.app).toBe("app:video");
    await f.television.getCharacteristic(f.C.RemoteKey).handleSetRequest(f.C.RemoteKey.ARROW_UP);
    expect(
      f.state.calls.some((call) => call.includes("<IRCCCode>AAAAAQAAAAEAAAB0Aw==</IRCCCode>")),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

test("removed source groups and changed app filters prune restored inputs while the TV is off", async () => {
  const f = await fixture();
  try {
    await f.tv.start();
    f.tv.stop();
    f.state.power = false;
    const restored = f.api.platformAccessory.deserialize(
      f.api.platformAccessory.serialize(f.accessory),
    );
    const restarted = new Television(
      f.api,
      log,
      { ...f.config, sources: [], applications: [{ title: "Other" }] },
      restored,
      f.client,
      quiet,
    );
    try {
      await restarted.start();
      expect(restored.context.inputs).toStrictEqual([]);
      expect(
        restored.services.some((service) => service.UUID === f.api.hap.Service.InputSource.UUID),
      ).toBe(false);
    } finally {
      restarted.stop();
    }
  } finally {
    await f.close();
  }
});
