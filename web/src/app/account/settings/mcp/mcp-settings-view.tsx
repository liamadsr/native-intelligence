'use client'

import { Terminal } from 'lucide-react'
import { InboundMcpSection } from './inbound-mcp-section'

/**
 * Settings › Native Intelligence MCP: Native Intelligence as an MCP server, for Claude, ChatGPT, Cursor
 * and the other AI apps to reach into the workspace.
 *
 * The other direction (MCP servers the agent connects to) is a connector
 * like any other, on Settings › Connectors, the way Claude lists them.
 */
export function McpSettingsView() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white shadow-sm dark:bg-zinc-800">
            <Terminal className="h-5 w-5 text-emerald-500" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Native Intelligence MCP</h1>
            <p className="text-sm text-muted-foreground">
              Use your Native Intelligence workspace from Claude, ChatGPT, Cursor and your other AI apps.
            </p>
          </div>
        </div>

        <div className="mt-8">
          <InboundMcpSection />
        </div>
      </div>
    </div>
  )
}
