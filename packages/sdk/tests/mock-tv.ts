import { expect } from "vitest";
import { http, HttpResponse } from "msw";

let nextTvId = 0;
export const HDMI_1 = "extInput:hdmi?port=1";
export const HDMI_2 = "extInput:hdmi?port=2";
export const CHANNEL = "tv:dvbt?trip=1.2.3&srvName=News";
export const APP_URI = 'localapp://webappruntime?url=https%3A%2F%2Fexample.test%2F&q="news"';

interface RpcRequest {
  id: number;
  method: string;
  version: string;
  params: unknown[];
}

/** Stateful mock: setters change the state observed by later reads. */
export class MockTv {
  power = false;
  // Isolate MSW's cookie store across tests without relying on private MSW APIs.
  readonly url = `http://bravia-${++nextTvId}.test:8080`;
  playingUri = HDMI_1;
  activeApp: string | undefined;
  readonly calls: string[] = [];
  readonly ids = new Set<number>();
  readonly volumes = [
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
  ];
  readonly content: Record<string, { title: string; uri: string; index: number }[]> = {
    "extInput:hdmi": [
      { title: "HDMI 1", uri: HDMI_1, index: 0 },
      { title: "HDMI 2", uri: HDMI_2, index: 1 },
    ],
    "extInput:component": [],
    "extInput:scart": [],
    "extInput:cec": [{ title: "Player", uri: "extInput:cec?port=1&logicalAddr=4", index: 0 }],
    "extInput:widi": [],
    "tv:dvbt": [{ title: "News", uri: CHANNEL, index: 0 }],
  };

  private authorized(request: Request): boolean {
    return (
      /(?:^|[;,]\s*)auth=tv-session(?:$|[;,])/.test(request.headers.get("Cookie") ?? "") ||
      request.headers.get("X-Auth-PSK") === "test-psk"
    );
  }

