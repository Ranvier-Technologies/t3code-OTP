import { XIcon } from "lucide-react";

import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import type { McpSessionViewModel } from "../mcp-session-logic";
import { getMcpSessionStatusLabel } from "../mcp-session-logic";
import { cn } from "~/lib/utils";

function badgeVariantForState(state: McpSessionViewModel["servers"][number]["state"]) {
  switch (state) {
    case "ready":
      return "success";
    case "failed":
      return "error";
    case "warning":
    case "cancelled":
      return "warning";
    case "starting":
      return "info";
    case "unknown":
    default:
      return "outline";
  }
}

export default function ThreadMcpStatusPanel({
  mcp,
  onClose,
  className,
}: {
  mcp: McpSessionViewModel;
  onClose?: () => void;
  className?: string;
}) {
  if (!mcp.hasAnyMcpActivity) {
    return null;
  }

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="gap-1 p-4 pb-3">
        <CardTitle className="text-base">MCP status</CardTitle>
        <CardDescription>Runtime MCP state for the active thread session.</CardDescription>
        {onClose ? (
          <CardAction>
            <Button
              type="button"
              aria-label="Hide MCP status"
              size="icon-xs"
              variant="ghost"
              onClick={onClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="min-h-0 space-y-3 overflow-y-auto p-4 pt-0">
        <div className="space-y-2">
          {mcp.servers.map((server) => (
            <div
              key={server.server}
              className="rounded-xl border border-border/80 bg-muted/12 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{server.displayName}</h3>
                    {server.authExpired ? (
                      <Badge variant="warning" size="sm">
                        Auth expired
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <Badge variant={badgeVariantForState(server.state)}>
                  {getMcpSessionStatusLabel(server.state)}
                </Badge>
              </div>
              {server.message ? (
                <p className="mt-2.5 text-sm text-muted-foreground" title={server.message}>
                  {server.message}
                </p>
              ) : null}
              {server.remediationCommand ? (
                <code className="mt-2.5 block overflow-x-auto rounded-md border border-border/80 bg-background px-2.5 py-2 text-xs text-foreground">
                  {server.remediationCommand}
                </code>
              ) : null}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
