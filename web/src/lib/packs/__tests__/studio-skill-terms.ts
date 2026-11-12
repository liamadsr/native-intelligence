/**
 * The backticked words the Studio skills (621, 626's and 629's rewrites and
 * new skills) name that are not tools: the editing commands each text names
 * and the fields it names. migration-621, migration-626 and migration-629 each
 * check their own file's texts against their list (each command a real engine
 * op, each entry still used), and playbook-accuracy takes the shipped text's
 * two together as that text's NOT_TOOLS.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The editing commands `edit_studio_video` takes: the Studio engine's ops, read from its source. */
export const STUDIO_ENGINE_OPS: ReadonlySet<string> = new Set(
  [...readFileSync(join(process.cwd(), 'src/lib/studio/engine/ops.ts'), 'utf8').matchAll(/\bop\(\{ name: '([a-z_]+)'/g)].map((m) => m[1]),
)

/**
 * Per text, the backticked words that are not tools: the editing commands it
 * names (each must be a real engine op) and the fields it names. Keep each to
 * what its text uses (a test fails on a stale entry).
 */
export const STUDIO_TERMS: Record<string, { ops: readonly string[]; words: readonly string[] }> = {
  'studio-playbook': { ops: ['set_canvas', 'set_format'], words: ['args', 'brand', 'edits', 'expected_digest', 'op', 'target', 'times'] },
  'studio-editing-layers': {
    ops: [
      'add_arrow', 'add_background', 'add_callout', 'add_card', 'add_chips', 'add_icons', 'add_image', 'add_kinetic_captions', 'add_notification',
      'add_particles', 'add_ring', 'add_scene', 'add_text', 'add_waveform', 'list_layers', 'remove_layer', 'update_layer',
    ],
    words: ['edits', 'expected_digest'],
  },
  'studio-picture-and-shots': {
    ops: [
      'add_background', 'add_callout', 'add_kinetic_captions', 'add_transition', 'add_zoom', 'clear_automation', 'list_shots', 'set_automation',
      'set_canvas', 'set_format', 'set_frame', 'set_shot', 'set_transition', 'style_captions',
    ],
    words: [],
  },
  'studio-motion-design': { ops: ['set_canvas', 'set_master'], words: ['brand'] },
  'studio-motion-particles': { ops: ['add_chips', 'add_icons', 'add_particles', 'set_automation'], words: [] },
  'studio-motion-recipes': { ops: ['add_chips', 'add_icons', 'add_image', 'add_notification', 'add_text'], words: [] },
  'studio-type-and-graphics': { ops: ['add_text', 'add_waveform', 'set_automation'], words: [] },
  'studio-brand': { ops: [], words: ['brand'] },
  'studio-script-writing': { ops: ['split_beat', 'storyboard_from_script', 'update_beat'], words: [] },
  'studio-storyboard': {
    ops: ['add_beat', 'lock_beat', 'remove_beat', 'reorder_beats', 'set_shot', 'set_style_pack', 'split_beat', 'storyboard', 'storyboard_from_script', 'update_beat'],
    words: [],
  },
  'studio-style-packs': { ops: ['add_background', 'add_card', 'add_chips', 'add_text', 'set_style_pack'], words: [] },
  'studio-style-pack-editorial-archival': { ops: ['add_image', 'add_text', 'set_automation', 'set_style_pack', 'set_transition'], words: [] },
  'studio-style-pack-paper-collage': { ops: ['add_image', 'add_transition', 'set_automation', 'set_style_pack', 'update_layer'], words: [] },
  'studio-style-pack-orbital': { ops: ['add_particles', 'add_ring', 'set_style_pack'], words: [] },
  'studio-style-pack-warm-loft': { ops: ['set_style_pack', 'set_transition'], words: [] },
  'studio-reference-to-style-pack': { ops: ['add_image', 'set_style_pack'], words: [] },
  'studio-review': { ops: ['set_master'], words: [] },
  'studio-match-a-reference': { ops: ['add_image'], words: [] },
  'studio-motion-ads': { ops: ['add_background', 'add_image', 'add_text', 'add_transition', 'set_automation'], words: ['brand'] },
  'studio-generated-shots': { ops: ['remove_cast', 'set_cast', 'update_beat'], words: [] },
  'studio-sound': { ops: ['set_audio_segment', 'set_automation', 'set_ducking', 'set_master'], words: [] },
  'studio-scene-design': { ops: ['add_text'], words: [] },
  'studio-product-ui': { ops: ['add_image'], words: [] },
  'studio-product-onboarding': { ops: [], words: [] },
}

/**
 * The same, for the texts 626 writes: the sixteen 621 rows it rewrites whole
 * and its five new skills. migration-626 holds 626's texts to these exactly
 * (each command real, each entry used); 621's own list above stays the record
 * of 621.
 */
export const STUDIO_TERMS_626: Record<string, { ops: readonly string[]; words: readonly string[] }> = {
  'studio-playbook': { ops: ['set_canvas'], words: ['args', 'brand', 'edits', 'expected_digest', 'op', 'target', 'times'] },
  'studio-editing-layers': STUDIO_TERMS['studio-editing-layers'],
  'studio-picture-and-shots': STUDIO_TERMS['studio-picture-and-shots'],
  'studio-motion-design': { ops: ['set_canvas', 'set_master'], words: ['brand'] },
  'studio-type-and-graphics': { ops: ['add_text', 'add_waveform', 'set_automation'], words: [] },
  'studio-brand': { ops: [], words: ['brand'] },
  'studio-script-writing': { ops: ['split_beat', 'storyboard_from_script', 'update_beat'], words: [] },
  'studio-storyboard': {
    ops: ['add_beat', 'lock_beat', 'remove_beat', 'reorder_beats', 'set_style_pack', 'split_beat', 'storyboard', 'storyboard_from_script', 'update_beat'],
    words: [],
  },
  'studio-style-packs': { ops: ['add_background', 'add_card', 'add_chips', 'add_text', 'set_style_pack'], words: [] },
  'studio-style-pack-warm-loft': { ops: ['set_style_pack', 'set_transition'], words: [] },
  'studio-reference-to-style-pack': { ops: ['add_image', 'set_style_pack'], words: [] },
  'studio-review': { ops: ['set_master'], words: [] },
  'studio-match-a-reference': { ops: ['add_image'], words: [] },
  'studio-motion-ads': { ops: [], words: ['needs'] },
  'studio-generated-shots': { ops: ['remove_cast', 'set_cast', 'update_beat'], words: [] },
  'studio-sound': { ops: ['set_audio_segment', 'set_automation', 'set_ducking', 'set_master'], words: [] },
  'studio-static-ads': { ops: [], words: ['needs'] },
  'studio-reels': { ops: ['add_image'], words: ['needs'] },
  'studio-narration': { ops: ['add_kinetic_captions', 'set_ducking', 'set_master'], words: [] },
  'studio-measured-checks': { ops: [], words: [] },
  'studio-director-and-cut-outs': { ops: ['add_text', 'set_automation', 'set_format', 'set_shot', 'update_layer'], words: [] },
}

/**
 * The same, for the texts 629 writes: the fourteen rows it rewrites whole
 * (from 621 or 626) and its three new skills. migration-629 holds 629's texts
 * to these exactly (each command real, each entry used).
 */
export const STUDIO_TERMS_629: Record<string, { ops: readonly string[]; words: readonly string[] }> = {
  'studio-playbook': { ops: ['set_canvas'], words: ['args', 'brand', 'edits', 'expected_digest', 'op', 'target', 'times'] },
  'studio-picture-and-shots': {
    ops: [
      'add_background', 'add_callout', 'add_kinetic_captions', 'add_transition', 'add_zoom', 'clear_automation', 'list_shots', 'set_automation',
      'set_canvas', 'set_format', 'set_frame', 'set_shot', 'set_transition', 'style_captions',
    ],
    words: [],
  },
  'studio-motion-design': { ops: ['set_canvas', 'set_master'], words: ['brand'] },
  'studio-type-and-graphics': { ops: ['add_text', 'add_waveform', 'set_automation'], words: [] },
  'studio-brand': { ops: [], words: ['brand'] },
  'studio-script-writing': { ops: ['split_beat', 'storyboard_from_script', 'update_beat'], words: [] },
  'studio-storyboard': {
    ops: ['add_beat', 'lock_beat', 'remove_beat', 'reorder_beats', 'set_style_pack', 'split_beat', 'storyboard', 'storyboard_from_script', 'update_beat'],
    words: [],
  },
  'studio-reference-to-style-pack': { ops: ['add_image', 'set_style_pack'], words: [] },
  'studio-match-a-reference': { ops: ['add_image'], words: [] },
  'studio-generated-shots': { ops: ['remove_cast', 'set_automation', 'set_cast', 'update_beat'], words: [] },
  'studio-sound': { ops: ['set_audio_segment', 'set_automation', 'set_ducking', 'set_master'], words: [] },
  'studio-scene-design': {
    ops: [
      'add_arrow', 'add_background', 'add_card', 'add_chips', 'add_icons', 'add_image', 'add_notification', 'add_particles', 'add_ring', 'add_text',
      'add_waveform', 'set_automation',
    ],
    words: [],
  },
  'studio-product-ui': { ops: ['add_background', 'add_callout', 'add_image', 'add_zoom'], words: [] },
  'studio-product-onboarding': { ops: [], words: [] },
  'studio-media-in': { ops: [], words: [] },
  'studio-reference-blueprint': { ops: ['storyboard_from_script', 'style_captions'], words: [] },
  'studio-story-film': { ops: ['set_cast'], words: [] },
}

/** Per Studio text that ships, its terms: the latest file's that wrote the text (629 over 626 over 621). */
export const STUDIO_SHIPPED_TERMS: Record<string, { ops: readonly string[]; words: readonly string[] }> = {
  ...STUDIO_TERMS,
  ...STUDIO_TERMS_626,
  ...STUDIO_TERMS_629,
}

/** A shipped Studio text's non-tool words for playbook-accuracy: its commands and its fields together, each once. */
export function studioNotTools(): Record<string, readonly string[]> {
  return Object.fromEntries(Object.entries(STUDIO_SHIPPED_TERMS).map(([slug, t]) => [slug, [...new Set([...t.ops, ...t.words])].sort()]))
}
