// Generations run as cheap drafts until the film is settled: every quality setting a model offers
// (resolution, mode, quality, bitrate) is pinned to its lowest option. A final pass ("final": true)
// keeps exactly what was asked for, so 1080p or 4k happens once, on the shots that made the cut.
export type ModelParam = { name: string; enum?: string[] | null; default?: unknown };
export type QualityChange = { name: string; from: unknown; to: string };

const RANK: Record<string, number> = {
  '360p': 1, '480p': 2, '540p': 3, '720p': 4, '1k': 5, '1080p': 6, '2k': 7, '1440p': 8, '4k': 9, '2160p': 9,
  std: 1, standard: 1, low: 1, medium: 2, pro: 2, high: 3, ultra: 4,
};
const QUALITY_PARAMS = new Set(['resolution', 'mode', 'quality', 'bitrate_mode']);

/** A quality knob is one whose every option we can rank (so Seedance's mode: omni_reference is left alone). */
export const qualityParams = (schema: ModelParam[]) =>
  schema.filter(p => QUALITY_PARAMS.has(p.name) && Array.isArray(p.enum) && p.enum.length > 1 && p.enum.every(v => v.toLowerCase() in RANK));

export function applyQualityTier(params: Record<string, unknown>, schema: ModelParam[]) {
  const { final, ...rest } = params; const isFinal = final === true;
  const changes: QualityChange[] = [];
  if (!isFinal) for (const p of qualityParams(schema)) {
    const lowest = [...p.enum!].sort((a, b) => RANK[a.toLowerCase()]! - RANK[b.toLowerCase()]!)[0]!;
    const current = rest[p.name] ?? p.default;
    if (current !== lowest) { changes.push({ name: p.name, from: rest[p.name] ?? `${String(p.default)} (default)`, to: lowest }); rest[p.name] = lowest; }
  }
  return { params: rest, tier: isFinal ? 'final' as const : 'draft' as const, changes };
}
