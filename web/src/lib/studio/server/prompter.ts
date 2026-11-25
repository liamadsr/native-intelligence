// A take's prompter: the script the person reads while recording and the checklist of points they mean to make,
// kept so the next take (a retake) has them again. One studio_record per place (collection `prompter`):
//   - a video being recorded into (a punch-in or storyboard beats): key `video:<id>`, shared by the workspace's
//     members who can open that video;
//   - a person's own new takes: key `user:<id>`, theirs alone, in this workspace.
// studio_record has no row-level policies (620: service role only), so this file is the whole fence. The page only
// ever names `mine` or a video id; the user key is built here from who is signed in, and a video is accepted only when
// it is this workspace's and not archived. The text is the person's: it is never logged.
import { MAX_ITEM_CHARS, MAX_ITEMS, MAX_SCRIPT_CHARS, PrompterContentSchema, type PrompterContent } from '../prompter/content'
import { isUuid, must, type StudioContext } from './context'
import { notFoundError, StudioError } from './errors'
import { getRecord, putRecord } from './records'

export const PROMPTER_COLLECTION = 'prompter'
export { MAX_ITEM_CHARS, MAX_ITEMS, MAX_SCRIPT_CHARS, PrompterContentSchema, type PrompterContent }

/** The record key for what the page asked for: `mine`, or a video of this workspace. Anything else is refused. */
export async function prompterKey(ctx: StudioContext, asked: string): Promise<string> {
  if (asked === 'mine') {
    if (!ctx.userId) throw new StudioError('Sign in to keep a script.', 403, 'FORBIDDEN')
    return `user:${ctx.userId}`
  }
  if (!isUuid(asked)) throw new StudioError('That is not a video or your own script.', 400, 'BAD_REQUEST')
  const video = must(
    await ctx.supabase.from('studio_video').select('id').eq('workspace_id', ctx.workspaceId).eq('id', asked).is('archived_at', null).maybeSingle(),
    'read that video',
  ) as { id: string } | null
  if (!video) throw notFoundError('There is no video with that id.')
  return `video:${video.id}`
}

/** The prompter kept for `asked`, or null when none was. A stored value that no longer parses reads as none. */
export async function getPrompter(ctx: StudioContext, asked: string): Promise<PrompterContent | null> {
  const value = await getRecord(ctx, PROMPTER_COLLECTION, await prompterKey(ctx, asked))
  const parsed = PrompterContentSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** Keep the prompter for `asked` (the whole of it: script and items). */
export async function savePrompter(ctx: StudioContext, asked: string, body: unknown): Promise<PrompterContent> {
  const key = await prompterKey(ctx, asked)
  const parsed = PrompterContentSchema.safeParse(body)
  if (!parsed.success) throw new StudioError(`The script can be up to ${MAX_SCRIPT_CHARS.toLocaleString('en-US')} characters, with up to ${MAX_ITEMS} checklist items of up to ${MAX_ITEM_CHARS} characters each.`, 400, 'BAD_REQUEST')
  await putRecord(ctx, PROMPTER_COLLECTION, key, parsed.data)
  return parsed.data
}
