/** Authored browser proxies only; external MCP tools use their own namespace. */
export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'run_browser_task', 'wait_for_browser_command', 'read_browser_page',
  'get_browser_text', 'screenshot_browser', 'open_browser', 'close_browser',
])

/** Eve hooks receive the full action.result. Correlation-only fields need not
 * consume model context; pending run_id remains available for the next wait. */
export function browserModelResult(output: unknown): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output
  const { browser_command_id: _commandId, ...result } = output as Record<string, unknown>
  return result
}
