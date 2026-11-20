import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Bravia, BraviaError, IRCC_CODES } from "../index.ts";
import { APP_URI, CHANNEL, HDMI_1, HDMI_2, MockTv } from "./mock-tv.ts";

const server = setupServer();
let tv: MockTv;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  tv = new MockTv();
  server.resetHandlers(...tv.handlers);
});

describe("Homebridge startup: interface probe → PIN pairing → metadata → sources → apps", () => {
  test("pairs once and reuses the auth cookie across all discovery domains", async () => {
    const client = new Bravia({ baseUrl: tv.url });
    const identity = {
      clientid: "HomeBridge-Bravia:stable-uuid",
      nickname: "homebridge",
    };

    // start() → probeInterfaceInfo(): public metadata is available before pairing.
    const {
      result: [device],
    } = await client.system.getInterfaceInformation();
    expect(device).toMatchObject({
      productName: "BRAVIA",
      modelName: "FW-55BZ35F",
    });

    // checkRegistration(): first request displays a PIN; an incorrect PIN stays challenged.
    expect(await client.accessControl.actRegister(identity)).toBeNull();
    expect(await client.accessControl.actRegister({ ...identity, pin: "0000" })).toBeNull();
    expect(client.cookie).toBeUndefined();

    // Retry with the on-screen PIN. Ignore unrelated Set-Cookie headers and cookie attributes.
    expect(await client.accessControl.actRegister({ ...identity, pin: "1234" })).toBe(
      "auth=tv-session",
    );
    expect(client.cookie).toBe("auth=tv-session");
    const {
      result: [system],
    } = await client.system.getSystemInformation();
    expect(system).toMatchObject({
      serial: "1000001",
      macAddr: "04:5D:4B:AD:6D:E1",
      generation: "5.0.1",
    });

    // receiveSources() → receiveNextSources(): configured sources are scanned sequentially.
    const inputs = [];
    for (const source of [
      "extInput:hdmi",
      "extInput:component",
      "extInput:scart",
      "extInput:cec",
      "extInput:widi",
      "tv:dvbt",
    ]) {
      const {
        result: [entries],
      } = await client.avContent.getContentList({ source, stIdx: 0 });
      inputs.push(...entries);
    }
    expect(inputs.map(({ title, uri }) => ({ title, uri }))).toStrictEqual([
      { title: "HDMI 1", uri: HDMI_1 },
      { title: "HDMI 2", uri: HDMI_2 },
      { title: "Player", uri: "extInput:cec?port=1&logicalAddr=4" },
      { title: "News", uri: CHANNEL },
    ]);

    // receiveApplications(): result[0] is a list; a title containing '"error"' is not an API error.
    const {
      result: [apps],
    } = await client.appControl.getApplicationList();
    expect(apps).toStrictEqual([{ title: 'An "error" story', uri: APP_URI }]);
    expect(tv.calls).toStrictEqual([
      "getInterfaceInformation",
      "actRegister",
      "actRegister",
      "actRegister",
      "getSystemInformation",
      "getContentList",
      "getContentList",
      "getContentList",
      "getContentList",
      "getContentList",
      "getContentList",
      "getApplicationList",
    ]);
  });
});

