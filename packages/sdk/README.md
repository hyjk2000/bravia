# Sony BRAVIA SDK

TypeScript client for Sony BRAVIA JSON-RPC and IRCC-IP APIs.

Requires Node.js 24+ and a network-accessible BRAVIA TV with IP control enabled.
Supported APIs vary by model and firmware.

## Installation

```sh
pnpm install @hyjk2000/bravia-sdk
```

## Usage

Enable pre-shared-key authentication on the TV and set `BRAVIA_PSK` to its key:

```ts
import { Bravia } from "@hyjk2000/bravia-sdk";

const tv = new Bravia({
  baseUrl: "http://192.168.1.50:80",
  psk: process.env.BRAVIA_PSK,
  timeoutMs: 10_000, // Optional request deadline; defaults to 10 seconds.
});

const { result } = await tv.system.getPowerStatus();
console.log(result[0].status); // "active" or "standby"

await tv.system.setPowerStatus({ status: true });
```

## Authentication

Pass a pre-shared key as `psk` or a saved session cookie as `cookie`.

For [PIN pairing](docs/sony-tv-api.md#pin-registration-and-persisted-sessions),
call `tv.accessControl.actRegister` first with `{ clientid, nickname }`, then
with the same identity and the displayed `pin`. Save the returned cookie
securely; `null` does not confirm success. Reuse a stable `clientid`.

## API

See the [API reference](docs/sony-tv-api.md) for methods, response formats, and
remote-control codes. The caller manages polling, persistence, and wake readiness.

## Errors

`BraviaError.id` is the Sony error code; `requestId` is the request correlation
ID. HTTP and network errors propagate separately.

Requests use native `fetch` with a configurable `timeoutMs` deadline (10 seconds
by default), including JSON response body reads, and no automatic retries.
HTTP errors expose `response.status`; an aborted request may already have been
executed by the TV.

## Development

See the [monorepo README](../../README.md) for setup. From the repository root,
run SDK tests with `pnpm --filter @hyjk2000/bravia-sdk test`, or build and run
`pnpm repl` for an interactive client.

## License

MIT.
