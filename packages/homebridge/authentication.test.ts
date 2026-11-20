import { expect, test } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { format } from "node:util";
import type { Logging } from "homebridge";
import { Authentication } from "./authentication.ts";

test("concurrent PIN sessions use reachable free ports and preserve pairing and shutdown", async () => {
  const tv = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const { id } = JSON.parse(body) as { id: number };
      if (request.headers.authorization !== `Basic ${btoa(":1234")}`) {
        response.writeHead(401);
        response.end();
        return;
      }
      response.setHeader("Set-Cookie", "auth=paired; Path=/");
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id, result: [] }));
    });
  });
  tv.listen(0, "127.0.0.1");
  await once(tv, "listening");
  const address = tv.address() as AddressInfo;
  const start = (name: string) => {
    const page = Promise.withResolvers<URL>();
    const quiet = () => {};
    const log: Logging = Object.assign(quiet, {
      prefix: "test",
      info: (...args: unknown[]) => {
        const match = format(...args).match(/http:\/\/\S+/);
        if (match) {
          const url = new URL(match[0]);
          url.hostname = "127.0.0.1";
          page.resolve(url);
        }
      },
      success: quiet,
      warn: quiet,
      error: quiet,
      debug: quiet,
      log: quiet,
    });
    const authentication = new Authentication({
      config: { name, ip: "127.0.0.1" },
      baseUrl: `http://127.0.0.1:${address.port}`,
      clientId: name,
      log,
    });
    const result = authentication.authenticate();
    const ready = Promise.race([
      page.promise,
      result.then(() => {
        throw new Error("Expected a PIN challenge");
      }),
    ]);
    return { authentication, result, ready };
  };
  const first = start("First TV");
  const second = start("Second TV");
  try {
    const [firstUrl, secondUrl] = await Promise.all([first.ready, second.ready]);
    expect(firstUrl.port).not.toBe(secondUrl.port);
    for (const url of [firstUrl, secondUrl]) {
      const page = await fetch(url);
      expect(page.status).toBe(200);
      await page.text();
    }
    const pairUrl = new URL(`${firstUrl.pathname}/pair`, firstUrl);
    const rejected = await fetch(pairUrl, {
      method: "POST",
      headers: { Origin: "http://untrusted.invalid" },
      body: new URLSearchParams({ pin: "1234" }),
    });
    expect(rejected.status).toBe(403);
    await rejected.text();
    const paired = await fetch(pairUrl, {
      method: "POST",
      headers: { Origin: firstUrl.origin },
      body: new URLSearchParams({ pin: "1234" }),
    });
    expect(paired.status).toBe(200);
    await paired.text();
    expect((await first.result).cookie).toContain("auth=paired");
    const cancelled = expect(second.result).rejects.toThrow("TV authentication stopped.");
    second.authentication.stop();
    await cancelled;
    await expect(fetch(secondUrl)).rejects.toThrow();
  } finally {
    first.authentication.stop();
    second.authentication.stop();
    await Promise.allSettled([first.result, second.result]);
    tv.closeAllConnections();
    tv.close();
    await once(tv, "close");
  }
});
