import { tool } from 'ai'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { isRefusal, studioContext, studioRefusal, type StudioRefusal } from '@/lib/studio/agent/access'
import { MOTION_TEMPLATES, SIZE_KEYS, STATIC_TEMPLATES, STATIC_TEMPLATE_IDS, TEMPLATE_ROLES } from '@/lib/studio/server/ads-contract'
import type { StudioContext } from '@/lib/studio/server/context'

/** How long a make_ tool waits for its job before answering with the job to wait on. */
const WAIT_MS = 100_000

/** The static templates, as the agent reads them: id, the pattern, what it draws, what copy and images it needs. */
const TEMPLATE_GUIDE = STATIC_TEMPLATE_IDS.map((id) => {
  const t = STATIC_TEMPLATES[id]
  const image = t.image === 'one' ? 'image' : t.image === 'many' ? 'images (1–6)' : 'no image'
  return `${id} (${t.pattern}; ${image}; copy ${t.copy.join(', ')}${t.optional.length ? `, optional ${t.optional.join(', ')}` : ''}): ${t.draws}`
}).join(' | ')

const BATCH_FORMAT =
  'batch = {id (letters, numbers, - _; the same id again replaces that batch), title?, ads: [{id, pattern (the playbook pattern, e.g. "AD-1"), template, copy: {field: string or array of lines}, ' +
  'image?: {src, focus?: [x, y] 0–1}, images?: [{src}], ground? (a ground colour: ground, groundAlt, deep or ink, or a palette token), ink? (statement, caps-photo: white (default), ink for dark type on a light photo, or ground), ' +
  'layout? (statement: center | lower | corner), shade? (0–1, how hard the photo is darkened under the type), sizes? (any of square 1080×1080, portrait 1080×1350, story 1080×1920, landscape 1200×628; default all four), ' +
  'flags? (things the person must confirm before running, e.g. a price), notes?, bySize?: {story: {layout, image, copy, …}} overrides for one size}], ' +
  'people?: {"<image src>": {width, height, faces: [{x, y, w, h} as fractions of the photo], heads: [...], matte?: "<library PNG>"}}}. ' +
  'src names a library image by its id or its name in the library (list_studio_assets). Without people data the face-avoid and text-behind-the-head passes are skipped for that photo. ' +
  'Copy is the brand\'s: serif lines in sentence case (never caps), sans lines are set in caps automatically; keep headlines to 2–6 words. ' +
  `Templates: ${TEMPLATE_GUIDE}`

const BRIEF_FORMAT =
  'brief = {id, template, seconds (6–8 typical), fps? (24), title?, formats? (["9x16", "4x5"], default both), ' +
  'background: [segments in time order: {clip: "<library video>"} or {still: "<library image>"}, in?: {kind: cut | fade | light, at: seconds, duration?, softness?} (every segment after the first), ' +
  'grade?: forest | sand | mint (or a grade the kit defines), strength? (0–1: textures 1, photos ~0.5–0.6), saturation? (~0.85 for photos), contrast? (stills, ~3), levels? [lo, hi] (lift flat footage), ' +
  'speed? (>1 slows a clip), seek?, push? [from, to] and focus? [x, y] (stills), cuts? [[t, zoom]] (punch-ins on the beat)}], ' +
  'sound: {music: "<name in the kit\'s sound library>", sfx: ["<name>", {name, until: seconds}]} (tonal layers must share a key), copy: the template\'s copy}. ' +
  `cut-on-beat: ${MOTION_TEMPLATES['cut-on-beat']} Its copy: {service (the thing sold, shown ≥40 px), aside?, ink (a palette token or role), veils?: [{css: sand | sand-low | photo | forest | any CSS background, at?, until?}], ` +
  'beats: [{at, lines: [..], size (px, ~170–260), top (px from the top of 1920), leading?, enter?: rise | cut, until?, out?: cut | fade}], end: {at, lines?, size?, top?, cta, ctaAt?, logoAt?}}. ' +
  `pull-out: ${MOTION_TEMPLATES['pull-out']} Its copy: {service, aside?, panel (the panel colour), ink, hookInk, shade?, hook: {lines, at: [seconds per line], size?, top?}, line, word (ends in a full stop, the zoom pulls out of it), ` +
  'zoom?: {at, duration, from}, end: {at, cta}}. Type stays in the safe band (y 384–1498 px); the service must be named in the first second, on the last frame and for 2 s; something changes about every 1.7 s.'

