import * as http from "node:http";

const DEFAULT_FALLBACK_PORT = 3118;
const EPHEMERAL_PORT_MIN = 49152;
const EPHEMERAL_PORT_MAX = 65535;
const MAX_PORT_ATTEMPTS = 50;
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Find an available local port for the OAuth callback server.
 * Tries the preferred port first, then random ephemeral ports.
 */
export async function findAvailablePort(preferred?: number): Promise<number> {
  if (preferred != null) {
    const ok = await isPortAvailable(preferred);
    if (ok) return preferred;
  }

  for (let i = 0; i < MAX_PORT_ATTEMPTS; i++) {
    const port =
      EPHEMERAL_PORT_MIN +
      Math.floor(Math.random() * (EPHEMERAL_PORT_MAX - EPHEMERAL_PORT_MIN + 1));
    const ok = await isPortAvailable(port);
    if (ok) return port;
  }

  return DEFAULT_FALLBACK_PORT;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export interface OAuthCallbackResult {
  code: string;
  state?: string;
}

/**
 * Lightweight HTTP server on localhost that receives the OAuth redirect
 * callback. Validates the state parameter when expected and resolves
 * with the authorization code.
 */
export class OAuthCallbackServer {
  private server: http.Server | null = null;
  private port = 0;

  /**
   * Start listening on a local port and return a promise that resolves
   * when the authorization callback is received.
   */
  async start(options?: {
    expectedState?: string;
    callbackPort?: number;
    signal?: AbortSignal;
  }): Promise<{
    port: number;
    redirectUri: string;
    waitForCallback: () => Promise<OAuthCallbackResult>;
  }> {
    const port = await findAvailablePort(options?.callbackPort);
    this.port = port;
    const redirectUri = `http://localhost:${port}/callback`;

    const callbackPromise = new Promise<OAuthCallbackResult>(
      (resolve, reject) => {
        const server = http.createServer((req, res) => {
          if (!req.url?.startsWith("/callback")) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const parsed = new URL(req.url, `http://localhost:${port}`);
          const code = parsed.searchParams.get("code") ?? undefined;
          const state = parsed.searchParams.get("state") ?? undefined;
          const error = parsed.searchParams.get("error") ?? undefined;
          const errorDescription = parsed.searchParams.get("error_description") ?? undefined;

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(
              `<html><body><h1>Authorization Error</h1><p>${escapeHtml(error)}: ${escapeHtml(errorDescription ?? "")}</p></body></html>`,
            );
            cleanup();
            reject(new Error(`OAuth error: ${error} - ${errorDescription ?? ""}`));
            return;
          }

          if (!code) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(
              "<html><body><h1>Error</h1><p>Missing authorization code.</p></body></html>",
            );
            cleanup();
            reject(new Error("Missing authorization code in callback"));
            return;
          }

          if (options?.expectedState && state !== options.expectedState) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(
              "<html><body><h1>Error</h1><p>State parameter mismatch.</p></body></html>",
            );
            cleanup();
            reject(new Error("OAuth state mismatch"));
            return;
          }

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<html><body><h1>Authorization Successful</h1><p>You can close this window.</p></body></html>",
          );
          cleanup();
          resolve({ code, state });
        });

        this.server = server;

        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("OAuth callback timeout"));
        }, CALLBACK_TIMEOUT_MS);

        const cleanup = () => {
          clearTimeout(timeout);
          this.close();
        };

        if (options?.signal) {
          if (options.signal.aborted) {
            cleanup();
            reject(new Error("OAuth callback aborted"));
            return;
          }
          options.signal.addEventListener(
            "abort",
            () => {
              cleanup();
              reject(new Error("OAuth callback aborted"));
            },
            { once: true },
          );
        }

        server.listen(port, "127.0.0.1");
        server.unref();
      },
    );

    return { port, redirectUri, waitForCallback: () => callbackPromise };
  }

  close(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        // already closed
      }
      this.server = null;
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
