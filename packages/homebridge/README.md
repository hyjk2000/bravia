# Sony BRAVIA for Homebridge

Expose Sony BRAVIA televisions in Apple Home through `@hyjk2000/homebridge-bravia`. Supports power, volume, mute, input selection, application launching, and remote-control keys through the TV's local Sony APIs.

## Requirements

- Node.js 24 or later and Homebridge 1.8.0 or later, within the package's declared peer dependency range.
- A Sony BRAVIA TV with Sony JSON-RPC and IRCC IP control support. Available inputs, applications, and commands depend on the model and firmware; not every BRAVIA model is supported.
- LAN connectivity from Homebridge to the TV. Enable IP/remote control and network standby (sometimes called Remote Start) in the TV settings. A DHCP reservation is recommended.

## Installation and setup

1. Search for `@hyjk2000/homebridge-bravia` in the Homebridge UI Plugins tab and install it. Alternatively, install it in your Homebridge environment with `npm install -g @hyjk2000/homebridge-bravia`.
2. Open the plugin settings and add each TV with a unique name and its IP address or hostname. Enter only the address, not a URL or port; use the separate `port` setting if needed.
3. Turn the TV on, save the settings, and restart Homebridge or the plugin's child bridge.
4. Authenticate using one of the methods below.
5. In Apple Home, choose **Add Accessory → More Options**, select each TV, and enter the pairing code for the Homebridge instance or child bridge running the plugin. TVs are published as separate external accessories by default; pairing Homebridge alone does not add them.

### TV authentication

**Pre-shared key:** Enable pre-shared-key authentication in the TV's IP control settings, choose a key, and enter the same value in the plugin's `psk` field.

**PIN pairing:** Leave `psk` blank. After restarting, open the full local URL printed in the Homebridge logs and enter the PIN displayed on the TV into that page. No terminal input is required. Saved sessions and valid pre-shared keys skip this step.

The temporary PIN page listens on an automatically selected free port on the Homebridge host and closes after pairing. Your browser must be able to reach that host and port. If the logged hostname cannot be resolved, replace only the hostname with the Homebridge host's LAN IP, keeping the port and full path. In Docker, host networking lets the browser reach the dynamically allocated pairing port.

Use PIN pairing only on a trusted LAN. Do not expose the PIN server to the internet or share its capability URL. TV control and the pairing page use local HTTP, not HTTPS.

## Configuration

The Homebridge UI provides a settings form. For manual configuration, add this entry to the `platforms` array in Homebridge's `config.json`:

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

Each `tvs` entry supports these options. All intervals and delays are in milliseconds.

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

When `sources` is omitted, the plugin scans `extInput:hdmi`, `extInput:component`, `extInput:scart`, `extInput:cec`, and `extInput:widi`. Set `sources: []` to disable those categories. Set `applications: []` or omit it to expose no apps. At most 95 inputs and applications are exposed per TV.

Input identifiers, HomeKit input names, and visibility are preserved across rescans. Accessory identity uses the configured MAC when present, otherwise the host address. Keep these identity fields stable; adding or changing a MAC, or changing the host without a configured MAC, changes accessory identity.

## Troubleshooting

- **No PIN or pairing page:** Turn the TV on, check its IP control/authentication settings, and restart the plugin. Use the full URL from the latest logs; its path changes when the plugin restarts. Check firewall and container port access.
- **TV will not wake:** Enable network standby/Remote Start. Configure `mac` for Wake-on-LAN and check that `woladdress` reaches the TV's network. Increase `starttimeout` if commands arrive before the TV is ready.
- **TV missing from Apple Home:** Add each external TV separately using the Homebridge or child bridge pairing code. Check that mDNS discovery works between your Apple device and Homebridge.
- **Missing inputs or apps:** Turn the TV on and check `sources`, `tvsource`, and application title filters. Unsupported Sony source categories are skipped. Discovery depends on the model and firmware.
- **Connection failures:** Check the TV address, HTTP port, credentials, and LAN reachability. Cached services are restored when the TV is offline; initialization is retried while Homebridge is running.

When reporting an issue, include the plugin, Homebridge, and Node.js versions, TV model/firmware, sanitized configuration, and relevant logs. Remove pre-shared keys, cookies, PINs, and pairing URLs before sharing.

## Storage

Sessions and external-accessory state are stored under `<Homebridge storage>/plugin-persist/hyjk2000-homebridge-bravia/<uuid>.json`, outside the plugin installation. Treat these files and Homebridge backups as credentials. Pre-shared keys remain in your Homebridge configuration.

## Development and publishing

From the repository root, use Node.js 24 and the pinned pnpm version. Run `pnpm install`, then `pnpm build` before plugin tests. Use `pnpm --filter @hyjk2000/homebridge-bravia test` for plugin tests and `pnpm --filter @hyjk2000/homebridge-bravia dev` to watch and rebuild the plugin.

Releases are generated by semantic-release on `master`. The release workflow derives repository, README, and issue URLs from the GitHub repository; local package metadata intentionally does not guess these URLs before an origin is configured.

Authoring references: [official plugin template](https://github.com/homebridge/homebridge-plugin-template) and [Homebridge verification requirements](https://github.com/homebridge/plugins/wiki/Verified-Plugins#current-requirements). This plugin is not claimed to be Homebridge Verified. Its Node.js 24 minimum excludes Node.js 22, which is currently required by the verification program.

## License

MIT.