  readonly handlers = [
    http.post(`${this.url}/sony/IRCC`, async ({ request }) => {
      expect(request.headers.get("Content-Type")).toBe("text/xml; charset=UTF-8");
      expect(request.headers.get("SOAPAction")).toBe(
        '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
      );
      if (!this.authorized(request)) {
        return new HttpResponse("Unauthorized", { status: 401 });
      }
      const body = await request.text();
      expect(body).toMatch(/xmlns:s="http:\/\/schemas.xmlsoap.org\/soap\/envelope\/"/);
      expect(body).toMatch(/<u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">/);
      const code = body.match(/<IRCCCode>([^<]+)<\/IRCCCode>/)?.[1];
      expect(code).toBeTruthy();
      this.calls.push(`IRCC:${code}`);
      if (code === "AAAAAQAAAAEAAAASAw==") this.volumes[0]!.volume++;
      if (code === "AAAAAQAAAAEAAAATAw==") this.volumes[0]!.volume--;
      if (code === "AAAAAQAAAAEAAAAvAw==") this.power = false;
      // Real IRCC responses may be XML, not JSON.
      return new HttpResponse(
        '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:X_SendIRCCResponse xmlns:u="urn:schemas-sony-com:service:IRCC:1"/></s:Body></s:Envelope>',
        {
          headers: { "Content-Type": "text/xml" },
        },
      );
    }),
    http.post(`${this.url}/sony/:service`, async ({ request, params: path }) => {
      expect(request.headers.get("Content-Type") ?? "").toMatch(/^application\/json/);
      const rpc = (await request.json()) as RpcRequest;
      expect(rpc.version).toBe("1.0");
      expect(Number.isInteger(rpc.id) && rpc.id >= 1 && rpc.id <= 2_147_483_647).toBe(true);
      expect(this.ids.has(rpc.id), "Request IDs must distinguish calls on a client").toBe(false);
      this.ids.add(rpc.id);
      this.calls.push(rpc.method);
      const success = (result: unknown[], headers?: [string, string][]) =>
        HttpResponse.json({ id: rpc.id, result }, { headers });
      const error = (code: number, message: string) =>
        HttpResponse.json({ id: rpc.id, error: [code, message] });
      expect(Array.isArray(rpc.params)).toBe(true);

      if (path.service === "accessControl" && rpc.method === "actRegister") {
        const [identity, permissions] = rpc.params;
        expect(identity).toMatchObject({
          clientid: expect.any(String),
          nickname: expect.any(String),
        });
        expect(permissions).toStrictEqual([{ function: "WOL", value: "yes" }]);
        if (this.authorized(request)) return success([]);
        if (request.headers.get("Authorization") !== "Basic OjEyMzQ=") {
          return new HttpResponse("PIN required", { status: 401 });
        }
        return success(
          [],
          [
            ["Set-Cookie", "auth=tv-session; Path=/sony; HttpOnly"],
            ["Set-Cookie", "unrelated=not-the-session; Path=/"],
          ],
        );
      }

      if (path.service === "system" && rpc.method === "getInterfaceInformation") {
        expect(rpc.params).toStrictEqual([]);
        return success([
          {
            productCategory: "tv",
            productName: "BRAVIA",
            modelName: "FW-55BZ35F",
            serverName: "",
            interfaceVersion: "5.0.1",
          },
        ]);
      }
      if (!this.authorized(request)) return error(403, "Forbidden");
      // PIN Basic credentials must not leak into subsequent TV requests.
      expect(request.headers.get("Authorization")).toBeNull();
      const input = rpc.params[0] as Record<string, unknown> | undefined;

      switch (`${String(path.service)}/${rpc.method}`) {
        case "system/getSystemInformation":
          return success([
            {
              product: "TV",
              model: "FW-55BZ35F",
              name: "BRAVIA",
              language: "eng",
              serial: "1000001",
              macAddr: "04:5D:4B:AD:6D:E1",
              generation: "5.0.1",
            },
          ]);
        case "system/getPowerStatus":
          return success([{ status: this.power ? "active" : "standby" }]);
        case "system/setPowerStatus":
          expect(typeof input?.status).toBe("boolean");
          this.power = input!.status as boolean;
          return success([]);
        case "avContent/getContentList": {
          expect(typeof input?.source).toBe("string");
          const entries = this.content[input!.source as string];
          if (!entries) return error(3, "Illegal Argument");
          const start = (input!.stIdx as number | undefined) ?? 0;
          const count = (input!.cnt as number | undefined) ?? 50;
          return success([entries.slice(start, start + count)]);
        }
        case "avContent/getPlayingContentInfo": {
          if (!this.power || this.activeApp) return error(7, "Illegal State");
          const current = Object.entries(this.content)
            .flatMap(([source, entries]) => entries.map((entry) => ({ ...entry, source })))
            .find((entry) => entry.uri === this.playingUri);
          expect(current).toBeDefined();
          return success([current]);
        }
        case "avContent/setPlayContent":
          if (!this.power) return error(7, "Illegal State");
          if (
            !Object.values(this.content)
              .flat()
              .some((entry) => entry.uri === input?.uri)
          ) {
            return error(41001, "Content does not exist");
          }
          this.playingUri = input!.uri as string;
          this.activeApp = undefined;
          return success([]);
        case "appControl/getApplicationList":
          return success([[{ title: 'An "error" story', uri: APP_URI }]]);
        case "appControl/setActiveApp":
          if (!this.power) return error(7, "Illegal State");
          expect(input?.uri).toBe(APP_URI);
          this.activeApp = input!.uri as string;
          return success([]);
        case "audio/getVolumeInformation":
          return success([this.volumes]);
        case "audio/setAudioMute":
          expect(typeof input?.status).toBe("boolean");
          for (const volume of this.volumes) volume.mute = input!.status as boolean;
          return success([0]);
        case "audio/setAudioVolume": {
          expect(typeof input?.volume).toBe("string");
          const volume = this.volumes.find((volume) => volume.target === input?.target)!;
          expect(volume).toBeDefined();
          const command = input!.volume as string;
          volume.volume = /^[+-]/.test(command) ? volume.volume + Number(command) : Number(command);
          return success([0]);
        }
        default:
          return error(12, "No Such Method");
      }
    }),
  ];
}
