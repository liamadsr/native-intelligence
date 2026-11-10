// Harness lockdown: the chat-agent has NO sandbox or coding surface. Every
// capability it exposes comes through the workspace-tool proxies
// (tools/workspace_tools.ts → the Next internal tool route), gated by the
// conversation's persona ceiling. The sandbox-backed defaults outside that —
// shell and filesystem — are removed structurally with disableTool(), never left
// to prose. Disabling all sandbox-backed tools also means no sandbox is ever
// provisioned for these sessions.
//
// WEB IS NOT PART OF THIS LOCKDOWN. web_search/web_fetch are always on for every
// Native Intelligence agent and sit OUTSIDE the ceiling mechanism (which filters workspace
// proxies, not framework tools) — see tools/web_search.ts and tools/web_fetch.ts.
//
// THE MAC BODY (contract C2, ../lib/host.ts) is the exception: built with
// NI_AGENT_HOST=mac, this is eve's own `write_file`, bound to the Mac host's
// sandbox, the host-folder fence (agents/local-agent/sandbox.ts, which the Mac
// build adds as sandbox.ts): the folder the person shared, enforced by the
// kernel. The cloud build never has a sandbox file, so this stays off there.
// Each call first asks the app whether the job is still on, and refuses if
// not (../lib/mac-guard.ts), so a Stop pressed mid-step is honoured.
import { defineTool, disableTool } from 'eve/tools'
import { writeFile, type WriteFileToolOutput } from 'eve/tools/write_file'
import { isMacHost } from '../lib/host.js'
import { macToolGuard } from '../lib/mac-guard.js'

export default isMacHost()
  ? defineTool({
      ...writeFile,
      async execute(input, ctx) {
        await macToolGuard(ctx.session?.auth)
        return (await writeFile.execute(input, ctx)) as WriteFileToolOutput
      },
    })
  : disableTool()
