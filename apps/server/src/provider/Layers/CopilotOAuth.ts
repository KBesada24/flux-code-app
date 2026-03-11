import { Effect, Layer } from "effect";

import { CopilotOAuth, type CopilotOAuthShape } from "../Services/CopilotOAuth";
import {
  CopilotAuthStore,
  type CopilotAuthToken,
} from "../Services/CopilotAuthStore";
import { CopilotOAuthError } from "../Errors";

type DeviceAuthResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
};

type TokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type PendingAuth = {
  readonly deviceCode: string;
  readonly intervalSeconds: number;
  readonly expiresAt: string;
};

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const CLIENT_ID_ENV = "T3CODE_COPILOT_CLIENT_ID";
const DEFAULT_CLIENT_ID = "01ab8ac9400c4e429b23";
const SCOPE_ENV = "T3CODE_COPILOT_SCOPES";

function getClientId(): string {
  const raw = process.env[CLIENT_ID_ENV];
  if (raw && raw.trim().length > 0) {
    return raw.trim();
  }
  return DEFAULT_CLIENT_ID;
}

function getScopes(): string {
  const raw = process.env[SCOPE_ENV];
  if (raw && raw.trim().length > 0) {
    return raw.trim();
  }
  return "read:user";
}

function parseJsonResponse<T extends object>(raw: string): T {
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

function normalizeScopeList(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope
    .split(/[ ,]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const postForm = <T extends object>(operation: string, url: string, body: URLSearchParams) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      const payloadText = await response.text();
      const payload = parseJsonResponse<T>(payloadText);
      return { ok: response.ok, status: response.status, payload };
    },
    catch: (cause) =>
      new CopilotOAuthError({
        operation,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

const makeCopilotOAuth = Effect.gen(function* () {
  const authStore = yield* CopilotAuthStore;
  const pending = new Map<string, PendingAuth>();

  const startDeviceAuth: CopilotOAuthShape["startDeviceAuth"] = () =>
    Effect.gen(function* () {
      const clientId = yield* Effect.try({
        try: () => getClientId(),
        catch: (cause) =>
          new CopilotOAuthError({
            operation: "startDeviceAuth",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      const scope = getScopes();
      const body = new URLSearchParams();
      body.set("client_id", clientId);
      body.set("scope", scope);

      const response = yield* postForm<DeviceAuthResponse>(
        "startDeviceAuth",
        DEVICE_CODE_URL,
        body,
      );
      const payload = response.payload;

      if (!response.ok) {
        return yield* new CopilotOAuthError({
          operation: "startDeviceAuth",
          detail:
            payload.error_description ??
            `GitHub device auth failed with ${response.status}`,
        });
      }
      if (!payload.device_code || !payload.user_code || !payload.verification_uri) {
        return yield* new CopilotOAuthError({
          operation: "startDeviceAuth",
          detail: "GitHub device auth response missing required fields.",
        });
      }

      const intervalSeconds = Number.isFinite(payload.interval) ? payload.interval ?? 5 : 5;
      const expiresIn = Number.isFinite(payload.expires_in) ? payload.expires_in ?? 900 : 900;
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
      const authId = crypto.randomUUID();

      pending.set(authId, {
        deviceCode: payload.device_code,
        intervalSeconds,
        expiresAt,
      });

      return {
        authId,
        verificationUri: payload.verification_uri,
        userCode: payload.user_code,
        expiresAt,
        intervalSeconds,
      };
    });

  const pollDeviceAuth: CopilotOAuthShape["pollDeviceAuth"] = (authId) =>
    Effect.gen(function* () {
      const entry = pending.get(authId);
      if (!entry) {
        return { status: "error", message: "Unknown or expired auth session." } as const;
      }

      if (Date.now() >= Date.parse(entry.expiresAt)) {
        pending.delete(authId);
        return { status: "expired", message: "Device authorization expired." } as const;
      }

      const clientId = yield* Effect.try({
        try: () => getClientId(),
        catch: (cause) =>
          new CopilotOAuthError({
            operation: "pollDeviceAuth",
            detail: cause instanceof Error ? cause.message : String(cause),
            cause,
          }),
      });
      const body = new URLSearchParams();
      body.set("client_id", clientId);
      body.set("device_code", entry.deviceCode);
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

      const response = yield* postForm<TokenResponse>(
        "pollDeviceAuth",
        ACCESS_TOKEN_URL,
        body,
      );
      const payload = response.payload;

      if (!response.ok) {
        return {
          status: "error",
          message:
            payload.error_description ??
            `GitHub access token request failed with ${response.status}`,
        } as const;
      }

      if (payload.error) {
        switch (payload.error) {
          case "authorization_pending":
            return { status: "pending" } as const;
          case "slow_down":
            return { status: "pending", message: "Slow down polling." } as const;
          case "access_denied":
            pending.delete(authId);
            return { status: "denied", message: "Access denied." } as const;
          case "expired_token":
            pending.delete(authId);
            return { status: "expired", message: "Device authorization expired." } as const;
          default:
            return {
              status: "error",
              message: payload.error_description ?? payload.error,
            } as const;
        }
      }

      if (!payload.access_token) {
        return { status: "error", message: "Missing access token in response." } as const;
      }

      const tokenRecord: CopilotAuthToken = {
        accessToken: payload.access_token,
        tokenType: payload.token_type ?? "bearer",
        scopes: normalizeScopeList(payload.scope),
        acquiredAt: new Date().toISOString(),
      };

      yield* authStore.set(tokenRecord);
      pending.delete(authId);
      return { status: "authorized" } as const;
    });

  return {
    startDeviceAuth,
    pollDeviceAuth,
  } satisfies CopilotOAuthShape;
});

export const CopilotOAuthLive = Layer.effect(CopilotOAuth, makeCopilotOAuth);
