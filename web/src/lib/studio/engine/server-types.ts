// Shapes the Studio's server hands to its UI. The engine files beside this one are pure (no database, no files);
// these are the types of what the server-side stores (src/lib/studio/server) answer with.
import { z } from 'zod';
import type { Storyboard } from './storyboard';

/** One video as the Projects screen lists it. */
export type ProjectSummary = { id: string; title: string; updatedAt: string; durationSeconds: number; clipCount: number; hasCamera: boolean; hasSlides: boolean; thumbnail: { assetId: string; seconds: number }; width: number; height: number; castCount: number };

// A Studio project groups videos made with the same people, brand and media; each video can have several outputs
// (the same video reframed for other formats). The project owns what its videos share: the cast, the brand and notes.
export type StudioCast = NonNullable<Storyboard['cast']>;
export const adStatuses = ['draft', 'review', 'approved'] as const;
export type AdStatus = typeof adStatuses[number];
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const AdSchema = z.object({ id, status: z.enum(adStatuses).default('draft'), variantOf: id.optional() }).strict();
export const CampaignBrandSchema = z.object({ name: z.string().max(120).optional(), colors: z.array(z.object({ name: z.string().max(60), hex: z.string().regex(/^#[\da-fA-F]{6}$/) }).strict()).max(24).optional(),
  fonts: z.array(z.string().min(1).max(80)).max(8).optional(), logoAssetId: id.optional(), kitDir: z.string().max(1000).optional() }).strict();
export const CampaignSchema = z.object({ id, title: z.string().min(1).max(160), client: z.string().max(160).optional(), notes: z.string().max(20_000).optional(),
  brand: CampaignBrandSchema.optional(), cast: z.array(z.unknown()).max(40).optional(), ads: z.array(AdSchema).max(500), createdAt: z.string(), updatedAt: z.string() }).strict();
export type CampaignAd = z.infer<typeof AdSchema>;
export type CampaignBrand = z.infer<typeof CampaignBrandSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;
/** What the Projects screen and a project's overview show. `single` projects are videos not filed in one yet. */
export type CampaignSummary = Omit<Campaign, 'ads' | 'cast'> & { single: boolean; castCount: number; updatedAt: string; logoFile?: string;
  ads: (ProjectSummary & { status: AdStatus; variantOf?: string })[] };

export type VoiceoverInfo = { voiceName: string; voiceId: string; modelId: string };
export type VoiceoverPreview = VoiceoverInfo & { cached: boolean; characters: number; requestHash: string };

type Box = { x: number; y: number; width: number; height: number };
export type VisualIssueKind = 'covers-face' | 'covers-person' | 'low-contrast' | 'small-text' | 'off-frame';
export type VisualIssue = { kind: VisualIssueKind; layerId: string; name: string; from: number; to: number; worst: number; box: Box; detail: string };
export type VisualReport = { projectId: string; digest: string; checkedAt: string; times: number[]; issues: VisualIssue[]; sheet?: string; folder: string };

// What a video cost end to end. Each charge belongs to one video, by the strongest evidence.
export type CostProvider = 'higgsfield' | 'elevenlabs' | 'claude';
export type CostCharge = { id: string; provider: CostProvider; at: string; credits: number; model: string; kind: string; detail?: string; jobId?: string; textKey?: string; usd?: number };
export type CostTag = { projectId: string; provider: CostProvider; at: string; jobId?: string; textKey?: string };
export type CostFocus = { projectId: string; at: string };
export type CostEntry = CostCharge & { usd: number; projectId: string | null; via: 'manual' | 'tag' | 'asset' | 'focus' | 'activity' | 'session' | 'none' };
export type CostRates = { higgsfield: { usdPerCredit: number; plan?: string }; elevenlabs: { usdPerCredit: number; plan?: string } };
export type CostSummary = { projectId: string; usd: number; syncedAt?: string; warnings: string[]; rates: CostRates;
  providers: { provider: CostProvider; credits: number; usd: number; count: number }[];
  models: { provider: CostProvider; model: string; kind: string; count: number; credits: number; usd: number }[];
  entries: CostEntry[]; unassigned: CostEntry[] };
export const defaultRates: CostRates = { higgsfield: { usdPerCredit: 59 / 1200, plan: 'Plus, monthly' }, elevenlabs: { usdPerCredit: 6 / 30000, plan: 'Starter' } };