describe("Homebridge input selection: power on → select input/app → poll → standby", () => {
  test("restores a saved session and observes content/power transitions without implicit wakeups", async () => {
    const client = new Bravia({
      baseUrl: `${tv.url}/ignored/path`,
      cookie: "auth=tv-session",
    });

    // checkRegistration() with a saved cookie succeeds without another PIN.
    expect(
      await client.accessControl.actRegister({
        clientid: "saved-controller",
        nickname: "homebridge",
      }),
    ).toBe("auth=tv-session");
    expect((await client.system.getPowerStatus()).result).toStrictEqual([{ status: "standby" }]);

    // Selecting content while off must expose Illegal State, not silently power on.
    await expect(client.avContent.setPlayContent({ uri: HDMI_2 })).rejects.toMatchObject({ id: 7 });
    expect(tv.power).toBe(false);
    await client.system.setPowerStatus({ status: true });
    expect((await client.system.getPowerStatus()).result).toStrictEqual([{ status: "active" }]);

    // setActiveIdentifier(non-app) → setPlayContent() → pollPlayContent().
    await client.avContent.setPlayContent({ uri: HDMI_2 });
    expect((await client.avContent.getPlayingContentInfo()).result[0]).toMatchObject({
      uri: HDMI_2,
      title: "HDMI 2",
      source: "extInput:hdmi",
    });

    // setActiveIdentifier(app) → setActiveApp(); app URIs are opaque, including quoted text.
    const {
      result: [apps],
    } = await client.appControl.getApplicationList();
    await client.appControl.setActiveApp({ uri: apps[0]!.uri });
    expect(tv.activeApp).toBe(APP_URI);
    // The AV API need not identify a running app; expose its error to the caller.
    await expect(client.avContent.getPlayingContentInfo()).rejects.toMatchObject({ id: 7 });

    // Switch back to a tuner channel, then shut down and poll again.
    await client.avContent.setPlayContent({ uri: CHANNEL });
    expect((await client.avContent.getPlayingContentInfo()).result[0].uri).toBe(CHANNEL);
    await client.system.setPowerStatus({ status: false });
    expect((await client.system.getPowerStatus()).result[0].status).toBe("standby");
    await expect(client.avContent.getPlayingContentInfo()).rejects.toMatchObject({ id: 7 });
    expect(tv.calls).toStrictEqual([
      "actRegister",
      "getPowerStatus",
      "setPlayContent",
      "setPowerStatus",
      "getPowerStatus",
      "setPlayContent",
      "getPlayingContentInfo",
      "getApplicationList",
      "setActiveApp",
      "getPlayingContentInfo",
      "setPlayContent",
      "getPlayingContentInfo",
      "setPowerStatus",
      "getPowerStatus",
      "getPlayingContentInfo",
    ]);
  });

  test("pages legacy source lists explicitly instead of assuming the first page is complete", async () => {
    const client = new Bravia({ baseUrl: tv.url, cookie: "auth=tv-session" });
    const first = await client.avContent.getContentList({
      source: "extInput:hdmi",
      stIdx: 0,
      cnt: 1,
    });
    const second = await client.avContent.getContentList({
      source: "extInput:hdmi",
      stIdx: 1,
      cnt: 1,
    });
    const end = await client.avContent.getContentList({
      source: "extInput:hdmi",
      stIdx: 2,
      cnt: 1,
    });
    expect(first.result[0]).toStrictEqual([{ title: "HDMI 1", uri: HDMI_1, index: 0 }]);
    expect(second.result[0]).toStrictEqual([{ title: "HDMI 2", uri: HDMI_2, index: 1 }]);
    expect(end.result).toStrictEqual([[]]);
  });
});

describe("Homebridge speaker/remote callbacks: read → change → read back", () => {
  test("controls independent audio targets, global mute, IRCC volume and power-off", async () => {
    const client = new Bravia({ baseUrl: tv.url, psk: "test-psk" });
    await client.system.setPowerStatus({ status: true });

    // getVolume()/getMuted(): choose the configured output from result[0].
    const {
      result: [initial],
    } = await client.audio.getVolumeInformation();
    expect(initial).toStrictEqual([
      {
        target: "speaker",
        volume: 20,
        mute: false,
        minVolume: 0,
        maxVolume: 100,
      },
      {
        target: "headphone",
        volume: 8,
        mute: false,
        minVolume: 0,
        maxVolume: 50,
      },
    ]);

    // setVolume(): absolute and relative volume are strings on the wire.
    expect(
      (await client.audio.setAudioVolume({ target: "speaker", volume: "35" })).result,
    ).toStrictEqual([0]);
    await client.audio.setAudioVolume({ target: "headphone", volume: "+2" });
    await client.audio.setAudioVolume({ target: "headphone", volume: "-1" });
    expect(
      (await client.audio.getVolumeInformation()).result[0].map(({ target, volume }) => ({
        target,
        volume,
      })),
    ).toStrictEqual([
      { target: "speaker", volume: 35 },
      { target: "headphone", volume: 9 },
    ]);

    // setMuted(): v1.0 has no target, and setter success is [0], not [].
    expect((await client.audio.setAudioMute({ status: true })).result).toStrictEqual([0]);
    expect(
      (await client.audio.getVolumeInformation()).result[0].map(({ mute }) => mute),
    ).toStrictEqual([true, true]);
    await client.audio.setAudioMute({ status: false });
    expect(
      (await client.audio.getVolumeInformation()).result[0].map(({ mute }) => mute),
    ).toStrictEqual([false, false]);

    // setVolumeSelector() uses SOAP; XML and empty success bodies must not be parsed as JSON.
    await client.ircc.sendCode(IRCC_CODES.VolumeUp);
    expect((await client.audio.getVolumeInformation()).result[0][0]!.volume).toBe(36);
    await client.ircc.sendCode(IRCC_CODES.VolumeDown);
    expect((await client.audio.getVolumeInformation()).result[0][0]!.volume).toBe(35);
    await client.ircc.sendCode(IRCC_CODES.Up);
    await client.ircc.sendCode(IRCC_CODES.Confirm);
    await client.ircc.sendCode(IRCC_CODES.Back);

    // setPowerState(false) on the plugin's MAC-configured path uses discrete IRCC power-off.
    await client.ircc.sendCode(IRCC_CODES.PowerOff);
    expect((await client.system.getPowerStatus()).result[0].status).toBe("standby");
    expect(tv.calls.filter((call) => call.startsWith("IRCC:"))).toStrictEqual([
      "IRCC:AAAAAQAAAAEAAAASAw==",
      "IRCC:AAAAAQAAAAEAAAATAw==",
      "IRCC:AAAAAQAAAAEAAAB0Aw==",
      "IRCC:AAAAAQAAAAEAAABlAw==",
      "IRCC:AAAAAgAAAJcAAAAjAw==",
      "IRCC:AAAAAQAAAAEAAAAvAw==",
    ]);
  });
});

