// What a take's prompter keeps (server/prompter.ts stores it; the Record dialog edits it): the script as text, and
// the checklist's items. Shared by the page and the server, so the limits are the same on both sides.
import { z } from 'zod'

export const MAX_SCRIPT_CHARS = 20_000
export const MAX_ITEMS = 30
export const MAX_ITEM_CHARS = 200

export const PrompterContentSchema = z.object({
  script: z.string().max(MAX_SCRIPT_CHARS),
  items: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/), text: z.string().trim().min(1).max(MAX_ITEM_CHARS) }).strict()).max(MAX_ITEMS),
}).strict()
export type PrompterContent = z.infer<typeof PrompterContentSchema>
