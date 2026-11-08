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
// DIAL8_AGENT_HOST=mac, this is eve's own `read_file`, bound to the Mac host's
// sandbox, the host-folder fence (agents/local-agent/sandbox.ts, which the Mac
// build adds as sandbox.ts): the folder the person shared, enforced by the
// kernel. The cloud build never has a sandbox file, so this stays off there.
// Its model output is replaced: eve's attaches an image or PDF as a file part,
// which eve then stages into the sandbox (/workspace/.eve/attachments: the
// person's folder, or the worktree a finish commits), so on the Mac the model
// gets the text and a note instead (../lib/chat-image-output.ts), and its
// description says so (eve's says images and PDFs are shown as files). Each
// call first asks the app whether the job is still on (../lib/mac-guard.ts).
import { defineTool, disableTool } from 'eve/tools'
import { readFile, type ReadFileToolOutput } from 'eve/tools/read_file'
import { MAC_READ_FILE_DESCRIPTION, macReadFileModelOutput } from '../lib/chat-image-output.js'
import { isMacHost } from '../lib/host.js'
import { macToolGuard } from '../lib/mac-guard.js'

export default isMacHost()
  ? defineTool({
      ...readFile,
      description: MAC_READ_FILE_DESCRIPTION,
      async execute(input, ctx) {
        await macToolGuard(ctx.session?.auth)
        return (await readFile.execute(input, ctx)) as ReadFileToolOutput
      },
      toModelOutput: macReadFileModelOutput,
    })
  : disableTool()
