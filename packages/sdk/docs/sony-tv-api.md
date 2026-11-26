# Sony BRAVIA SDK

## Usage

```ts
import { Bravia, IRCC_CODES } from "@hyjk2000/bravia-sdk";

const tv = new Bravia({
  baseUrl: "http://192.168.1.100:80",
  psk: "your-configured-pre-shared-key",
});

const {
  result: [power],
} = await tv.system.getPowerStatus();
if (power.status === "standby") {
  await tv.system.setPowerStatus({ status: true });
  // The caller decides when the TV is ready for content requests.
}
await tv.avContent.setPlayContent({ uri: "extInput:hdmi?port=1" });
await tv.audio.setAudioVolume({ target: "speaker", volume: "25" });
await tv.ircc.sendCode(IRCC_CODES.VolumeUp);
```

### PIN registration and persisted sessions

```ts
const tv = new Bravia({ baseUrl: "http://192.168.1.100" });
const controller = {
  clientid: "my-controller:stable-uuid",
  nickname: "My controller",
};

await tv.accessControl.actRegister(controller); // Initiate the on-screen PIN challenge.
// Obtain the PIN from the user, then:
const cookie = await tv.accessControl.actRegister({
  ...controller,
  pin: "1234",
});
// Persist cookie outside the SDK. Restore it in a later process:
const restored = new Bravia({
  baseUrl: "http://192.168.1.100",
  cookie: cookie ?? undefined,
});
```

`actRegister` sends identity plus a second, nested WOL-permission array. The PIN
is HTTP Basic authentication with an empty username and is sent only during
registration. It is not retained on subsequent requests. Only the `auth`
Set-Cookie value is retained, without attributes or unrelated cookies.
`tv.cookie` exposes the latest session cookie, including rotations received
outside registration. A successful registration can reuse an existing cookie.

The method returns the available cookie, or `null` for an HTTP/API 401 challenge
or a successful response without any session cookie. Other failures throw.
`null` alone therefore does not distinguish those two cases. The caller handles
PIN entry and credential storage. PSK authentication uses `X-Auth-PSK` on both
JSON and IRCC calls and does not require PIN registration.

## Domain modules and endpoint coverage

All JSON methods below use API version `1.0`. Object arguments retain Sony's
wire field names. Every JSON call is POST to `/sony/{service}` without a trailing
slash; `baseUrl` supplies the TV origin, including an optional port.

| Module / client property              | Methods                                           | Arguments / result contents                               |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| `system.ts` / `system`                | `getInterfaceInformation()`                       | `result: [InterfaceInformation]`                          |
|                                       | `getSystemInformation()`                          | `result: [SystemInformation]`                             |
|                                       | `getPowerStatus()`                                | `result: [{ status: "active" \| "standby" }]`             |
|                                       | `setPowerStatus({ status })`                      | Boolean status; `result: []`                              |
| `access-control.ts` / `accessControl` | `actRegister({ clientid, nickname, pin? })`       | Session cookie or `null`, as described above              |
| `av-content.ts` / `avContent`         | `getContentList({ source, stIdx?, cnt?, type? })` | `result: [ContentListItem[]]`; caller controls pagination |
|                                       | `getPlayingContentInfo()`                         | `result: [PlayingContentInfo]`                            |
|                                       | `setPlayContent({ uri })`                         | `result: []`                                              |
| `app-control.ts` / `appControl`       | `getApplicationList()`                            | `result: [Application[]]`; `icon` may be absent           |
|                                       | `setActiveApp({ uri })`                           | `result: []`                                              |
| `audio.ts` / `audio`                  | `getVolumeInformation()`                          | `result: [VolumeInformation[]]`                           |
|                                       | `setAudioMute({ status })`                        | Boolean, global mute; `result: [0]`                       |
|                                       | `setAudioVolume({ target, volume })`              | String volume; `result: [0]`                              |
| `ircc.ts` / `ircc`                    | `sendCode(code)`                                  | SOAP POST `/sony/IRCC`; `Promise<void>`                   |

