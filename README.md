# bravia

TypeScript tools for controlling Sony BRAVIA televisions through [JSON-RPC](https://www.jsonrpc.org)-compliant [REST API](https://pro-bravia.sony.net/remote-display-control/rest-api/) and [IRCC-IP](https://pro-bravia.sony.net/remote-display-control/ircc-ip/).

## Packages

- [SDK](packages/sdk/README.md) — `@hyjk2000/bravia-sdk`, Sony REST API and IRCC-IP client.
- [Homebridge plugin](packages/homebridge/README.md) — `@hyjk2000/homebridge-bravia`, exposing TVs in Apple Home.

## Development

Use Node.js 24 and pnpm 12.12.0 (pinned in `mise.toml`). From the repository root:

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm fmt:check
```

Build before running plugin tests or the SDK REPL. Use `pnpm dev` for plugin development and `pnpm repl` for the SDK REPL.

## License

[MIT](LICENSE).
