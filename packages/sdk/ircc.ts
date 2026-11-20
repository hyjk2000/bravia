import type { BraviaTransport } from "./transport.ts";

export const IRCC_CODES = {
  VolumeUp: "AAAAAQAAAAEAAAASAw==",
  VolumeDown: "AAAAAQAAAAEAAAATAw==",
  Rewind: "AAAAAgAAAJcAAAAbAw==",
  Forward: "AAAAAgAAAJcAAAAcAw==",
  Next: "AAAAAgAAAJcAAAA9Aw==",
  Prev: "AAAAAgAAAJcAAAA8Aw==",
  FlashMinus: "AAAAAgAAAJcAAAB5Aw==",
  Up: "AAAAAQAAAAEAAAB0Aw==",
  Down: "AAAAAQAAAAEAAAB1Aw==",
  Left: "AAAAAQAAAAEAAAA0Aw==",
  Right: "AAAAAQAAAAEAAAAzAw==",
  Confirm: "AAAAAQAAAAEAAABlAw==",
  Back: "AAAAAgAAAJcAAAAjAw==",
  Exit: "AAAAAQAAAAEAAABjAw==",
  Play: "AAAAAgAAAJcAAAAaAw==",
  Display: "AAAAAQAAAAEAAAA6Aw==",
  PowerOff: "AAAAAQAAAAEAAAAvAw==",
} as const;

export class Ircc {
  private readonly transport: BraviaTransport;

  constructor(transport: BraviaTransport) {
    this.transport = transport;
  }

  public sendCode(code: string): Promise<void> {
    const escapedCode = code.replace(/[&<>]/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        default:
          return "&gt;";
      }
    });

    return this.transport.postIrcc(`<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:X_SendIRCC xmlns:u="urn:schemas-sony-com:service:IRCC:1">
      <IRCCCode>${escapedCode}</IRCCCode>
    </u:X_SendIRCC>
  </s:Body>
</s:Envelope>`);
  }
}