const REEL_FORMAT =
  'spec = {id, title?, fps? (30), shots: [{src: "<library video>", in, out (seconds of the source), push? (0.04), slow? (1.5 plays 1.5× longer), band? [top, bottom] (the clean part of the source, fractions)}], ' +
  'beats: [{from, to (seconds on the reel), kind: statement | glass | caps, copy: {headline (string or lines), sub?, accent?, query? (glass), rows? (glass)}, bands?: [lower | center | upper] (the first no face passes through is used), depth? (headline behind the people)}], ' +
  'end?: {seconds, ground? (deep default), headline?, sub?, cta?}, split?: {at: 0.3–0.8, ground} (footage above, a ground panel with the type below), ' +
  'people?: {"<shot src>": {faces: [{t, faces: [{x, y, w, h}]}] (fractions of the 9:16 frame), matte?: "<greyscale library video, white = person>"}}}. Without faces each beat takes its first band; without a matte, depth is skipped. The reel is silent.'

const KIT_FORMAT =
  'kit = the kit\'s own shape {schemaVersion: 1, name, palette: {token: "#RRGGBB"}, roles: {' + TEMPLATE_ROLES.join(', ') + ' → palette tokens}, logoOn: {groundToken: logoToken}, logoOnPhoto?, ' +
  'logos: {primary?: {assetId}, mark?: {assetId}}, fonts: {serif: {family, brand?, standIn? (a free family drawn until the files are uploaded), faces: [{file, weight, style}], weights: {thin, light, regular}}, sans: {…, weights: {medium, bold}}}, ' +
  'rules: {copyBans: [{pattern, rule, why, unless?}], casing, logo, headlineMaxWords}, motion: {rules: {service, minPx, safe, maxHold, loudness, banned}, grades?, veils?}, sounds: {mix, sounds: {name: {src or asset, kind: music | sfx, key?, pitched?, use?, loop?, xfade?, af?, lufs?}}}}, ' +
  'OR a brand folder\'s files pasted as they are: brand.json, fonts.json, rules.json, sound.json, alone or as {"brand.json": …, "fonts.json": …}. Whatever is given is merged into the kit that is there.'

/**
 * Ads from a Studio project's brand kit (src/lib/studio/server/ads.ts, brand-kit.ts): static ads from playbook
 * templates in four sizes with a brand check, and motion ads (9:16, a 4:5 crop) that also open as editable videos.
 *
 *   get_studio_brand_kit     the kit, its logos, and what it still needs.
 *   set_studio_brand_kit     save the kit (its own shape, or a brand folder's files pasted).
 *   make_studio_static_ads   render a batch (a Studio worker job); waits a while for it.
 *   make_studio_motion_ad    render a brief (a Studio worker job) into an MP4 and an editable video; waits a while.
 *   make_studio_reel         a reel from the brand's own footage (a Studio worker job); waits a while.
 *   list_studio_ads          the batches (images by size, the brand check's findings) and the motion ads.
 *
 * Jobs still running when a make_ tool stops waiting are read with get_studio_job / wait_for_studio_job, then
 * list_studio_ads. Every refusal is `{ success: false, code, error }`; a workspace guest is refused.
 */
