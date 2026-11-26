import { BraviaError, HttpError, type BraviaTransport } from "./transport.ts";

export interface RegistrationOptions {
  /** Stable identity for this controller; reuse it when renewing registration. */
  clientid: string;
  nickname: string;
  /** PIN displayed by the TV; omit to initiate the challenge. */
  pin?: string;
}

export class AccessControl {
  private readonly transport: BraviaTransport;

  constructor(transport: BraviaTransport) {
    this.transport = transport;
  }

  /** Returns the session cookie, or null for a PIN challenge/no session cookie. */
  async actRegister({ clientid, nickname, pin }: RegistrationOptions): Promise<string | null> {
    try {
      await this.transport.call<[]>(
        "accessControl",
        "actRegister",
        [{ clientid, nickname }, [{ function: "WOL", value: "yes" }]],
        {
          // The PIN is used only for registration, never retained on the client.
          headers: pin === undefined ? {} : { Authorization: `Basic ${btoa(":" + pin)}` },
        },
      );
      return this.transport.cookie ?? null;
    } catch (error) {
      if (
        (error instanceof HttpError && error.response.status === 401) ||
        (error instanceof BraviaError && error.id === 401)
      ) {
        return null;
      }
      throw error;
    }
  }
}
