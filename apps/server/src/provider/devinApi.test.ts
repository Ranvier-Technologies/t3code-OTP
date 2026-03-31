import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { createDevinApiClient } from "./devinApi";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

describe("createDevinApiClient", () => {
  it("calls GET /v3/self with bearer auth and normalizes the response", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const client = createDevinApiClient({
      apiKey: "cog_test",
      baseUrl: "https://api.example.test",
      fetch: async (url, init) => {
        requests.push({ url: String(url), init });
        return jsonResponse({
          user_id: "user-123",
          email: "devin@example.test",
          name: "Devin User",
          org_id: "org-123",
        });
      },
    });

    const self = await Effect.runPromise(client.getSelf);

    expect(self).toEqual({
      id: "user-123",
      email: "devin@example.test",
      name: "Devin User",
      orgId: "org-123",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.example.test/v3/self");
    const headers = requests[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer cog_test");
  });

  it("builds session message pagination requests", async () => {
    const requests: Array<string> = [];
    const client = createDevinApiClient({
      apiKey: "cog_test",
      baseUrl: "https://api.example.test",
      fetch: async (url) => {
        requests.push(String(url));
        return jsonResponse({
          items: [
            {
              event_id: "evt-1",
              source: "assistant",
              message: "hello",
              created_at: "2026-03-30T00:00:00.000Z",
            },
          ],
          end_cursor: "cursor-2",
          has_next_page: true,
          total: 10,
        });
      },
    });

    const page = await Effect.runPromise(
      client.listSessionMessages("org-1", "session-1", {
        first: 50,
        after: "cursor-1",
      }),
    );

    expect(requests).toEqual([
      "https://api.example.test/v3/organizations/org-1/sessions/session-1/messages?first=50&after=cursor-1",
    ]);
    expect(page).toEqual({
      items: [
        {
          eventId: "evt-1",
          source: "assistant",
          message: "hello",
          createdAt: "2026-03-30T00:00:00.000Z",
        },
      ],
      endCursor: "cursor-2",
      hasNextPage: true,
      total: 10,
    });
  });

  it("surfaces DevinApiError with HTTP status and payload", async () => {
    const client = createDevinApiClient({
      apiKey: "cog_test",
      baseUrl: "https://api.example.test",
      fetch: async () => jsonResponse({ message: "invalid token" }, { status: 401 }),
    });

    await expect(Effect.runPromise(client.getSelf)).rejects.toMatchObject({
      name: "DevinApiError",
      status: 401,
      payload: { message: "invalid token" },
    });
  });
});