export function createStudioAdsTools(userId: string, workspaceId?: string) {
  const withStudio = async <T>(work: (ctx: StudioContext) => Promise<T>): Promise<T | StudioRefusal> => {
    const ctx = await studioContext(getServiceClient(), userId, workspaceId)
    if (isRefusal(ctx)) return ctx
    try {
      return await work(ctx)
    } catch (error) {
      return studioRefusal(error, 'studio_project')
    }
  }
  const projectId = z.string().describe('The Studio project (list_studio_projects)')

  /** Wait for a job a while; answer what it made, or the job to wait on. */
  const followJob = async (ctx: StudioContext, jobId: string, what: string) => {
    const { waitForJob } = await import('@/lib/studio/server/jobs')
    const row = await waitForJob(ctx, jobId, { timeoutMs: WAIT_MS, everyMs: 1500 })
    if (row.status === 'completed') return { success: true as const, done: true, job_id: jobId, result: row.result }
    if (row.status === 'failed' || row.status === 'cancelled') return { success: false as const, code: 'JOB_FAILED', error: `The ${what} ${row.status === 'failed' ? 'failed' : 'was cancelled'}${row.error ? `: ${row.error}` : '.'}` }
    return { success: true as const, done: false, job_id: jobId, note: `Still rendering (${Math.round((Number(row.progress) || 0) * 100)}%). Call wait_for_studio_job with job_id ${jobId}, then list_studio_ads; don't start another.` }
  }

  return {
    get_studio_brand_kit: tool({
      description:
        "A Studio project's brand kit: name, palette tokens, the template roles mapped to them, the approved logo colour per ground (logoOn), the logos (library images), the serif and sans font roles, the rules the brand check enforces, the motion rules and the sound library. " +
        "`needs` lists what is still missing before ads render. Read it before writing a batch or a brief: colours, sound names and grades come from it.",
      inputSchema: z.object({ project_id: projectId }),
      execute: async ({ project_id }) =>
        withStudio(async (ctx) => {
          const { getBrandKit } = await import('@/lib/studio/server/brand-kit')
          const view = await getBrandKit(ctx, project_id)
          return {
            success: true,
            project_id: view.projectId,
            kit: view.kit,
            logos: Object.fromEntries(Object.entries(view.logos).map(([slot, a]) => [slot, { asset_id: a.id, name: a.name, width: a.width, height: a.height }])),
            needs: view.needs,
          }
        }),
    }),

    set_studio_brand_kit: tool({
      description:
        `Save a Studio project's brand kit (checked; merged into the kit that is there; the project's brand summary follows). ${KIT_FORMAT} ` +
        'Logos are library PNG masks with transparency (their asset ids); the brand\'s font files are uploaded by the person on the project\'s overview page, matched to fonts.json by file name.',
      inputSchema: z.object({ project_id: projectId, kit: z.record(z.string(), z.unknown()).describe('The kit, or the brand folder files (see the description)') }),
      execute: async ({ project_id, kit }) =>
        withStudio(async (ctx) => {
          const { saveBrandKit } = await import('@/lib/studio/server/brand-kit')
          const view = await saveBrandKit(ctx, project_id, kit)
          return { success: true, project_id: view.projectId, name: view.kit?.name, colours: Object.keys(view.kit?.palette ?? {}).length, needs: view.needs }
        }),
    }),

    make_studio_static_ads: tool({
      description:
        'Render a batch of static ads from the Studio project\'s brand kit: every ad in every size it asks for, each checked against the brand (palette, TYPE-1 casing, the 9:16 safe band, logo rules, copy bans, contrast, faces kept clear of type) ' +
        'and stored as library images, with a report and a contact sheet. Waits about a minute and a half; a bigger batch answers with its job (wait_for_studio_job, then list_studio_ads). ' +
        `${BATCH_FORMAT}`,
      inputSchema: z.object({ project_id: projectId, batch: z.record(z.string(), z.unknown()).describe('The batch (see the description)') }),
      execute: async ({ project_id, batch }) =>
        withStudio(async (ctx) => {
          const { startStaticAds } = await import('@/lib/studio/server/ads')
          const { job } = await startStaticAds(ctx, project_id, batch)
          return followJob(ctx, job.id, 'batch')
        }),
    }),

    make_studio_motion_ad: tool({
      description:
        'Render a motion ad (9:16 for Reels and Stories, plus a 4:5 feed crop) from the Studio project\'s brand kit and a brief: graded background segments joined by cuts, fades or light transitions, ' +
        'a type layer in the brand\'s fonts, a sound mix from the kit\'s library, and a brand check (service timing, safe band, clipped or small type, cadence, loudness, keys, copy bans). ' +
        'It also becomes an editable video in the same Studio project (every word a text layer, each sound its own track); the result names its video_id. Waits about a minute and a half; ' +
        `if still rendering, wait_for_studio_job then list_studio_ads. Fix errors in the brief, never by loosening the rules. ${BRIEF_FORMAT}`,
      inputSchema: z.object({ project_id: projectId, brief: z.record(z.string(), z.unknown()).describe('The brief (see the description)') }),
      execute: async ({ project_id, brief }) =>
        withStudio(async (ctx) => {
          const { startMotionAd } = await import('@/lib/studio/server/ads')
          const { job } = await startMotionAd(ctx, project_id, brief)
          return followJob(ctx, job.id, 'motion ad')
        }),
    }),

    make_studio_reel: tool({
      description:
        "Render a 9:16 reel from the Studio project's own footage and brand kit: the shots cut together with a slow push, type beats in the static ads' styles (statement, a typing search panel, tracked caps), and an end card with the logo. " +
        `Stored as a library video with a strip of stills. Waits about a minute and a half; if still rendering, wait_for_studio_job then list_studio_ads. ${REEL_FORMAT}`,
      inputSchema: z.object({ project_id: projectId, spec: z.record(z.string(), z.unknown()).describe('The reel (see the description)') }),
      execute: async ({ project_id, spec }) =>
        withStudio(async (ctx) => {
          const { startReel } = await import('@/lib/studio/server/ads')
          const { job } = await startReel(ctx, project_id, spec)
          return followJob(ctx, job.id, 'reel')
        }),
    }),

    list_studio_ads: tool({
      description:
        "A Studio project's ads: static batches newest first (each ad's images by size with their library asset ids, the brand check's findings errors first, links to the report and the contact sheet) " +
        'motion ads (their editable video_id, renders, errors and report link) and reels.',
      inputSchema: z.object({ project_id: projectId }),
      execute: async ({ project_id }) =>
        withStudio(async (ctx) => {
          const { listAds } = await import('@/lib/studio/server/ads')
          const { batches, motion, reels } = await listAds(ctx, project_id)
          return {
            success: true,
            batches: batches.slice(0, 10).map((b) => ({
              batch_id: b.batchId, title: b.title, made_at: b.createdAt, errors: b.errors, links: b.links, notes: b.notes,
              ads: b.ads.map((ad) => ({
                id: ad.id, template: ad.template, pattern: ad.pattern, errors: ad.errors, flags: ad.flags,
                images: ad.images.map((i) => ({ size: i.size, asset_id: i.assetId, width: i.width, height: i.height })),
                findings: [...new Set(ad.images.flatMap((i) => i.findings.filter((f) => f.level !== 'info').map((f) => `${f.level} ${f.rule}: ${f.message}`)))].slice(0, 20),
              })),
            })),
            motion_ads: motion.slice(0, 20).map((m) => ({ brief_id: m.briefId, title: m.title, video_id: m.videoId, made_at: m.createdAt, errors: m.errors, links: m.links, notes: m.notes })),
            reels: reels.slice(0, 20).map((r) => ({ reel_id: r.reelId, title: r.title, seconds: r.seconds, asset_id: r.render.assetId, made_at: r.createdAt, links: r.links, notes: r.notes })),
          }
        }),
    }),
  }
}
