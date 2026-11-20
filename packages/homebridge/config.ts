import { isIP } from "node:net";
import type { Logging, PlatformConfig } from "homebridge";

export interface TvConfig {
  name: string;
  ip: string;
  port?: number | string;
  mac?: string;
  woladdress?: string;
  tvsource?: string;
  soundoutput?: string;
  updaterate?: number;
  channelupdaterate?: number;
  starttimeout?: number;
  sources?: { source: string }[];
  applications?: { title: string }[];
  psk?: string;
  externalaccessory?: boolean;
  debug?: boolean;
}

export interface BraviaPlatformConfig extends PlatformConfig {
  tvs?: TvConfig[];
}

function isHost(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 253) return false;
  if (isIP(value)) return true;
  return value.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

function isPort(value: unknown): boolean {
  return (
    (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) &&
    Number.isInteger(Number(value)) &&
    Number(value) >= 1 &&
    Number(value) <= 65535
  );
}

export function parseConfig(config: BraviaPlatformConfig | undefined, log: Logging): TvConfig[] {
  if (!config) return [];
  if (config.compatibilitymode === true) {
    log.error(
      "compatibilitymode is unsupported: the legacy implementation sent authentication to an unrelated public host. Remove it and use local TV authentication.",
    );
    return [];
  }
  if (config.tvs === undefined) return [];
  if (!Array.isArray(config.tvs)) {
    log.error("BraviaPlatform: tvs must be an array.");
    return [];
  }
  const candidates: { tv: TvConfig; index: number; keys: string[] }[] = [];
  const counts = new Map<string, number>();
  for (const [index, entry] of config.tvs.entries()) {
    const errors: string[] = [];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      log.error(`BraviaPlatform: TV ${index + 1} must be an object.`);
      continue;
    }
    const raw = entry as unknown as Record<string, unknown>;
    if (raw.compatibilitymode === true)
      errors.push(
        "compatibilitymode is unsafe and unsupported: legacy authentication was sent to an unrelated public host; remove it",
      );
    if (typeof raw.name !== "string" || !raw.name.trim())
      errors.push("name must be a nonempty string");
    if (!isHost(raw.ip))
      errors.push(
        "ip must be an IP address or hostname, without a URL scheme, path, port, or credentials",
      );
    if (raw.port !== undefined && !isPort(raw.port))
      errors.push("port must be an integer from 1 to 65535");
    if (
      raw.mac !== undefined &&
      (typeof raw.mac !== "string" ||
        !/^(?:[\da-f]{2}:){5}[\da-f]{2}$|^(?:[\da-f]{2}-){5}[\da-f]{2}$/i.test(raw.mac))
    )
      errors.push("mac must contain six colon- or hyphen-separated hexadecimal octets");
    if (raw.woladdress !== undefined && !isHost(raw.woladdress))
      errors.push("woladdress must be an IP address or hostname");
    for (const field of ["updaterate", "channelupdaterate", "starttimeout"] as const) {
      const value = raw[field];
      if (
        value !== undefined &&
        (typeof value !== "number" ||
          !Number.isFinite(value) ||
          (field === "channelupdaterate" ? value < 0 : value <= 0))
      )
        errors.push(
          `${field} must be ${field === "channelupdaterate" ? "nonnegative (0 disables polling)" : "positive"}`,
        );
    }
    for (const field of ["tvsource", "soundoutput", "psk"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "string")
        errors.push(`${field} must be a string`);
    }
    for (const field of ["externalaccessory", "debug"] as const) {
      if (raw[field] !== undefined && typeof raw[field] !== "boolean")
        errors.push(`${field} must be a boolean`);
    }
    if (
      raw.sources !== undefined &&
      (!Array.isArray(raw.sources) ||
        !raw.sources.every(
          (value) =>
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value.source === "string" &&
            value.source.trim(),
        ))
    )
      errors.push("sources must be a list of objects with nonempty source categories");
    if (
      raw.applications !== undefined &&
      (!Array.isArray(raw.applications) ||
        !raw.applications.every(
          (value) =>
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value.title === "string" &&
            value.title.trim(),
        ))
    )
      errors.push("applications must be a list of objects with nonempty titles");
    if (errors.length) {
      log.error(`BraviaPlatform: TV ${index + 1} is invalid: ${errors.join("; ")}.`);
      continue;
    }
    const tv: TvConfig = {
      ...entry,
      name: entry.name.trim(),
      externalaccessory: entry.externalaccessory ?? true,
    };
    const keys = [`name:${tv.name.toLowerCase()}`, `host:${tv.ip.toLowerCase()}`];
    if (tv.mac) keys.push(`mac:${tv.mac.replace(/[:-]/g, "").toLowerCase()}`);
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    candidates.push({ tv, index, keys });
  }
  return candidates
    .filter(({ index, keys }) => {
      const duplicates = keys.filter((key) => counts.get(key)! > 1);
      if (!duplicates.length) return true;
      log.error(
        `BraviaPlatform: TV ${index + 1} has a duplicate name or device identity; every colliding entry is skipped.`,
      );
      return false;
    })
    .map(({ tv }) => tv);
}
