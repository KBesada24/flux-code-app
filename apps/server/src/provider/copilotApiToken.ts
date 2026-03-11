/**
 * copilotApiToken - Short-lived Copilot API token exchange and cache.
 *
 * Exchanges a long-lived GitHub OAuth token for a short-lived Copilot token
 * via the copilot_internal token endpoint. Caches the result in-process and
 * refreshes automatically when within 60 s of expiry.
 *
 * @module copilotApiToken
 */

const TOKEN_EXCHANGE_URL = "https://api.github.com/copilot_internal/v2/token";
const REFRESH_BUFFER_MS = 60_000;

export const COPILOT_IDE_HEADERS = {
  "Editor-Version": "t3code/0.0.4",
  "Editor-Plugin-Version": "t3code/0.0.4",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

type CopilotTokenCache = { token: string; expiresAtMs: number };
type ExchangeResponse = { token?: string; expires_at?: string; refresh_in?: number };

let cache: CopilotTokenCache | null = null;

function isExpiredOrNearExpiry(expiresAtMs: number): boolean {
  return Date.now() >= expiresAtMs - REFRESH_BUFFER_MS;
}

/**
 * Returns a short-lived Copilot API token, exchanging/refreshing as needed.
 * Returns null if the exchange fails for any reason.
 */
export async function getCopilotApiToken(oauthToken: string): Promise<string | null> {
  if (cache !== null && !isExpiredOrNearExpiry(cache.expiresAtMs)) {
    return cache.token;
  }

  try {
    const response = await fetch(TOKEN_EXCHANGE_URL, {
      method: "GET",
      headers: {
        Authorization: `token ${oauthToken}`,
        "User-Agent": "t3code",
        Accept: "application/json",
        ...COPILOT_IDE_HEADERS,
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(`[copilotApiToken] Token exchange failed ${response.status}: ${body}`);
      cache = null;
      return null;
    }

    const data = (await response.json()) as ExchangeResponse;
    const token = data.token;
    if (typeof token !== "string" || token.trim().length === 0) { cache = null; return null; }

    let expiresAtMs: number;
    if (typeof data.expires_at === "string") {
      const parsed = Date.parse(data.expires_at);
      expiresAtMs = Number.isFinite(parsed) ? parsed : Date.now() + 25 * 60 * 1000;
    } else {
      const refreshIn = typeof data.refresh_in === "number" && data.refresh_in > 0
        ? data.refresh_in : 1500;
      expiresAtMs = Date.now() + refreshIn * 1000;
    }

    cache = { token: token.trim(), expiresAtMs };
    return cache.token;
  } catch {
    cache = null;
    return null;
  }
}
