import ky, { type KyInstance } from "ky";
import { parseSetCookie, stringifyCookie } from "cookie";

export type RpcResponse<R extends unknown[]> = {
  id: number;
  result: R;
};

type RpcErrorResponse = {
  id: number;
  error: [code: number, message: string];
};

export interface BraviaOptions {
  /** TV origin, for example http://192.168.1.100:80. */
  baseUrl: string;
  /** Previously persisted auth=name session cookie. */
  cookie?: string;
  /** Pre-shared key configured in the TV's IP control settings. */
  psk?: string;
}

export class BraviaError extends Error {
  override name = "BraviaError";

  public errorMessage: string;
  /** Sony API error code, not the JSON-RPC correlation ID. */
  public id: number;
  public requestId: number;

  constructor(errorMessage: string, id: number, requestId: number) {
    super(`${errorMessage} [${id}]`);
    this.errorMessage = errorMessage;
    this.id = id;
    this.requestId = requestId;
  }
}

export class BraviaTransport {
  private readonly client: KyInstance;
  private sessionCookie: string | undefined;
  private nextId = 1;

  constructor({ baseUrl, cookie, psk }: BraviaOptions) {
    this.sessionCookie = cookie;
    this.client = ky.create({
      baseUrl: new URL("/sony/", baseUrl),
      // Repeating commands can have side effects (relative volume, remote keys).
      retry: 0,
      headers: psk === undefined ? {} : { "X-Auth-PSK": psk },
      hooks: {
        beforeRequest: [
          ({ request }) => {
            if (this.sessionCookie) {
              request.headers.set("Cookie", this.sessionCookie);
            }
          },
        ],
        afterResponse: [
          ({ response }) => {
            for (const header of response.headers.getSetCookie()) {
              const cookie = parseSetCookie(header);
              if (cookie.name === "auth" && cookie.value !== undefined) {
                this.sessionCookie = stringifyCookie({ auth: cookie.value });
              }
            }
          },
        ],
      },
    });
  }

  get cookie(): string | undefined {
    return this.sessionCookie;
  }

  async call<R extends unknown[]>(
    service: string,
    method: string,
    params: readonly unknown[] = [],
    options: { version?: string; headers?: Record<string, string> } = {},
  ): Promise<RpcResponse<R>> {
    const id = this.nextId;
    // Sony reserves zero and restricts IDs to positive signed 32-bit integers.
    this.nextId = id === 2_147_483_647 ? 1 : id + 1;
    const json = await this.client
      .post(service, {
        json: { id, method, version: options.version ?? "1.0", params },
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      })
      .json<RpcResponse<R> | RpcErrorResponse>();

    // Sony specifies that a successful result takes precedence over error.
    if ("result" in json) {
      return json;
    }
    const [code, message] = json.error;
    throw new BraviaError(message, code, json.id);
  }

  async postIrcc(body: string): Promise<void> {
    await this.client.post("IRCC", {
      body,
      headers: {
        "Content-Type": "text/xml; charset=UTF-8",
        SOAPAction: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
      },
    });
  }
}
