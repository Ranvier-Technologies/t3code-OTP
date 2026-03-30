import type { ProviderKind, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Effect, Equal, Layer, Result, Stream } from "effect";

import { ServerSettingsService } from "../../serverSettings";
import { createDevinApiClient, DevinApiError } from "../devinApi";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { DEVIN_PROVIDER_CAPABILITIES } from "../providerCapabilities";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot";
import { DevinProvider } from "../Services/DevinProvider";

const DEVIN_PROVIDER = "devin" as unknown as ProviderKind;
const DEFAULT_DEVIN_BASE_URL = "https://api.devin.ai";
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "devin-default",
    name: "Devin Default",
    isCustom: false,
    capabilities: null,
  },
];

interface DevinProviderSettings {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly orgId: string | undefined;
  readonly customModels: ReadonlyArray<string>;
}

interface DevinServerSettingsLike {
  readonly providers?: Record<string, unknown>;
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return undefined;
  }
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      const trimmed = nonEmptyTrimmed(entry);
      return trimmed ? [trimmed] : [];
    });
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function readProviderSettings(settings: DevinServerSettingsLike): Record<string, unknown> {
  const providers = settings.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return {};
  }
  const providerSettings = providers.devin;
  if (
    !providerSettings ||
    typeof providerSettings !== "object" ||
    Array.isArray(providerSettings)
  ) {
    return {};
  }
  return providerSettings as Record<string, unknown>;
}

function readEnvValue(env: NodeJS.ProcessEnv, ...keys: ReadonlyArray<string>): string | undefined {
  for (const key of keys) {
    const value = nonEmptyTrimmed(env[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveDevinProviderSettings(
  settings: DevinServerSettingsLike,
  env: NodeJS.ProcessEnv = process.env,
): DevinProviderSettings {
  const providerSettings = readProviderSettings(settings);
  const apiKey = readEnvValue(env, "T3CODE_DEVIN_API_KEY", "DEVIN_API_KEY");
  const orgId =
    readEnvValue(env, "T3CODE_DEVIN_ORG_ID", "DEVIN_ORG_ID") ??
    nonEmptyTrimmed(providerSettings.orgId);
  const baseUrl =
    readEnvValue(env, "T3CODE_DEVIN_BASE_URL", "DEVIN_BASE_URL") ??
    nonEmptyTrimmed(providerSettings.baseUrl) ??
    DEFAULT_DEVIN_BASE_URL;
  const customModels = [
    ...readStringArray(providerSettings.customModels),
    ...readStringArray(readEnvValue(env, "T3CODE_DEVIN_CUSTOM_MODELS", "DEVIN_CUSTOM_MODELS")),
  ];
  const enabled =
    readBoolean(readEnvValue(env, "T3CODE_DEVIN_ENABLED", "DEVIN_ENABLED")) ??
    readBoolean(providerSettings.enabled) ??
    Boolean(apiKey || orgId || customModels.length > 0);

  return {
    enabled,
    baseUrl,
    apiKey,
    orgId,
    customModels,
  };
}

function buildDevinModels(customModels: ReadonlyArray<string>): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BUILT_IN_MODELS,
    DEVIN_PROVIDER as ServerProvider["provider"],
    customModels,
  );
}

export const checkDevinProviderStatus = (options?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;
    const settings = yield* settingsService.getSettings;
    const providerSettings = resolveDevinProviderSettings(settings, options?.env);
    const checkedAt = new Date().toISOString();
    const models = buildDevinModels(providerSettings.customModels);

    const buildSnapshot = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
      buildServerProvider({
        provider: DEVIN_PROVIDER as ServerProvider["provider"],
        enabled: providerSettings.enabled,
        checkedAt,
        models,
        probe,
        capabilities: DEVIN_PROVIDER_CAPABILITIES,
      });

    if (!providerSettings.enabled) {
      return buildSnapshot({
        installed: false,
        version: null,
        status: "warning",
        authStatus: "unknown",
        message: "Devin is disabled in T3 Code settings.",
      });
    }

    if (!providerSettings.apiKey) {
      return buildSnapshot({
        installed: false,
        version: null,
        status: "error",
        authStatus: "unauthenticated",
        message:
          "Devin API key is missing. Set T3CODE_DEVIN_API_KEY or DEVIN_API_KEY and try again.",
      });
    }

    if (!providerSettings.orgId) {
      return buildSnapshot({
        installed: false,
        version: null,
        status: "error",
        authStatus: "unknown",
        message:
          "Devin organization ID is missing. Set T3CODE_DEVIN_ORG_ID or DEVIN_ORG_ID and try again.",
      });
    }

    const client = createDevinApiClient({
      apiKey: providerSettings.apiKey,
      baseUrl: providerSettings.baseUrl,
      ...(options?.fetch ? { fetch: options.fetch } : {}),
    });
    const selfResult = yield* client.getSelf.pipe(Effect.result);

    if (Result.isFailure(selfResult)) {
      const error = selfResult.failure;
      if (error instanceof DevinApiError) {
        if (error.status === 401) {
          return buildSnapshot({
            installed: true,
            version: null,
            status: "error",
            authStatus: "unauthenticated",
            message: "Devin API rejected the configured token. Check the API key and try again.",
          });
        }
        if (error.status === 403) {
          return buildSnapshot({
            installed: true,
            version: null,
            status: "error",
            authStatus: "authenticated",
            message:
              "Devin API token is authenticated but missing permission to call GET /v3/self (ReadAccountMeta).",
          });
        }
        return buildSnapshot({
          installed: true,
          version: null,
          status: "error",
          authStatus: "unknown",
          message: error.message,
        });
      }
    }

    if (Result.isSuccess(selfResult)) {
      const self = selfResult.success;
      if (!self.orgId) {
        return buildSnapshot({
          installed: true,
          version: null,
          status: "error",
          authStatus: "authenticated",
          message: "Devin API response did not include an organization id from GET /v3/self.",
        });
      }

      if (self.orgId !== providerSettings.orgId) {
        return buildSnapshot({
          installed: true,
          version: null,
          status: "error",
          authStatus: "authenticated",
          message: `Configured Devin org '${providerSettings.orgId}' does not match token org '${self.orgId}'.`,
        });
      }
    }

    return buildSnapshot({
      installed: true,
      version: null,
      status: "ready",
      authStatus: "authenticated",
    });
  });

export const DevinProviderLive = Layer.effect(
  DevinProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    return yield* makeManagedServerProvider<DevinProviderSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => resolveDevinProviderSettings(settings)),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => resolveDevinProviderSettings(settings)),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider: checkDevinProviderStatus().pipe(
        Effect.provideService(ServerSettingsService, serverSettings),
      ),
    });
  }),
);