JSON responses preserve the envelope `{ id, result }`. In particular, list
methods have a **nested** array: `result[0]` is the list, not its first item.
Request IDs are generated per client in Sony's valid range `1..2147483647`,
wrapping to 1. IDs distinguish requests, not methods or devices.

Audio information contains a target, numeric volume, mute boolean, and
`minVolume`/`maxVolume`. Select the output you need; do not assume the first
entry is the speaker. Volume commands are strings: `"25"` is absolute, `"+1"`
and `"-1"` are relative. Volume limits depend on the audio target and device.
Mute v1.0 does not accept a target.

Content and application URIs are opaque strings and are JSON-serialized without
manual concatenation. The legacy content-list method takes **`source`**, not the
`uri` field in Sony's newer v1.5 method. `stIdx` and `cnt` allow explicit paging;
the SDK does not automatically scan all pages or sources. Optional content
metadata varies by source and firmware.

## IRCC remote commands

IRCC is SOAP, not JSON. The SDK sends `text/xml; charset=UTF-8`, the quoted
`urn:schemas-sony-com:service:IRCC:1#X_SendIRCC` SOAPAction, and an XML-escaped
IRCCCode. XML and empty successful responses are accepted without JSON parsing.
HTTP failures, including SOAP faults delivered with HTTP 500, propagate.

`IRCC_CODES` provides named remote-control codes, including navigation,
playback, volume steps, and power-off. `Prev` is previous track; `FlashMinus` is
a separate command. `Play` is not a guaranteed play/pause toggle, and
`PowerOff` is discrete off rather than a power toggle. `sendCode` also accepts
device-specific codes.

## Errors and caller responsibilities

JSON API failures throw `BraviaError`. Its `id` is the **Sony error code**;
`requestId` is the response's correlation ID. `errorMessage` contains the TV's
diagnostic message.
Do not branch on message text. A successful `result` takes precedence over an
`error` member, as Sony specifies. HTTP, network, and JSON-parsing failures are
not converted into synthetic power, volume, or mute values. Commands are not
automatically retried, avoiding duplicated relative adjustments or key presses.

The caller manages cached state, polling, source filtering, and wake readiness.
Wake-on-LAN uses UDP, not a TV HTTP endpoint, and is not provided by the SDK.
A suspended TV may not expose its HTTP server at all. Availability of methods,
authentication modes, and remote codes depends on model and firmware.

## Contract sources and limits

Sony's documentation describes the underlying protocols:

- [Sony REST structure and specifications](https://pro-bravia.sony.net/remote-display-control/rest-api/structure/):
  service URLs, positive integer IDs, result/error arrays, and PSK authentication.
- [Sony API reference](https://pro-bravia.sony.net/remote-display-control/rest-api/reference/):
  system, application, audio, and AV contracts, including audio setter `[0]`
  results and string-valued volume adjustments.
- [Sony IRCC-IP reference](https://pro-bravia.sony.net/remote-display-control/ircc-ip/):
  SOAP transport, authentication, remote codes, and suspend/Wake-on-LAN limits.

Sony's current professional-display reference does not document `actRegister`
and now shows `getContentList` v1.5 rather than the v1.0 schema used by the SDK.
The following sources document these legacy consumer-TV contracts:

- [Independent PIN registration implementation (pybravia)](https://github.com/Drafteed/pybravia/blob/master/pybravia/client.py)
  and [PIN challenge example](https://stackoverflow.com/questions/57745785/how-to-authenticate-with-sony-bravia-tv-ip-control-without-preshared-key).
- [Historical consumer-TV v1.0 method/schema inventory](https://gist.github.com/kalleth/e10e8f3b8b7cb1bac21463b0073a65fb).

Optional tuner metadata is source-dependent, not a universal
professional-display guarantee.
