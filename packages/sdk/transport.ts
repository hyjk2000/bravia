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
  /** Request deadline in milliseconds, including JSON body reads. Defaults to 10,000. */
  timeoutMs?: number;
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

export class HttpError extends Error {
  override name = "HTTPError";

  public readonly response: Response;

  constructor(response: Response) {
    super(`HTTP status ${response.status}`);
    this.response = response;
  }
}

export class BraviaTransport {
  private readonly baseUrl: URL;
  private readonly psk: string | undefined;
  private readonly timeoutMs: number;
  private sessionCookie: string | undefined;
  private nextId = 1;

  constructor({ baseUrl, cookie, psk, timeoutMs = 10_000 }: BraviaOptions) {
    this.sessionCookie = cookie;
    this.baseUrl = new URL("/sony/", baseUrl);
    this.psk = psk;
    this.timeoutMs = timeoutMs;
  }

  get cookie(): string | undefined {
    return this.sessionCookie;
  }

  private async post(
    service: string,
    body: string,
    requestHeaders: Record<string, string>,
  ): Promise<Response> {
    const headers = new Headers(requestHeaders);
    if (this.psk !== undefined && !headers.has("X-Auth-PSK")) {
      headers.set("X-Auth-PSK", this.psk);
    }
    if (this.sessionCookie) {
      headers.set("Cookie", this.sessionCookie);
    }
    // Never retry commands: relative volume changes and remote keys have side effects.
    const response = await fetch(new URL(service, this.baseUrl), {
      method: "POST",
      body,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookie(header);
      if (cookie.name === "auth" && cookie.value !== undefined) {
        this.sessionCookie = stringifyCookie({ auth: cookie.value });
      }
    }
    if (!response.ok) {
      throw new HttpError(response);
    }
    return response;
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
    const response = await this.post(
      service,
      JSON.stringify({ id, method, version: options.version ?? "1.0", params }),
      { "Content-Type": "application/json", ...options.headers },
    );
    const json = (await response.json()) as RpcResponse<R> | RpcErrorResponse;

    // Sony specifies that a successful result takes precedence over error.
    if ("result" in json) {
      return json;
    }
    const [code, message] = json.error;
    throw new BraviaError(message, code, json.id);
  }

  async postIrcc(body: string): Promise<void> {
    const response = await this.post("IRCC", body, {
      "Content-Type": "text/xml; charset=UTF-8",
      SOAPAction: '"urn:schemas-sony-com:service:IRCC:1#X_SendIRCC"',
    });
    await response.text();
  }
}
