import { randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthTokens,
  OAuthClientMetadata,
  OAuthClientInformationMixed,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { TokenStorage, OAuthProviderOptions } from "./types.js";

/**
 * OAuthClientProvider implementation backed by noumen's pluggable
 * TokenStorage. Handles all persistence (tokens, client info, PKCE
 * verifiers, discovery state) through the storage interface and
 * delegates browser/UI concerns to configurable callbacks.
 */
export class NoumenOAuthProvider implements OAuthClientProvider {
  private serverKey: string;
  private storage: TokenStorage;
  private _clientMetadata: OAuthClientMetadata;
  private _callbackPort: number;
  private _onAuthorizationUrl?: (url: string) => void | Promise<void>;
  private _signal?: AbortSignal;
  private _preRegisteredClientId?: string;
  private _preRegisteredClientSecret?: string;

  constructor(serverKey: string, options: OAuthProviderOptions) {
    this.serverKey = serverKey;
    this.storage = options.storage;
    this._clientMetadata = options.clientMetadata;
    this._callbackPort = options.callbackPort ?? 3118;
    this._onAuthorizationUrl = options.onAuthorizationUrl;
    this._signal = options.signal;
    this._preRegisteredClientId = options.clientId;
    this._preRegisteredClientSecret = options.clientSecret;
  }

  get redirectUrl(): string {
    return `http://localhost:${this._callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  async state(): Promise<string> {
    return randomBytes(16).toString("hex");
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this._preRegisteredClientId) {
      const info: OAuthClientInformationMixed = {
        client_id: this._preRegisteredClientId,
      };
      if (this._preRegisteredClientSecret) {
        (info as Record<string, unknown>).client_secret =
          this._preRegisteredClientSecret;
      }
      return info;
    }

    const data = await this.storage.load(this.serverKey);
    return data?.clientInformation;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    const data = (await this.storage.load(this.serverKey)) ?? {};
    data.clientInformation = clientInformation;
    await this.storage.save(this.serverKey, data);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const data = await this.storage.load(this.serverKey);
    return data?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const data = (await this.storage.load(this.serverKey)) ?? {};
    data.tokens = tokens;
    if (tokens.expires_in != null) {
      data.expiresAt = Date.now() + tokens.expires_in * 1000;
    }
    await this.storage.save(this.serverKey, data);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const urlStr = authorizationUrl.toString();

    if (this._onAuthorizationUrl) {
      await this._onAuthorizationUrl(urlStr);
      return;
    }

    openBrowser(urlStr);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const data = (await this.storage.load(this.serverKey)) ?? {};
    data.codeVerifier = codeVerifier;
    await this.storage.save(this.serverKey, data);
  }

  async codeVerifier(): Promise<string> {
    const data = await this.storage.load(this.serverKey);
    return data?.codeVerifier ?? "";
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      await this.storage.delete(this.serverKey);
      return;
    }

    const data = await this.storage.load(this.serverKey);
    if (!data) return;

    switch (scope) {
      case "client":
        delete data.clientInformation;
        break;
      case "tokens":
        delete data.tokens;
        delete data.expiresAt;
        break;
      case "verifier":
        delete data.codeVerifier;
        break;
      case "discovery":
        delete data.discoveryState;
        break;
    }
    await this.storage.save(this.serverKey, data);
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const data = (await this.storage.load(this.serverKey)) ?? {};
    data.discoveryState = state;
    await this.storage.save(this.serverKey, data);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const data = await this.storage.load(this.serverKey);
    return data?.discoveryState;
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? "open"
      : platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`);
}
