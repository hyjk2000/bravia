# Sony BRAVIA for Homebridge

Control Sony BRAVIA TVs in Apple Home: power, volume, mute, inputs, apps, and remote keys.

## Requirements

- Node.js 24+ and Homebridge 1.8.0+ within the declared peer dependency range.
- A LAN-accessible BRAVIA TV with JSON-RPC and IRCC IP control enabled. Support varies by model and firmware.
- Network standby/Remote Start enabled for wake support. A DHCP reservation is recommended.

## Installation and setup

1. Install `@hyjk2000/homebridge-bravia` from the Homebridge UI.
2. Add each TV in the plugin settings with a unique name and IP address or hostname. Use `port` separately if needed.
3. Turn the TV on, save, restart the bridge, and authenticate below.
4. In Apple Home, choose **Add Accessory → More Options** and pair each TV using the bridge's pairing code. TVs are separate accessories by default.

### TV authentication

**Pre-shared key:** Set a key in the TV's IP control settings and enter it as `psk`.

**PIN:** Leave `psk` blank. Open the full URL in the Homebridge logs and enter the PIN shown on the TV. Saved sessions skip pairing.

The temporary pairing page uses a dynamic port on the Homebridge host. If needed, replace only the URL's hostname with the host's LAN IP; preserve the port and path. Docker host networking allows access to this port.

Pair only on a trusted LAN: TV control and PIN entry use HTTP. Never expose the pairing server publicly or share its URL.

## Configuration

Use the plugin settings, or add this to `platforms` in Homebridge's `config.json`:

```json
{
  "platform": "BraviaPlatform",
  "name": "BraviaPlatform",
  "tvs": [
    {
      "name": "Living Room TV",
      "ip": "192.168.1.50"
    }
  ]
}
```

Options per TV; times are in milliseconds.

| Option              | Default           | Description                                                                                                    |
| ------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `name`              | Required          | Unique TV display name.                                                                                        |
| `ip`                | Required          | Unique TV IP address or hostname, without scheme, port, credentials, or path.                                  |
| `port`              | `80`              | TV HTTP port, from 1 to 65535.                                                                                 |
| `psk`               | Unset             | TV pre-shared key; omit or leave blank for PIN authentication.                                                 |
| `mac`               | Unset             | MAC address with colon- or hyphen-separated octets; enables Wake-on-LAN.                                       |
| `woladdress`        | `255.255.255.255` | Wake-on-LAN destination; use a reachable subnet broadcast address if necessary.                                |
| `soundoutput`       | `speaker`         | Sony audio output target for volume control.                                                                   |
| `updaterate`        | `5000`            | Positive status polling interval.                                                                              |
| `channelupdaterate` | `30000`           | Input/application refresh interval; `0` disables periodic refresh.                                             |
| `starttimeout`      | `5000`            | Positive delay for the TV to wake before sending commands.                                                     |
| `sources`           | See below         | Source categories to expose, as objects such as `{ "source": "extInput:hdmi" }`.                               |
| `tvsource`          | Unset             | Additional Sony source category to discover, including when `sources` is empty.                                |
| `applications`      | None              | App title filters, as objects such as `{ "title": "YouTube" }`; matching is case-sensitive substring matching. |
| `externalaccessory` | `true`            | Publish each TV separately. Set `false` to publish through the bridge instead.                                 |
| `debug`             | `false`           | Log TV command and refresh errors at info level; otherwise these use Homebridge debug logging.                 |

Default sources: `extInput:hdmi`, `extInput:component`, `extInput:scart`, `extInput:cec`, and `extInput:widi`. Use `sources: []` to disable them. Apps are opt-in. Each TV supports up to 95 inputs/apps combined.

Input IDs, names, and visibility survive rescans. Keep `mac` (or the host address when no MAC is set) stable to preserve accessory identity.

## Troubleshooting

- **Pairing page unavailable:** Turn the TV on, check IP control settings, and use the latest log URL. Check firewall/container access.
- **Will not wake:** Enable Remote Start, check `mac`/`woladdress`, and increase `starttimeout` if commands arrive too early.
- **Missing TV:** Pair it separately and check mDNS connectivity.
- **Missing inputs/apps:** Turn the TV on and check `sources`, `tvsource`, and case-sensitive app filters. Availability varies by firmware.
- **Connection failures:** Check address, port, credentials, and LAN access. Offline TVs retain cached services; initialization retries automatically.

Report issues with versions, TV model/firmware, sanitized config, and logs. Remove keys, cookies, PINs, and pairing URLs.

## Storage

Sessions and accessory state live in `<Homebridge storage>/plugin-persist/hyjk2000-homebridge-bravia/<uuid>.json`. Protect these files and backups as credentials. Pre-shared keys remain in Homebridge's config.

## Development

See the [monorepo README](../../README.md) for setup. Build before running
`pnpm --filter @hyjk2000/homebridge-bravia test`; use `pnpm dev` to watch and rebuild.

## License

MIT.
