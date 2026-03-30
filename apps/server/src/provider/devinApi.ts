import { Effect } from "effect";

export class DevinApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly payload: unknown;

  constructor(input: { status: number; url: string; payload: unknown; message: string }) {
    super(input.message);
    this.name = "DevinApiError";
    this.status = input.status;
    this.url = input.url;
    this.payload = input.payload;
  }
}

export interface DevinApiClientOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface DevinSelf {
  readonly id: string | null;
  readonly email: string | null;
  readonly name: string | null;
  readonly orgId: string | null;
}

export interface DevinSessionSummary {
  readonly id: string;
  readonly url: string | null;
  readonly status: string | null;
  readonly statusDetail: string | null;
  readonly isArchived: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly parentSessionId: string | null;
  readonly childSessionIds: ReadonlyArray<string>;
  readonly structuredOutput: unknown;
}

export interface DevinSessionMessage {
  readonly eventId: string;
  readonly source: string | null;
  readonly message: string;
  readonly createdAt: string | null;
}

export interface DevinCursorPage<TItem> {
  readonly items: ReadonlyArray<TItem>;
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
  readonly total: number | null;
}

export interface DevinCreateSessionInput {
  readonly prompt: string;
  readonly attachmentUrls?: ReadonlyArray<string>;
  readonly bypassApproval?: boolean;
  readonly title?: string;
  readonly playbookId?: string;
  readonly knowledgeIds?: ReadonlyArray<string>;
  readonly tags?: ReadonlyArray<string>;
  readonly createAsUserId?: string;
  readonly structuredOutputSchema?: unknown;
}

export interface DevinSendMessageInput {
  readonly message: string;
  readonly messageAsUserId?: string;
}

export interface DevinAttachment {
  readonly attachmentId: string;
  readonly name: string | null;
  readonly url: string;
}

export interface DevinApiClient {
  readonly getSelf: Effect.Effect<DevinSelf, DevinApiError>;
  readonly createAttachment: (
    orgId: string,
    file: Blob,
    filename: string,
  ) => Effect.Effect<DevinAttachment, DevinApiError>;
  readonly createSession: (
    orgId: string,
    input: DevinCreateSessionInput,
  ) => Effect.Effect<DevinSessionSummary, DevinApiError>;
  readonly getSession: (
    orgId: string,
    devinId: string,
  ) => Effect.Effect<DevinSessionSummary, DevinApiError>;
  readonly listSessionMessages: (
    orgId: string,
    devinId: string,
    options?: { readonly first?: number; readonly after?: string },
  ) => Effect.Effect<DevinCursorPage<DevinSessionMessage>, DevinApiError>;
  readonly sendSessionMessage: (
    orgId: string,
    devinId: string,
    input: DevinSendMessageInput,
  ) => Effect.Effect<void, DevinApiError>;
  readonly archiveSession: (orgId: string, devinId: string) => Effect.Effect<void, DevinApiError>;
  readonly terminateSession: (orgId: string, devinId: string) => Effect.Effect<void, DevinApiError>;
}

const DEFAULT_DEVIN_BASE_URL = "https://api.devin.ai";

function trimString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const trimmed = trimString(entry);
    return trimmed ? [trimmed] : [];
  });
}

function normalizeSession(value: unknown): DevinSessionSummary {
  const record = readRecord(value) ?? {};
  return {
    id: trimString(record.session_id) ?? trimString(record.id) ?? "",
    url: trimString(record.url),
    status: trimString(record.status),
    statusDetail: trimString(record.status_detail) ?? trimString(record.statusDetail),
    isArchived: record.is_archived === true || record.isArchived === true,
    createdAt: trimString(record.created_at) ?? trimString(record.createdAt),
    updatedAt: trimString(record.updated_at) ?? trimString(record.updatedAt),
    parentSessionId: trimString(record.parent_session_id) ?? trimString(record.parentSessionId),
    childSessionIds: readStringArray(record.child_session_ids ?? record.childSessionIds),
    structuredOutput: record.structured_output ?? record.structuredOutput ?? null,
  };
}

function normalizeSelf(value: unknown): DevinSelf {
  const record = readRecord(value) ?? {};
  return {
    id: trimString(record.user_id) ?? trimString(record.id),
    email: trimString(record.email),
    name: trimString(record.name),
    orgId:
      trimString(record.org_id) ??
      trimString(record.organization_id) ??
      trimString(record.organizationId),
  };
}

function normalizeMessage(value: unknown): DevinSessionMessage {
  const record = readRecord(value) ?? {};
  return {
    eventId: trimString(record.event_id) ?? trimString(record.id) ?? "",
    source: trimString(record.source),
    message: trimString(record.message) ?? "",
    createdAt: trimString(record.created_at) ?? trimString(record.createdAt),
  };
}

function normalizeCursorPage<TItem>(
  value: unknown,
  mapItem: (value: unknown) => TItem,
): DevinCursorPage<TItem> {
  const record = readRecord(value) ?? {};
  const items = Array.isArray(record.items) ? record.items.map(mapItem) : [];
  const total = typeof record.total === "number" ? record.total : null;
  return {
    items,
    endCursor: trimString(record.end_cursor) ?? trimString(record.endCursor),
    hasNextPage: record.has_next_page === true || record.hasNextPage === true,
    total,
  };
}

