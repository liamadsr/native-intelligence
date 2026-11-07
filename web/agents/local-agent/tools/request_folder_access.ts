/**
 * request_folder_access: ask the person, on their Mac, to let this job READ one
 * more folder or file outside `/workspace` (C3 `fence`, read only, this job
 * only). lib/host-folder-sandbox.ts requestFenceAccess checks the path first
 * (never credentials, app data or where they really live), grants a path the
 * job can already read without asking, and otherwise asks through the
 * desktop's native prompt; on yes, later commands of the job can read it.
 * Nothing is ever made writable. The answer is one line for the model.
 *
 * A Mac host slot (contract C2): the Mac build adds it to the Dial8 agent as
 * tools/request_folder_access.ts (scripts/local-agent/mac-body.sh); the cloud
 * body has none.
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { macToolGuard } from '../../chat-agent/lib/mac-guard.js'
import { requestFenceAccess } from '../lib/host-folder-sandbox.js'

export default defineTool({
  description:
    'Ask the person, on their Mac, to let this job read one more folder or file outside /workspace: read only, for this job only. ' +
    'Use it only when the request needs files there. Commands can then read it by its absolute path; nothing there can be changed.',
  inputSchema: z.object({
    path: z.string().min(1).max(1024).describe('The absolute path on the Mac (or one starting with ~/).'),
    reason: z.string().max(300).optional().describe('Why, in a short sentence the person sees.'),
  }),
  async execute({ path, reason }, ctx) {
    // Never ask the person after a Stop (../../chat-agent/lib/mac-guard.ts).
    await macToolGuard(ctx.session?.auth)
    const result = await requestFenceAccess({ path, access: 'read', ...(reason ? { reason } : {}) })
    return { granted: result.granted, path: result.path, message: result.message }
  },
})
