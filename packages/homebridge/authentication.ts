import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { Bravia, BraviaError } from "@hyjk2000/bravia-sdk";
import type { Logging } from "homebridge";
import type { TvConfig } from "./config.ts";

const MAX_BODY_BYTES = 1024;

function authenticationRequired(error: unknown): boolean {
  if (error instanceof BraviaError) {
    return error.id === 401 || error.id === 403;
  }
  if (typeof error !== "object" || error === null || !("response" in error)) {
    return false;
  }
  const response = error.response;
  return (
    typeof response === "object" &&
    response !== null &&
    "status" in response &&
    (response.status === 401 || response.status === 403)
  );
}

function respond(response: ServerResponse, status: number, body: string, html = false): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.writeHead(status, {
    "Content-Type": html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    Connection: "close",
  });
  response.end(body);
}

class FormError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  const { promise, resolve, reject } = Promise.withResolvers<URLSearchParams>();
  let size = 0;
  let complete = false;
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => {
    if (complete) {
      return;
    }
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      complete = true;
      chunks.length = 0;
      reject(new FormError(413, "Request body is too large.\n"));
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (!complete) {
      complete = true;
      resolve(new URLSearchParams(Buffer.concat(chunks, size).toString("utf8")));
    }
  });
  request.on("error", () => {
    if (!complete) {
      complete = true;
      reject(new FormError(400, "Could not read request.\n"));
    }
  });
  request.on("aborted", () => {
    if (!complete) {
      complete = true;
      reject(new FormError(400, "Request was interrupted.\n"));
    }
  });
  return promise;
}

interface PendingRegistration {
  client: Bravia;
  resolve: (client: Bravia) => void;
  reject: (error: Error) => void;
}

export interface AuthenticationOptions {
  config: TvConfig;
  baseUrl: string;
  cookie?: string;
  clientId: string;
  log: Logging;
}

/** A single TV's registration session; the HTTP server exists only while a PIN is needed. */
export class Authentication {
  private stopped = false;
  private server?: Server;
  private pending?: PendingRegistration;
  private submitting = false;
  private client?: Bravia;
  private readonly formToken = randomBytes(24).toString("base64url");

  private readonly options: AuthenticationOptions;

  constructor(options: AuthenticationOptions) {
    this.options = options;
  }

  async authenticate(): Promise<Bravia> {
    this.assertRunning();
    const { baseUrl, config, clientId } = this.options;
    const cookie = this.client?.cookie ?? this.options.cookie;
    let client = new Bravia({ baseUrl, cookie, psk: config.psk });
    this.client = client;
    if (cookie || config.psk) {
      try {
        await client.system.getPowerStatus();
        this.assertRunning();
        return client;
      } catch (error) {
        this.assertRunning();
        if (!authenticationRequired(error)) {
          throw error;
        }
      }
    }

    // Never reuse a rejected cookie or PSK for PIN-based registration.
    client = new Bravia({ baseUrl });
    this.client = client;
    const registeredCookie = await client.accessControl.actRegister({
      clientid: clientId,
      nickname: "Homebridge Bravia",
    });
    this.assertRunning();
    if (registeredCookie) {
      return client;
    }
    return this.waitForPin(client);
  }

