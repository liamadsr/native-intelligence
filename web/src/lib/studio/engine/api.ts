import { assetHref } from './asset-base';
import type { EditorAsset, EditorPreset, EditorProject, EditorTranscript } from './contracts';
export type EditorJob = { id: string; kind: 'export' | 'transcribe' | 'model-download' | 'cutout' | 'sounds' | 'listen' | 'motion' | 'component'; result?: unknown; status: 'running' | 'completed' | 'failed' | 'cancelled'; progress: number; logs: string[]; error?: string; downloadUrl?: string; /** An export's: rendered on the person's own computer (the desktop app) or on the server. */ where?: 'computer' | 'server'; /** An export made on the person's computer and kept there (no file on the server to download). */ kept?: 'computer'; /** The saved video the job is for (an export, a shot), when it names one. */ videoId?: string; asset?: EditorAsset; assetId?: string; sourceSha256?: string; transcript?: EditorTranscript; outcome?: 'transcribed' | 'no-speech' | 'no-audio'; cached?: boolean; modelPath?: string; };
export type EditorBootstrap = { project: EditorProject | null; projectDigest: string | null; projects: { id: string; title: string }[]; presets: EditorPreset[]; assets: EditorAsset[]; job: EditorJob | null };
/** Manual sessions are independent of scripts, app profiles, and the currently open edit. */
export type ManualNativeWindow = { windowId: number; title: string; frame: { x: number; y: number; width: number; height: number }; displayId: number; scale: number };
export type ManualNativeTarget = { pid: number; bundleId: string; appPath: string; name: string; windows: ManualNativeWindow[] };
export type ManualTarget = { kind: 'native'; pid: number; windowId: number; profileId?: string; revision?: string } | { kind: 'web'; url: string; profileId?: string; revision?: string };
export type ManualTargetCatalog = { native: ManualNativeTarget[]; desktopProfiles: { id: string; revision: string; name: string; appPath: string; runningPids: number[] }[]; webProfiles: { id: string; revision: string; name: string; url: string }[] };
export type ManualSessionStatus = 'preparing' | 'countdown' | 'recording' | 'finalizing' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type ManualDevice = { id: string; name: string; isDefault: boolean };
export type ManualDevices = { microphones: ManualDevice[]; cameras: ManualDevice[]; error?: string };
export type ManualSession = { schemaVersion: 1; id: string; target: ManualTarget; camera: boolean; microphone: boolean; extraWindows?: { pid: number; windowId: number }[]; extraCameras?: string[]; slidesDeckId?: string; microphoneId?: string; cameraId?: string; punch?: { projectId: string; fromFrame: number; toFrame: number }; note?: string; status: ManualSessionStatus; createdAt: string; countdownEndsAt?: string; countdownRemaining?: number; startedAt?: string; elapsedMs: number; error?: string; receipt?: { path: string; rawScreenPath?: string; rawCameraPath?: string; tracePath?: string; audioSources?: { application: 'observed' | 'silent' | 'incomplete'; microphone: 'observed' | 'disabled' | 'incomplete' } }; screenAssetId?: string; cameraAssetId?: string; partialAssetId?: string; projectId?: string };
// GET /api/manual/targets (read-only); POST /api/manual/sessions {target:ManualTarget,camera:boolean,microphone:boolean} => {session};
// GET /api/manual/sessions => {sessions}; GET /api/manual/sessions/:id => {session};
// POST /api/manual/sessions/:id/stop or /cancel => {session}. Stop and cancel are idempotent.
// GET /api/slides => {decks:SlideDeckSummary[]}; POST /api/slides/import (raw PDF body, X-File-Name) => {deck}. Pass slidesDeckId to manual start.
// POST /api/manual/sessions/:id/open-partial => {project,session}; explicit new edit from a verified partial only.
export type EditorWallpaper = { id: string; name: string; family: string; category: string; available: boolean; unavailableReason?: string; thumbnailUrl?: string; width?: number; height?: number; variant?: string; sourceKind: 'image' | 'dynamic-still' | 'video-still' };
export type EditorWallpaperCatalog = { wallpapers: EditorWallpaper[]; availableCount: number; unavailableCount: number; notes: string[] };
// GET /api/bootstrap; GET /api/projects/:id; PUT /api/projects/:id {project}
// POST /api/import raw File bytes, X-File-Name (URI encoded), response {asset}
// POST /api/export {project}, response {job}; GET /api/jobs/:id
// POST /api/jobs/:id/cancel {}; POST /api/presets {name,presentation,cursor}, response {preset}
// Asset URLs: /assets/<digest>.<extension>. Mutation header: X-Editor-Token from bootstrap.
export const assetUrl = (asset: EditorAsset) => assetHref(asset.file);
// GET /api/projects => {projects: ProjectSummary[]}; POST /api/projects/:id/duplicate|rename {title}; DELETE /api/projects/:id (moves to trash); GET /api/projects/:id/thumbnail.jpg
export type { ProjectSummary, CampaignSummary, AdStatus, VoiceoverInfo, VoiceoverPreview } from './server-types';
// GET /api/campaigns => {campaigns}; GET /api/campaigns/for/:videoId => {campaign}; POST /api/campaigns {title, projectIds?}; POST /api/campaigns/:id {title?, client?, notes?, brand?};
// POST /api/campaigns/:id/ads {projectId, variantOf?}; POST /api/campaigns/:id/new-ad {from?} | {width, height, fps?, seconds?}; POST /api/campaigns/:id/dissolve; POST /api/projects/:id/status {status} | unfile

