import { expect, test } from "@playwright/test";

import {
  type ProviderConfig,
  createNewThread,
  selectProvider,
  sendMessage,
  waitForResponse,
} from "./helpers";

const PROVIDERS: ProviderConfig[] = [
  { label: "Codex", model: "GPT-5.4", slug: "gpt-5.4" },
  { label: "Claude", model: "Claude Sonnet 4.6", slug: "claude-sonnet-4-6" },
  { label: "Cursor", model: "Auto (account default)", slug: "auto" },
  { label: "OpenCode", model: "Auto (account default)", slug: "auto" },
];

const PROMPT = "Reply with exactly one word: pong";

for (const provider of PROVIDERS) {
  test.describe(`Provider: ${provider.label}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await expect(page.locator(".group\\/project-header").first()).toBeVisible({
        timeout: 15_000,
      });
    });

    test("sends message and receives response", async ({ page }) => {
      await createNewThread(page);

      await selectProvider(page, provider);
      await page.screenshot({ path: `e2e-results/${provider.label}-01-provider-selected.png` });

      await sendMessage(page, PROMPT);
      await page.screenshot({ path: `e2e-results/${provider.label}-02-message-sent.png` });

      const response = await waitForResponse(page);
      await page.screenshot({ path: `e2e-results/${provider.label}-03-response-received.png` });

      const text = await response.textContent();
      expect(text?.trim().length).toBeGreaterThan(0);
    });

    test("shows correct provider in picker after selection", async ({ page }) => {
      await createNewThread(page);
      await selectProvider(page, provider);

      const footer = page.locator('[data-chat-composer-footer="true"]');
      const pickerTrigger = footer.locator("button").first();
      await expect(pickerTrigger).toContainText(provider.model);

      await page.screenshot({ path: `e2e-results/${provider.label}-04-picker-verified.png` });
    });
  });
}