  stop(): void {
    this.stopped = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(new Error("TV authentication stopped."));
    this.closeServer(true);
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("TV authentication stopped.");
    }
  }

  private waitForPin(client: Bravia): Promise<Bravia> {
    this.assertRunning();
    const { promise, resolve, reject } = Promise.withResolvers<Bravia>();
    this.pending = { client, resolve, reject };
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      void this.handleRequest(request, response).catch(() => {
        this.options.log.error("[%s] Could not handle the PIN request.", this.options.config.name);
        respond(response, 500, "Could not process request.\n");
      });
    });
    this.server = server;
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
    server.setTimeout(30_000, (socket) => socket.destroy());
    server.on("error", () => {
      const pending = this.pending;
      this.pending = undefined;
      this.options.log.error(
        "[%s] Could not listen for PIN registration.",
        this.options.config.name,
      );
      pending?.reject(new Error("Could not start the local PIN server."));
      this.closeServer(true);
    });
    try {
      server.listen(0, "0.0.0.0", () => {
        if (this.stopped) {
          this.closeServer(true);
          return;
        }
        const address = server.address() as AddressInfo;
        this.options.log.info(
          "[%s] Enter the PIN displayed by the TV at http://%s:%s/%s",
          this.options.config.name,
          hostname(),
          address.port,
          this.formToken,
        );
      });
    } catch {
      this.pending = undefined;
      this.closeServer(true);
      reject(new Error("Could not start the local PIN server."));
    }
    return promise;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.stopped || !this.pending) {
      respond(response, 503, "Registration is not available.\n");
      request.resume();
      return;
    }
    const origin = request.headers.origin;
    if (origin && origin !== `http://${request.headers.host}`) {
      respond(response, 403, "Invalid request origin.\n");
      request.resume();
      return;
    }
    const formPath = `/${this.formToken}`;
    if (request.method === "GET" && request.url === formPath) {
      respond(
        response,
        200,
        `<!doctype html><html lang="en"><meta charset="utf-8"><title>Pair BRAVIA TV</title><h1>Pair BRAVIA TV</h1><p>Enter the PIN displayed by your TV.</p><form method="post" action="${formPath}/pair"><label>PIN <input type="password" name="pin" inputmode="numeric" autocomplete="off" maxlength="16" required></label><button type="submit">Pair</button></form></html>`,
        true,
      );
      request.resume();
      return;
    }
    if (request.url !== `${formPath}/pair`) {
      respond(response, 404, "Not found.\n");
      request.resume();
      return;
    }
    if (request.method !== "POST") {
      respond(response, 405, "Use POST to submit the PIN.\n");
      request.resume();
      return;
    }
    if (
      request.headers["content-type"]?.split(";", 1)[0]?.trim() !==
      "application/x-www-form-urlencoded"
    ) {
      respond(response, 415, "Use the PIN form to submit a request.\n");
      request.resume();
      return;
    }
    let form: URLSearchParams;
    try {
      form = await readForm(request);
    } catch (error) {
      respond(
        response,
        error instanceof FormError ? error.status : 400,
        error instanceof FormError ? error.message : "Invalid request.\n",
      );
      request.resume();
      return;
    }
    const pin = form.get("pin");
    if (!pin || !/^\d{1,16}$/.test(pin)) {
      respond(response, 400, "Enter the numeric PIN displayed by the TV.\n");
      return;
    }
    if (this.submitting) {
      respond(response, 409, "A registration request is already in progress.\n");
      return;
    }
    const pending = this.pending;
    if (this.stopped || !pending) {
      respond(response, 503, "Registration is not available.\n");
      return;
    }
    this.submitting = true;
    try {
      const cookie = await pending.client.accessControl.actRegister({
        clientid: this.options.clientId,
        nickname: "Homebridge Bravia",
        pin,
      });
      if (this.stopped || this.pending !== pending) {
        respond(response, 503, "Registration has stopped.\n");
        return;
      }
      if (!cookie) {
        respond(response, 401, "The TV did not accept the PIN. Reload the form and try again.\n");
        return;
      }
      this.pending = undefined;
      respond(response, 200, "TV paired. You may close this page.\n");
      pending.resolve(pending.client);
      this.closeServer(false);
    } catch {
      this.options.log.warn(
        "[%s] TV registration failed; try submitting the PIN again.",
        this.options.config.name,
      );
      respond(response, 502, "TV registration failed. Reload the form and try again.\n");
    } finally {
      this.submitting = false;
    }
  }

  private closeServer(force: boolean): void {
    const server = this.server;
    if (!server) {
      return;
    }
    server.close(() => {
      if (this.server === server) {
        this.server = undefined;
      }
    });
    if (force) {
      server.closeAllConnections();
    }
  }
}