describe("API/transport failures remain visible to the caller", () => {
  test("distinguishes an API error code from its request ID and permits a subsequent valid selection", async () => {
    const client = new Bravia({ baseUrl: tv.url, cookie: "auth=tv-session" });
    await client.system.setPowerStatus({ status: true });
    const failure = client.avContent.setPlayContent({
      uri: "extInput:hdmi?port=99",
    });
    await expect(failure).rejects.toThrow(BraviaError);
    await expect(failure).rejects.toMatchObject({
      id: 41001,
      requestId: 2,
      message: "Content does not exist [41001]",
    });
    expect(tv.playingUri).toBe(HDMI_1);
    await client.avContent.setPlayContent({ uri: HDMI_2 });
    expect((await client.avContent.getPlayingContentInfo()).result[0].uri).toBe(HDMI_2);
  });

  test("does not treat forbidden access or server failures as a PIN challenge or successful command", async () => {
    const anonymous = new Bravia({ baseUrl: tv.url });
    await expect(anonymous.system.getSystemInformation()).rejects.toMatchObject({ id: 403 });

    server.use(
      http.post(
        `${tv.url}/sony/accessControl`,
        () => new HttpResponse("Forbidden", { status: 403 }),
      ),
    );
    await expect(
      anonymous.accessControl.actRegister({
        clientid: "controller",
        nickname: "homebridge",
      }),
    ).rejects.toMatchObject({ response: { status: 403 } });

    const client = new Bravia({ baseUrl: tv.url, psk: "test-psk" });
    let attempts = 0;
    server.use(
      http.post(`${tv.url}/sony/audio`, () => {
        attempts++;
        return new HttpResponse("Unavailable", { status: 503 });
      }),
    );
    await expect(
      client.audio.setAudioVolume({ target: "speaker", volume: "+1" }),
    ).rejects.toMatchObject({ response: { status: 503 } });
    expect(attempts).toBe(1);
    expect(tv.volumes[0]!.volume).toBe(20);

    server.use(
      http.post(
        `${tv.url}/sony/IRCC`,
        () => new HttpResponse("<s:Fault>Failed</s:Fault>", { status: 500 }),
      ),
    );
    await expect(client.ircc.sendCode(IRCC_CODES.PowerOff)).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  test("accepts a JSON PIN challenge, then handles an empty SOAP success response", async () => {
    const client = new Bravia({ baseUrl: tv.url });
    server.use(
      http.post(
        `${tv.url}/sony/accessControl`,
        async ({ request }) => {
          const { id } = (await request.json()) as { id: number };
          return HttpResponse.json({ id, error: [401, "Unauthorized"] });
        },
        { once: true },
      ),
    );
    expect(
      await client.accessControl.actRegister({
        clientid: "controller",
        nickname: "homebridge",
      }),
    ).toBeNull();
    expect(
      await client.accessControl.actRegister({
        clientid: "controller",
        nickname: "homebridge",
        pin: "1234",
      }),
    ).toBe("auth=tv-session");

    server.use(http.post(`${tv.url}/sony/IRCC`, () => new HttpResponse(null, { status: 200 })));
    await client.ircc.sendCode(IRCC_CODES.Play);
    // A JSON read after an empty SOAP response still uses the paired session.
    expect((await client.system.getSystemInformation()).result[0].serial).toBe("1000001");
  });
});
