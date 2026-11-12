import {z} from 'zod';

const id=z.string().regex(/^[a-f0-9-]{36}$/);
const finite=z.number().finite();
const rect=z.object({x:finite,y:finite,width:finite.positive(),height:finite.positive()}).strict();
const profile=z.object({profileId:id.optional(),revision:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const ManualTargetSchema=z.discriminatedUnion('kind',[
  profile.extend({kind:z.literal('native'),pid:z.number().int().positive(),windowId:z.number().int().positive()}).strict(),
  profile.extend({kind:z.literal('web'),url:z.string().url().max(2000)}).strict(),
]);
const deckId=z.string().regex(/^[a-f0-9]{64}$/);
const deviceId=z.string().min(1).max(300).regex(/^[^\0\n]+$/);
/** Punch-in: record a new take into an existing edit, replacing fromFrame..toFrame (equal = insert at that frame). */
export const PunchSchema=z.object({projectId:z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/),fromFrame:z.number().int().nonnegative(),toFrame:z.number().int().nonnegative(),
  /** Recording into storyboard placeholders: these beats' stretch is replaced, the prompter shows their lines, each beat gets its part of the take. */
  beatIds:z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)).min(1).max(100).optional(),
  /** Which camera track each extra camera feeds, in the order of extraCameras (the main camera is A). */
  extraCameraSlots:z.array(z.enum(['B','C','D'])).max(3).optional()}).strict()
  .refine(punch=>punch.toFrame>=punch.fromFrame,'Punch range ends before it starts');
export type Punch=z.infer<typeof PunchSchema>;
/** Extra pictures recorded in the same take: more app windows (e.g. iPhone Mirroring) and more cameras (e.g. Continuity Camera). */
const extraWindows=z.array(z.object({pid:z.number().int().positive(),windowId:z.number().int().positive()}).strict()).max(3);
const extraCameras=z.array(deviceId).max(3);
/** A teleprompter script (scripts.ts) shown by the floating control while recording; Next/Retake become beat markers. */
const prompterScriptId=z.string().regex(/^[A-Za-z0-9._-]{1,200}$/);
const prompter=z.object({beats:z.array(z.object({text:z.string().min(1).max(2000),seconds:finite.positive().max(600).optional(),label:z.string().max(80).optional()}).strict()).min(1).max(100)}).strict();
export const ManualStartSchema=z.object({target:ManualTargetSchema,camera:z.boolean(),microphone:z.boolean(),slidesDeckId:deckId.optional(),microphoneId:deviceId.optional(),cameraId:deviceId.optional(),punch:PunchSchema.optional(),
  extraWindows:extraWindows.optional(),extraCameras:extraCameras.optional(),prompterScriptId:prompterScriptId.optional(),countdownSeconds:z.number().int().min(0).max(10).optional()}).strict();
export const ManualNativeWindowSchema=z.object({windowId:z.number().int().positive(),title:z.string().max(250),frame:rect,displayId:z.number().int().positive(),scale:finite.positive().max(4)}).strict();
export const ManualNativeTargetSchema=z.object({pid:z.number().int().positive(),bundleId:z.string().min(1).max(300),appPath:z.string().startsWith('/').endsWith('.app').max(4096),name:z.string().min(1).max(300),windows:z.array(ManualNativeWindowSchema).max(100)}).strict();
export const ManualSessionSchema=z.object({schemaVersion:z.literal(1),id,target:ManualTargetSchema,camera:z.boolean(),microphone:z.boolean(),slidesDeckId:deckId.optional(),microphoneId:deviceId.optional(),cameraId:deviceId.optional(),punch:PunchSchema.optional(),
  extraWindows:extraWindows.optional(),extraCameras:extraCameras.optional(),prompterScriptId:prompterScriptId.optional(),countdownSeconds:z.number().int().min(0).max(10).optional(),
  status:z.enum(['preparing','countdown','recording','finalizing','completed','failed','cancelled','interrupted']),
  createdAt:z.string().datetime(),countdownEndsAt:z.string().datetime().optional(),startedAt:z.string().datetime().optional(),elapsedMs:finite.nonnegative(),
  error:z.string().max(1000).optional(),note:z.string().max(300).optional(),receipt:z.object({path:z.string(),rawScreenPath:z.string().optional(),rawCameraPath:z.string().optional(),tracePath:z.string().optional(),audioSources:z.object({application:z.enum(['observed','silent','incomplete']),microphone:z.enum(['observed','disabled','incomplete'])}).optional()}).strict().optional(),
  screenAssetId:z.string().optional(),cameraAssetId:z.string().optional(),partialAssetId:z.string().optional(),projectId:z.string().optional(),
}).strict();
export type ManualSessionValue=z.infer<typeof ManualSessionSchema>;
export const ManualWorkerRequestSchema=z.object({schemaVersion:z.literal(1),sessionId:id,dataRoot:z.string().startsWith('/').max(4096),
  target:ManualTargetSchema,camera:z.boolean(),microphone:z.boolean(),slidesDeckId:deckId.optional(),microphoneId:deviceId.optional(),cameraId:deviceId.optional(),punch:PunchSchema.optional(),selectedNative:ManualNativeTargetSchema.optional(),
  extraWindows:extraWindows.optional(),extraCameras:extraCameras.optional(),prompterScriptId:prompterScriptId.optional(),prompter:prompter.optional(),countdownSeconds:z.number().int().min(0).max(10).optional()}).strict();
export type ManualWorkerRequest=z.infer<typeof ManualWorkerRequestSchema>;
export const ManualWorkerReceiptSchema=z.object({schemaVersion:z.literal(1),status:z.enum(['completed','failed','cancelled']),
  recordingAttempted:z.boolean(),recordingFinalized:z.boolean(),usable:z.boolean(),candidateFile:z.enum(['master.mp4','partial.mp4']).nullable(),
  rawScreenFile:z.literal('raw.mov').nullable(),rawCameraFile:z.literal('camera-raw.mov').nullable(),traceFile:z.literal('events.json').nullable(),
  panelReceiptFile:z.literal('panel-receipt.json').nullable(),screenT0:finite.nullable(),screenEnd:finite.nullable(),
  audio:z.object({application:z.enum(['observed','silent','incomplete']),microphone:z.enum(['observed','disabled','incomplete']),microphoneRequested:z.boolean(),applicationSamples:z.number().int().nonnegative(),microphoneSamples:z.number().int().nonnegative()}).strict().nullable(),
  media:z.object({width:z.number().int().positive(),height:z.number().int().positive(),fps:finite.positive(),frames:z.number().int().positive(),durationSeconds:finite.positive(),bytes:z.number().int().positive(),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable(),
  error:z.string().nullable(),cleanupErrors:z.array(z.string()),
  /** Extra windows/cameras that finalized on the screen clock (file names inside the session folder). */
  extras:z.array(z.object({kind:z.enum(['window','camera']),name:z.string().min(1).max(200),file:z.string().regex(/^extra-(?:window|camera)-[1-6]\.mov$/),firstPTS:finite,lastPTS:finite}).strict()).max(6).optional(),
}).strict();
export type ManualWorkerReceipt=z.infer<typeof ManualWorkerReceiptSchema>;
