const MCP_SERVER_DISPLAY_NAMES = new Map<string, string>([
  ["linear", "Linear"],
  ["notion", "Notion"],
  ["openaiDeveloperDocs", "OpenAI Developer Docs"],
  ["playwright", "Playwright"],
  ["RepoPrompt", "RepoPrompt"],
]);

export function humanizeMcpServerName(server: string): string {
  const known = MCP_SERVER_DISPLAY_NAMES.get(server);
  if (known) {
    return known;
  }
  const spaced = server
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.length > 0 ? spaced[0]!.toUpperCase() + spaced.slice(1) : server;
}
