# Repository Guidelines

## Project Overview

Sony BRAVIA TypeScript SDK and Homebridge television plugin.

## Architecture & Data Flow

Homebridge platform → authentication → shared SDK transport → Sony JSON-RPC/SOAP; `Television` maps responses into HomeKit state. Persistence, polling, pagination, and wake readiness belong to the plugin, not the SDK. Restore cached accessories before network initialization so offline TVs retain their services.

## Key Directories

- `packages/sdk/`: tsdown-built ESM SDK with bundled declarations in `dist/`. Protocol reference: `docs/sony-tv-api.md`.
- `packages/homebridge/`: Node-targeted plugin. Private credentials/external-accessory state live outside the repo at `<Homebridge storage>/plugin-persist/hyjk2000-homebridge-bravia/<uuid>.json`.

## Development Commands

Run from the repository root:

```sh
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @hyjk2000/homebridge-bravia test
pnpm --filter @hyjk2000/bravia-sdk test
pnpm lint
pnpm fmt
```

Build before running plugin tests or the SDK REPL so workspace package exports exist. Use `pnpm --filter @hyjk2000/homebridge-bravia dev` for plugin development and `pnpm --filter @hyjk2000/bravia-sdk repl` for the SDK REPL.

## Code Conventions & Common Patterns

- Preserve Sony response envelopes: lists are `result[0]`. `BraviaError.id` is the Sony error code; `requestId` is correlation. Never add automatic command retries: relative volume/key presses are not idempotent.
- Input identity is URI-based, not name-based. Preserve identifiers, user names, and visibility across rescans; never recycle identifiers. Delete cached inputs only after a complete successful scan of their group.
- Invalid TV configuration must not trigger obsolete-accessory cleanup. Stable accessory identity uses MAC, otherwise host—not display name or port.
- Use injected `api.hap` constants/errors, not ambient enum values. Polling uses completion-based timeouts; wake delays share one promise. Preserve cancellation on shutdown.
- Type-aware Oxlint rejects floating/misused promises and warnings; retain automatic config discovery.

## Important Files

`packages/homebridge/hap.ts` prevents enum inlining with `verbatimModuleSyntax`. `platform.ts` owns persistence/lifecycle; `television.ts` owns input reconciliation and HomeKit state. `authentication.ts` owns the temporary LAN PIN server; preserve its capability URL, origin checks, limits, and shutdown behavior.

## Runtime/Tooling Preferences

Use **Node 24** and **pnpm** (pinned in `mise.toml`; pnpm also in `packageManager`). TypeScript only typechecks (`noEmit`); tsdown builds the ESM packages and SDK declarations. Local source imports retain `.ts` extensions; the SDK REPL loads its built package. Homebridge ≥1.8.0 is required; tsdown targets Node 24 and leaves runtime and peer dependencies external. The plugin declares the SDK as a runtime dependency; package managers install the SDK and its runtime dependencies transitively.

## Testing & QA

Both packages use Vitest's `expect` assertions. SDK tests use `msw/node`; plugin tests use real Homebridge HAP. SDK mocks use unique origins to isolate cookies. Preserve stateful protocol and persistence assertions; no coverage threshold is configured.

## Publishing

Both packages use `prepack` to build public npm artifacts; the SDK must be built before the plugin. `pnpm build` builds in workspace dependency order. Each package has a `typecheck` script; root `pnpm typecheck` runs both and `pnpm check` is its alias.

1. For publishable changes, run `pnpm changeset` and commit the generated file with the code. Land the commits locally on `master` and push `master` directly; do not open a code PR for this release flow.
2. Let `.github/workflows/release.yml` verify the push and let Changesets open or update the **Version Packages** PR. Changesets owns the version bumps, changelog entries, and removal of consumed changesets. The plugin's `workspace:*` SDK dependency propagates SDK bumps.
3. Review and merge the generated version PR to trigger trusted publishing. Confirm the release workflow succeeded and npm serves the new version's tarball. Do not publish manually or assume a missing tarball means the release is staged.

Allow GitHub Actions to create pull requests and configure npm trusted publishers for both packages using `release.yml`. No npm token, Changesets bot, or changeset enforcement is configured.
