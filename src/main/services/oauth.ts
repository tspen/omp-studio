import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { shell } from "electron";
import type { Store } from "./store";

interface ProviderConfig {
  authorize: string;
  token: string;
  scopes: string;
  extraAuth?: Record<string, string>;
}

const PROVIDERS: Record<string, ProviderConfig> = {
  github: {
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scopes: "repo read:user",
  },
  slack: {
    authorize: "https://slack.com/oauth/v2/authorize",
    token: "https://slack.com/api/oauth.v2.access",
    scopes: "chat:write,channels:read,users:read",
  },
  linear: {
    authorize: "https://linear.app/oauth/authorize",
    token: "https://api.linear.app/oauth/token",
    scopes: "read,write",
  },
  figma: {
    authorize: "https://www.figma.com/oauth",
    token: "https://www.figma.com/api/oauth/token",
    scopes: "file_read",
  },
};

export class OAuthService {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  async connect(providerName: string): Promise<{ ok: boolean; output: string }> {
    const provider = PROVIDERS[providerName];
    if (!provider) throw new Error(`No OAuth flow for ${providerName}`);
    const connectors = this.store.settings.connectors as any;
    const clientId = connectors?.[providerName]?.clientId;
    const clientSecret = this.store.getSecret(`oauth.${providerName}.secret`);
    if (!clientId) throw new Error(`Add an OAuth client ID for ${providerName} in Settings → Connectors`);
    if (!clientSecret) throw new Error(`Add an OAuth client secret for ${providerName} in Settings → Connectors`);

    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      let port = 43110;
      const attempt = () => {
        server.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "EADDRINUSE" && port < 43119) {
            port += 1;
            setTimeout(attempt, 20);
          } else {
            reject(error);
          }
        });
        server.listen(port, "127.0.0.1", () => resolve());
      };
      attempt();
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
    const state = randomUUID();
    const authorize = new URL(process.env[`PERCH_OAUTH_${providerName.toUpperCase()}_AUTHORIZE`] ?? provider.authorize);
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("state", state);
    if (provider.scopes) authorize.searchParams.set("scope", provider.scopes);
    for (const [key, value] of Object.entries(provider.extraAuth ?? {})) authorize.searchParams.set(key, value);

    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.close();
        reject(new Error("OAuth authorization timed out"));
      }, 180_000);
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/oauth/callback") {
          response.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        const value = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
          `<!doctype html><html><body style="font-family:system-ui;padding:40px"><h2>${error ? "Authorization failed" : "Connected"}</h2><p>${error ? error : "You can close this tab and return to Perch."}</p></body></html>`,
        );
        clearTimeout(timer);
        server.close();
        if (error) reject(new Error(error));
        else if (!value) reject(new Error("OAuth provider did not return a code"));
        else if (returnedState !== state) reject(new Error("OAuth state mismatch"));
        else resolve(value);
      });
      if (process.env.PERCH_OAUTH_SKIP_BROWSER === "1") {
        void fetch(authorize.toString()).catch(() => undefined);
      } else {
        void shell.openExternal(authorize.toString());
      }
    });

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const tokenUrl = process.env[`PERCH_OAUTH_${providerName.toUpperCase()}_TOKEN`] ?? provider.token;
    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await tokenResponse.text();
    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = Object.fromEntries(new URLSearchParams(text));
    }
    if (!tokenResponse.ok || data.error || (!data.access_token && !data.accessToken)) {
      throw new Error(`Token exchange failed: ${data.error_description ?? data.error ?? text.slice(0, 300)}`);
    }
    const accessToken = data.access_token ?? data.accessToken;
    this.store.setSecret(`${providerName}.token`, accessToken);
    const refresh = data.refresh_token ?? data.refreshToken;
    if (refresh) this.store.setSecret(`${providerName}.refresh`, refresh);
    return { ok: true, output: `${providerName} connected with OAuth` };
  }
}
