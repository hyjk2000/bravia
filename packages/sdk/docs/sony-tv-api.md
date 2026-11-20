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
`null` alone therefore does not distinguish those two cases. The SDK does not
create a PIN-entry server or write credentials to disk. PSK authentication uses
`X-Auth-PSK` on both JSON and IRCC calls and does not require PIN registration.

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
wrapping to 1. IDs distinguish requests, not methods or devices; no plugin
hard-coded IDs are copied.

Audio information contains a target, numeric volume, mute boolean, and
`minVolume`/`maxVolume`. Select the output you need; do not assume the first
entry is the speaker. Volume commands are strings: `"25"` is absolute, `"+1"`
and `"-1"` are relative. The SDK does not impose an invented model-independent
volume range. Mute v1.0 does not accept a target.

Content and application URIs are opaque strings and are JSON-serialized without
manual concatenation. The legacy content-list method takes **`source`**, not the
`uri` field in Sony's newer v1.5 method. `stIdx` and `cnt` allow explicit paging;
the SDK does not automatically scan all pages or sources. Optional content
metadata varies by source and firmware.

## IRCC and plugin corrections

IRCC is SOAP, not JSON. The SDK sends `text/xml; charset=UTF-8`, the quoted
`urn:schemas-sony-com:service:IRCC:1#X_SendIRCC` SOAPAction, and an XML-escaped
IRCCCode. XML and empty successful responses are accepted without JSON parsing.
HTTP failures, including SOAP faults delivered with HTTP 500, propagate.

`IRCC_CODES` covers all plugin remote-key, volume-step, and power-off commands.
Names follow the actual commands: the plugin's “previous track” code is
`FlashMinus`; the actual previous-track code is `Prev`. The plugin's
“play/pause” code is `Play`, not a guaranteed toggle. `PowerOff` is discrete
off rather than a power toggle. `sendCode` also accepts device-specific codes.

## Errors and caller responsibilities

JSON API failures throw `BraviaError`. Its `id` is the **Sony error code**
(retaining the SDK's existing error-property convention); `requestId` is the
response's correlation ID. `errorMessage` contains the TV's diagnostic message.
Do not branch on message text. A successful `result` takes precedence over an
`error` member, as Sony specifies. HTTP, network, and JSON-parsing failures are
not converted into synthetic power, volume, or mute values. Commands are not
automatically retried, avoiding duplicated relative adjustments or key presses.

The SDK deliberately does not copy the plugin's cached state, automatic power-on
delays, polling timers, source filtering, HomeKit mapping, or compatibility-mode
proxy destination. Wake-on-LAN uses UDP, not a TV HTTP endpoint, and belongs to
the caller. A suspended TV may not expose its HTTP server at all. Availability
of methods, authentication modes, and remote codes depends on model/firmware.

## Integration sequences

Use Node 24 and pnpm. From the repository root, run `pnpm build` first so
workspace package exports exist, then `pnpm --filter @hyjk2000/bravia-sdk test`.
Both packages have a `typecheck` script; root `pnpm typecheck` (or `pnpm check`)
checks both with TypeScript's `noEmit`. Tests use Vitest's `expect` assertions.
`tests/integration.test.ts` calls the real SDK against
`tests/mock-tv.ts`, a stateful MSW API. Setters change the state observed by later
reads. Tests use MSW 2's `msw/node` adapter and distinct TV origins to isolate
MSW's cookie store.

The explicit sequences mirror the reference plugin's code paths:

- `start` / `checkRegistration` / `receiveNextSources`: public interface probe →
  PIN challenge → incorrect PIN → correct PIN → private system metadata →
  configured external-input and tuner sources → application discovery.
- `setActiveIdentifier` / `pollPlayContent`: restore cookie → standby → explicit
  power-on → HDMI selection/readback → app launch → AV-info error → tuner
  selection/readback → power-off → standby and AV-info error.
- `receiveSource`: explicitly fetch successive content pages and the empty end
  page, rather than assuming the plugin's first-page scan is complete.
- Speaker and remote callbacks: read both outputs → absolute speaker volume →
  relative headphone adjustments → global mute/unmute → IRCC volume steps and
  navigation → discrete IRCC power-off → standby readback.
- Failure paths: API codes versus correlation IDs, invalid selection without
  state mutation, forbidden access, non-retried HTTP failures, JSON PIN
  challenges, and empty SOAP success responses.

These are mock integrations, not proof of compatibility with a physical TV.

## Contract sources and limits

Prefer Sony's documentation over plugin implementation details:

- [Sony REST structure and specifications](https://pro-bravia.sony.net/remote-display-control/rest-api/structure/):
  service URLs, positive integer IDs, result/error arrays, and PSK authentication.
- [Sony API reference](https://pro-bravia.sony.net/remote-display-control/rest-api/reference/):
  system, application, audio, and AV contracts, including audio setter `[0]`
  results and string-valued volume adjustments.
- [Sony IRCC-IP reference](https://pro-bravia.sony.net/remote-display-control/ircc-ip/):
  SOAP transport, authentication, remote codes, and suspend/Wake-on-LAN limits.

Sony's current professional-display reference does not document `actRegister`
and now shows `getContentList` v1.5, not the plugin's v1.0 schema. Those legacy
contracts are corroborated, not established by that modern reference:

- [Independent PIN registration implementation (pybravia)](https://github.com/Drafteed/pybravia/blob/master/pybravia/client.py)
  and [PIN challenge example](https://stackoverflow.com/questions/57745785/how-to-authenticate-with-sony-bravia-tv-ip-control-without-preshared-key).
- [Historical consumer-TV v1.0 method/schema inventory](https://gist.github.com/kalleth/e10e8f3b8b7cb1bac21463b0073a65fb),
  plus the reference plugin's actual calls. Optional tuner metadata is
  source-dependent, not a universal professional-display guarantee.
