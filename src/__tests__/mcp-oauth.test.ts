import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { InMemoryTokenStorage, FileTokenStorage } from "../mcp/auth/storage.js";
import { NoumenOAuthProvider } from "../mcp/auth/provider.js";
import {
  findAvailablePort,
  OAuthCallbackServer,
} from "../mcp/auth/callback-server.js";
import type { OAuthTokenData } from "../mcp/auth/types.js";

// ---------------------------------------------------------------------------
// InMemoryTokenStorage
// ---------------------------------------------------------------------------

describe("InMemoryTokenStorage", () => {
  let storage: InMemoryTokenStorage;

  beforeEach(() => {
    storage = new InMemoryTokenStorage();
  });

  it("returns undefined for unknown keys", async () => {
    expect(await storage.load("unknown")).toBeUndefined();
  });

  it("saves and loads data", async () => {
    const data: OAuthTokenData = {
      tokens: {
        access_token: "abc",
        token_type: "Bearer",
      },
      expiresAt: Date.now() + 3600_000,
    };

    await storage.save("server1", data);
    const loaded = await storage.load("server1");
    expect(loaded).toEqual(data);
  });

  it("overwrites existing data", async () => {
    await storage.save("s", { tokens: { access_token: "a", token_type: "Bearer" } });
    await storage.save("s", { tokens: { access_token: "b", token_type: "Bearer" } });
    const loaded = await storage.load("s");
    expect(loaded?.tokens?.access_token).toBe("b");
  });

  it("deletes data", async () => {
    await storage.save("s", { tokens: { access_token: "a", token_type: "Bearer" } });
    await storage.delete("s");
    expect(await storage.load("s")).toBeUndefined();
  });

  it("delete on unknown key is a no-op", async () => {
    await expect(storage.delete("nope")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// FileTokenStorage
// ---------------------------------------------------------------------------

describe("FileTokenStorage", () => {
  let tmpDir: string;
  let storage: FileTokenStorage;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "noumen-oauth-test-"));
    storage = new FileTokenStorage(path.join(tmpDir, "tokens.json"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns undefined when file does not exist", async () => {
    expect(await storage.load("key")).toBeUndefined();
  });

  it("saves and loads data", async () => {
    const data: OAuthTokenData = {
      tokens: { access_token: "tok", token_type: "Bearer" },
    };
    await storage.save("key", data);
    const loaded = await storage.load("key");
    expect(loaded?.tokens?.access_token).toBe("tok");
  });

  it("persists multiple keys independently", async () => {
    await storage.save("a", { tokens: { access_token: "1", token_type: "Bearer" } });
    await storage.save("b", { tokens: { access_token: "2", token_type: "Bearer" } });
    expect((await storage.load("a"))?.tokens?.access_token).toBe("1");
    expect((await storage.load("b"))?.tokens?.access_token).toBe("2");
  });

  it("deletes a key without affecting others", async () => {
    await storage.save("a", { tokens: { access_token: "1", token_type: "Bearer" } });
    await storage.save("b", { tokens: { access_token: "2", token_type: "Bearer" } });
    await storage.delete("a");
    expect(await storage.load("a")).toBeUndefined();
    expect((await storage.load("b"))?.tokens?.access_token).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// NoumenOAuthProvider
// ---------------------------------------------------------------------------

describe("NoumenOAuthProvider", () => {
  let storage: InMemoryTokenStorage;
  let provider: NoumenOAuthProvider;

  beforeEach(() => {
    storage = new InMemoryTokenStorage();
    provider = new NoumenOAuthProvider("test-server|http://example.com", {
      storage,
      callbackPort: 9999,
      clientMetadata: {
        redirect_uris: ["http://localhost:9999/callback"],
        client_name: "test-client",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    });
  });

  it("has correct redirectUrl", () => {
    expect(provider.redirectUrl).toBe("http://localhost:9999/callback");
  });

  it("returns client metadata", () => {
    expect(provider.clientMetadata.client_name).toBe("test-client");
  });

  it("generates random state strings", async () => {
    const s1 = await provider.state();
    const s2 = await provider.state();
    expect(s1).toHaveLength(32);
    expect(s1).not.toBe(s2);
  });

  it("saves and loads tokens", async () => {
    expect(await provider.tokens()).toBeUndefined();

    await provider.saveTokens({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt",
    });

    const tokens = await provider.tokens();
    expect(tokens?.access_token).toBe("at");
    expect(tokens?.refresh_token).toBe("rt");
  });

  it("computes expiresAt from expires_in", async () => {
    const before = Date.now();
    await provider.saveTokens({
      access_token: "at",
      token_type: "Bearer",
      expires_in: 3600,
    });
    const data = await storage.load("test-server|http://example.com");
    expect(data?.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);
  });

  it("saves and loads code verifier", async () => {
    await provider.saveCodeVerifier("test-verifier-123");
    expect(await provider.codeVerifier()).toBe("test-verifier-123");
  });

  it("saves and loads client information", async () => {
    expect(await provider.clientInformation()).toBeUndefined();

    await provider.saveClientInformation({
      client_id: "cid",
      client_secret: "cs",
    });

    const info = await provider.clientInformation();
    expect(info?.client_id).toBe("cid");
  });

  it("returns pre-registered client info when configured", async () => {
    const preRegistered = new NoumenOAuthProvider("pre-reg", {
      storage,
      clientId: "my-client-id",
      clientSecret: "my-secret",
      clientMetadata: {
        redirect_uris: ["http://localhost:3118/callback"],
      },
    });

    const info = await preRegistered.clientInformation();
    expect(info?.client_id).toBe("my-client-id");
  });

  it("saves and loads discovery state", async () => {
    expect(await provider.discoveryState()).toBeUndefined();

    await provider.saveDiscoveryState({
      authorizationServerUrl: "https://auth.example.com",
    });

    const state = await provider.discoveryState();
    expect(state?.authorizationServerUrl).toBe("https://auth.example.com");
  });

  it("invalidateCredentials('tokens') clears tokens", async () => {
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.invalidateCredentials("tokens");
    expect(await provider.tokens()).toBeUndefined();
  });

  it("invalidateCredentials('all') clears everything", async () => {
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.saveCodeVerifier("v");
    await provider.invalidateCredentials("all");
    expect(await provider.tokens()).toBeUndefined();
    expect(await provider.codeVerifier()).toBe("");
  });

  it("invalidateCredentials('verifier') clears only verifier", async () => {
    await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
    await provider.saveCodeVerifier("v");
    await provider.invalidateCredentials("verifier");
    expect(await provider.codeVerifier()).toBe("");
    expect((await provider.tokens())?.access_token).toBe("at");
  });

  it("redirectToAuthorization calls onAuthorizationUrl callback", async () => {
    let captured: string | undefined;
    const p = new NoumenOAuthProvider("s", {
      storage,
      onAuthorizationUrl: (url) => { captured = url; },
      clientMetadata: {
        redirect_uris: ["http://localhost:3118/callback"],
      },
    });

    await p.redirectToAuthorization(new URL("https://auth.example.com/authorize?code=123"));
    expect(captured).toBe("https://auth.example.com/authorize?code=123");
  });
});

// ---------------------------------------------------------------------------
// findAvailablePort
// ---------------------------------------------------------------------------

describe("findAvailablePort", () => {
  it("returns a valid port number", async () => {
    const port = await findAvailablePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it("returns the preferred port when available", async () => {
    const port = await findAvailablePort(0);
    expect(typeof port).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// OAuthCallbackServer
// ---------------------------------------------------------------------------

describe("OAuthCallbackServer", () => {
  let server: OAuthCallbackServer;

  beforeEach(() => {
    server = new OAuthCallbackServer();
  });

  afterEach(() => {
    server.close();
  });

  it("starts and provides a redirect URI", async () => {
    const result = await server.start();
    expect(result.port).toBeGreaterThan(0);
    expect(result.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  });

  it("receives a callback with authorization code", async () => {
    const result = await server.start();
    const callbackPromise = result.waitForCallback();

    const res = await fetch(
      `http://localhost:${result.port}/callback?code=test-code-123&state=abc`,
    );
    expect(res.status).toBe(200);

    const callbackResult = await callbackPromise;
    expect(callbackResult.code).toBe("test-code-123");
    expect(callbackResult.state).toBe("abc");
  });

  it("rejects on state mismatch", async () => {
    const result = await server.start({ expectedState: "expected-state" });
    const callbackPromise = result.waitForCallback();
    callbackPromise.catch(() => {});

    await fetch(
      `http://localhost:${result.port}/callback?code=test&state=wrong-state`,
    );

    await expect(callbackPromise).rejects.toThrow("state mismatch");
  });

  it("rejects on OAuth error response", async () => {
    const result = await server.start();
    const callbackPromise = result.waitForCallback();
    callbackPromise.catch(() => {});

    await fetch(
      `http://localhost:${result.port}/callback?error=access_denied&error_description=User+denied`,
    );

    await expect(callbackPromise).rejects.toThrow("access_denied");
  });

  it("rejects when code is missing", async () => {
    const result = await server.start();
    const callbackPromise = result.waitForCallback();
    callbackPromise.catch(() => {});

    await fetch(`http://localhost:${result.port}/callback?state=abc`);

    await expect(callbackPromise).rejects.toThrow("Missing authorization code");
  });

  it("rejects on abort signal", async () => {
    const controller = new AbortController();
    const result = await server.start({ signal: controller.signal });
    const callbackPromise = result.waitForCallback();

    controller.abort();

    await expect(callbackPromise).rejects.toThrow("aborted");
  });

  it("returns 404 for non-callback paths", async () => {
    const result = await server.start();

    const res = await fetch(`http://localhost:${result.port}/other`);
    expect(res.status).toBe(404);
  });
});
