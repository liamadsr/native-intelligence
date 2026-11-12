/**
 * Free space in the work folder. A render that writes a PNG per frame (the motion ads' and the reels' type layers)
 * first checks there is room, so a long piece fails with a sentence instead of filling the disk the other jobs and
 * the asset cache share.
 */
import { statfs } from 'node:fs/promises'
import { JobError } from './jobs/context.ts'

/** The least free space a frame-by-frame render starts with. */
export const MIN_FREE_BYTES = 2 * 1024 ** 3

/** Bytes free to this process where `dir` is. */
export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize)
}

/** Throws a sentence when `dir` has less than `min` bytes free. `free` is replaceable for tests. */
export async function needSpace(dir: string, min = MIN_FREE_BYTES, free: (dir: string) => Promise<number> = freeBytes): Promise<void> {
  const have = await free(dir)
  if (have < min) throw new JobError(`The worker's disk has ${(have / 1024 ** 3).toFixed(1)} GB free; this render needs at least ${(min / 1024 ** 3).toFixed(0)} GB for its frames. Try again when other work has finished.`)
}