function toErrorMessage(status: number, payload: unknown): string {
  const record = readRecord(payload);
  const detail =
    trimString(record?.message) ??
    trimString(record?.error) ??
    trimString(record?.detail) ??
    (typeof payload === "string" ? trimString(payload) : null);
  return detail
    ? `Devin API request failed (${status}): ${detail}`
    : `Devin API request failed (${status}).`;
}

function makeUrl(baseUrl: string, pathname: string, search?: URLSearchParams): string {
  const url = new URL(pathname.replace(/^\//, ""), baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  if (search) {
    url.search = search.toString();
  }
  return url.toString();
}

function mapSessionInput(input: DevinCreateSessionInput): Record<string, unknown> {
  return {
    prompt: input.prompt,
    ...(input.attachmentUrls?.length ? { attachment_urls: [...input.attachmentUrls] } : {}),
    ...(input.bypassApproval !== undefined ? { bypass_approval: input.bypassApproval } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.playbookId ? { playbook_id: input.playbookId } : {}),
    ...(input.knowledgeIds?.length ? { knowledge_ids: [...input.knowledgeIds] } : {}),
    ...(input.tags?.length ? { tags: [...input.tags] } : {}),
    ...(input.createAsUserId ? { create_as_user_id: input.createAsUserId } : {}),
    ...(input.structuredOutputSchema !== undefined
      ? { structured_output_schema: input.structuredOutputSchema }
      : {}),
  };
}

function mapMessageInput(input: DevinSendMessageInput): Record<string, unknown> {
  return {
    message: input.message,
    ...(input.messageAsUserId ? { message_as_user_id: input.messageAsUserId } : {}),
  };
}

export function createDevinApiClient(options: DevinApiClientOptions): DevinApiClient {
  const baseUrl = trimString(options.baseUrl) ?? DEFAULT_DEVIN_BASE_URL;
  const apiKey = options.apiKey.trim();
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const request = <T>(input: {
    readonly method: string;
    readonly pathname: string;
    readonly search?: URLSearchParams;
    readonly body?: RequestInit["body"];
    readonly headers?: RequestInit["headers"];
    readonly decode: (value: unknown) => T;
  }): Effect.Effect<T, DevinApiError> =>
    Effect.tryPromise({
      try: async () => {
        const url = makeUrl(baseUrl, input.pathname, input.search);
        const response = await fetchImpl(url, {
          method: input.method,
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(input.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
            ...input.headers,
          },
          body: input.body,
        });

        const contentType = response.headers.get("content-type") ?? "";
        const payload = contentType.includes("application/json")
          ? await response.json()
          : await response.text();
        if (!response.ok) {
          throw new DevinApiError({
            status: response.status,
            url,
            payload,
            message: toErrorMessage(response.status, payload),
          });
        }
        return input.decode(payload);
      },
      catch: (error) =>
        error instanceof DevinApiError
          ? error
          : new DevinApiError({
              status: 0,
              url: makeUrl(baseUrl, input.pathname, input.search),
              payload: null,
              message:
                error instanceof Error
                  ? `Devin API request failed: ${error.message}`
                  : "Devin API request failed.",
            }),
    });

  return {
    getSelf: request({
      method: "GET",
      pathname: "/v3/self",
      decode: normalizeSelf,
    }),
    createAttachment: (orgId, file, filename) => {
      const formData = new FormData();
      formData.append("file", file, filename);
      return request({
        method: "POST",
        pathname: `/v3/organizations/${encodeURIComponent(orgId)}/attachments`,
        body: formData,
        decode: (value) => {
          const record = readRecord(value) ?? {};
          return {
            attachmentId: trimString(record.attachment_id) ?? trimString(record.attachmentId) ?? "",
            name: trimString(record.name),
            url: trimString(record.url) ?? "",
          } satisfies DevinAttachment;
        },
      });
    },
    createSession: (orgId, input) =>
      request({
        method: "POST",
        pathname: `/v3/organizations/${encodeURIComponent(orgId)}/sessions`,
        body: JSON.stringify(mapSessionInput(input)),
        decode: normalizeSession,
      }),
    getSession: (orgId, devinId) =>
      request({
        method: "GET",
        pathname: `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(devinId)}`,
        decode: normalizeSession,
      }),
    listSessionMessages: (orgId, devinId, options) => {
      const search = new URLSearchParams();
      if (options?.first !== undefined) {
        search.set("first", String(options.first));
      }
      if (options?.after) {
        search.set("after", options.after);
      }
      return request({
        method: "GET",
        pathname: `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(devinId)}/messages`,
        search,
        decode: (value) => normalizeCursorPage(value, normalizeMessage),
      });
    },
    sendSessionMessage: (orgId, devinId, input) =>
      request({
        method: "POST",
        pathname: `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(devinId)}/messages`,
        body: JSON.stringify(mapMessageInput(input)),
        decode: () => undefined,
      }),
    archiveSession: (orgId, devinId) =>
      request({
        method: "POST",
        pathname: `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(devinId)}/archive`,
        decode: () => undefined,
      }),
    terminateSession: (orgId, devinId) =>
      request({
        method: "DELETE",
        pathname: `/v3/organizations/${encodeURIComponent(orgId)}/sessions/${encodeURIComponent(devinId)}`,
        decode: () => undefined,
      }),
  };
}
