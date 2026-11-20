import { AccessControl } from "./access-control.ts";
import { AppControl } from "./app-control.ts";
import { Audio } from "./audio.ts";
import { AvContent } from "./av-content.ts";
import { Ircc } from "./ircc.ts";
import { System } from "./system.ts";
import { BraviaTransport, type BraviaOptions } from "./transport.ts";

export { AccessControl, type RegistrationOptions } from "./access-control.ts";
export * from "./app-control.ts";
export * from "./audio.ts";
export * from "./av-content.ts";
export * from "./ircc.ts";
export * from "./system.ts";
export { BraviaError, type BraviaOptions, type RpcResponse } from "./transport.ts";

export class Bravia {
  private readonly transport: BraviaTransport;
  readonly accessControl: AccessControl;
  readonly appControl: AppControl;
  readonly audio: Audio;
  readonly avContent: AvContent;
  readonly ircc: Ircc;
  readonly system: System;

  constructor(options: BraviaOptions) {
    this.transport = new BraviaTransport(options);
    this.accessControl = new AccessControl(this.transport);
    this.appControl = new AppControl(this.transport);
    this.audio = new Audio(this.transport);
    this.avContent = new AvContent(this.transport);
    this.ircc = new Ircc(this.transport);
    this.system = new System(this.transport);
  }

  /** Persist this value to restore the authenticated session in another client. */
  get cookie(): string | undefined {
    return this.transport.cookie;
  }
}