export type { VoiceoverResult } from './transcript';
// POST /api/transcripts/attach {assetId}, /api/transcripts/import {assetId,document} => {transcript}
// GET /api/voiceover, POST /api/voiceover/preview {text}, POST /api/voiceover/generate {text,allowPaid}
export type LocalTranscriptionConfig = { modelPath: string; runtimePath: string; backend: 'faster-whisper' | 'whisper.cpp' };
export type LocalTranscriptionInfo = { config: LocalTranscriptionConfig | null; ready: boolean; serviceFee: 0; error?: string; modelFingerprint?: string; runtime?: { backend: LocalTranscriptionConfig['backend']; version: string } };
// GET /api/transcription/config => LocalTranscriptionInfo
// PUT /api/transcription/config {modelPath,runtimePath?,backend?} => LocalTranscriptionInfo (validates before saving)
// POST /api/transcripts/transcribe {assetId} => {job}; poll/cancel through existing /api/jobs routes.
export type LocalModelCatalog = { models: { id: 'large-v3'; name: string; path: string; bytes: number; sha256: string; available: boolean }[]; locations: { label: string; path: string }[] };
export type LocalModelDirectory = { path: string; parentPath: string | null; entries: { name: string; path: string; kind: 'directory' | 'model'; bytes?: number }[]; truncated: boolean };
// GET /api/transcription/models => LocalModelCatalog
// POST /api/transcription/models/browse {path?} => LocalModelDirectory, metadata only, no recursive search
// POST /api/transcription/models/download {modelId:'large-v3'} => {job}, explicit download only
export type AppElementSelector =
  | { role: string; name?: string; exact?: boolean; hasText?: string }
  | { label: string }
  | { placeholder: string }
  | { text: string; exact?: boolean }
  | { testid: string; hasText?: string }
  | { css: string; hasText?: string }
  | { find: AppElementSelector; within?: AppElementSelector; near?: string; nth?: number };
export type AppTarget = { kind: 'web'; baseUrl: string } | { kind: 'dial8-desktop'; appPath: string; bundleId: 'ai.dial8.desktop' };
export type AppProfileElement = { id: string; selector: AppElementSelector; source?: { repoPath: string; file: string; line?: number; revision?: string }; note?: string };
export type AppProfile = { schemaVersion: 1; id: string; revision: string; name: string; repoPaths: string[]; authoredRepoRevisions: Record<string, string | null>; target: AppTarget; viewport: { width: number; height: number; scale: number }; elements: AppProfileElement[] };
export type AppProfileStatus = { stale: boolean; repos: { path: string; authoredRevision: string | null; currentRevision: string | null; stale: boolean; error?: string }[]; target: { kind: AppTarget['kind']; available: boolean; reason?: string }; elements: { id: string; state: 'unvalidated' | 'validated' | 'stale' | 'failed'; checkedAt?: string }[] };
export type AppProfileSummary = { id: string; name: string; revision: string; targetKind: AppTarget['kind']; stale: boolean };
export type AppProfileInspect = { repos: { path: string; revision: string | null; available: boolean; error?: string }[]; target: { kind: AppTarget['kind']; available: boolean; reason?: string }; ready: boolean };
export type AppProfileBrowse = { path: string; parentPath: string | null; entries: { name: string; path: string; kind: 'directory' | 'app' }[]; truncated: boolean };

export type SlideDeckSummary = { schemaVersion: 1; id: string; name: string; pageAssetIds: string[]; width: number; height: number; createdAt: string };
