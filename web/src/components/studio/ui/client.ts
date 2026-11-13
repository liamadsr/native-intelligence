// The Studio's calls to its server (src/app/api/account/studio). Who is asking is the app's own session; nothing
// here carries a token of its own.
//
// A file never goes through the app's routes: it is cut into parts, each put straight into storage through a link
// the server signs (POST /uploads), and then the server is told what the upload is for (import, presenter, slides).
// Turning it into a library asset is a job (probing it, conforming a recording), which the server waits on for a
// while; when it is still running at the end of that wait, the job is polled here until it is done.
import type { EditorBootstrap, EditorJob } from '@/lib/studio/engine/api';
import { STUDIO_API } from '../studio-env';
import { noteStudioCall } from '../studio-changes';

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = body === undefined ? await fetch(path) : await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return said(body === undefined ? 'GET' : 'POST', path, await decode<T>(response));
}
/** A call that succeeded: when it changed the list of videos and Studio projects, the Studio card hears it (../studio-changes.ts). */
function said<T>(method: string, path: string, answer: T): T { noteStudioCall(method, path); return answer; }
async function decode<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({ error: `Request failed (${response.status})` }));
  // The code travels with the sentence: the Studio shows a page of its own for some (STUDIO_NOT_SET_UP).
  if (!response.ok) throw Object.assign(new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`), { code: typeof data.code === 'string' ? data.code : undefined });
  return data as T;
}
/** What the Studio opens with. `videoId`: the video to open on, when the page was asked for one (else the most recent). */
export async function bootstrap(videoId?: string | null): Promise<EditorBootstrap> { return request<EditorBootstrap>(`${STUDIO_API}/bootstrap${videoId ? `?video=${encodeURIComponent(videoId)}` : ""}`); }
export async function saveProject<T>(id: string, project: unknown, expectedDigest: string | null): Promise<T> {
  return put<T>(`${STUDIO_API}/projects/${encodeURIComponent(id)}`, { project, expectedDigest });
}
export async function remove<T>(path: string): Promise<T> {
  return said('DELETE', path, await decode<T>(await fetch(path, { method: 'DELETE' })));
}
export async function put<T>(path: string, body: unknown): Promise<T> {
  return said('PUT', path, await decode<T>(await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
}

type UploadPart = { index: number; bytes: number; url: string; headers: Record<string, string> };
type UploadTicket = { uploadKey: string; partBytes: number; parts: UploadPart[] };
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Put one part, trying again a few times: a long upload should survive a dropped connection. */
async function putPart(part: UploadPart, body: Blob): Promise<void> {
  let failure: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(part.url, { method: 'PUT', headers: part.headers, body });
      if (response.ok) return;
      failure = new Error(`Upload failed (${response.status})`);
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (error) { failure = error; }
    await sleep(600 * 2 ** attempt);
  }
  throw failure instanceof Error ? failure : new Error('Upload failed');
}

/** Upload a file's bytes to storage. Answers the key the server knows the upload by. */
export async function uploadFile(file: Blob, name: string, onProgress?: (fraction: number) => void): Promise<string> {
  const ticket = await request<UploadTicket>(`${STUDIO_API}/uploads`, { name, bytes: file.size, contentType: file.type || 'application/octet-stream' });
  let sent = 0;
  for (const part of ticket.parts) {
    const start = part.index * ticket.partBytes;
    await putPart(part, file.slice(start, start + part.bytes));
    sent += part.bytes;
    onProgress?.(file.size ? sent / file.size : 1);
  }
  return ticket.uploadKey;
}

/** A job's row until it is finished. A failed or cancelled one throws what went wrong. */
export async function finishedJob(id: string, every = 900): Promise<EditorJob> {
  for (;;) {
    const { job } = await request<{ job: EditorJob }>(`${STUDIO_API}/jobs/${encodeURIComponent(id)}`);
    if (job.status === 'completed') return job;
    if (job.status === 'failed') throw new Error(job.error || 'That did not finish.');
    if (job.status === 'cancelled') throw new Error('Cancelled.');
    await sleep(every);
  }
}

/** Upload a file, then have the server turn it into what `kind` makes of it. */
async function consume<T extends object>(kind: 'import' | 'presenter/import' | 'slides/import', file: Blob, name: string, pick: (job: EditorJob) => T): Promise<T> {
  const uploadKey = await uploadFile(file, name);
  const answer = await request<T & { job?: EditorJob }>(`${STUDIO_API}/${kind}?wait=1`, { uploadKey, name });
  // Still running when the server stopped waiting: follow the job to its end.
  if (answer.job && answer.job.status !== 'completed') return pick(await finishedJob(answer.job.id));
  return answer;
}
const assetOf = <T,>(job: EditorJob) => ({ asset: job.asset, ...(job.result as object | undefined) }) as T;

export async function importPresenter<T extends object>(file: Blob, name: string): Promise<T> { return consume<T>('presenter/import', file, name, assetOf<T>); }
export async function importSlides<T extends object>(file: File): Promise<T> { return consume<T>('slides/import', file, file.name, job => (job.result ?? {}) as T); }
export async function importFile<T extends object>(file: File): Promise<T> { return consume<T>('import', file, file.name, assetOf<T>); }
