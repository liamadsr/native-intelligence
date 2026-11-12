// Small helpers the Projects screen and a project's overview share: an ad's shape and status, as words.
import type { AdStatus } from '@/lib/studio/engine/api';

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
/** 1080×1920 → 9:16, 1080×1350 → 4:5, 1920×1080 → 16:9. */
export function ratio(width: number, height: number) { if (!width || !height) return ''; const g = gcd(width, height); return `${width / g}:${height / g}`; }
export const statusLabel: Record<AdStatus, string> = { draft: 'Draft', review: 'In review', approved: 'Approved' };
/** Blank ads in the shapes ads are made in. */
export const adShapes = [{ label: 'Reel or Story (9:16)', width: 1080, height: 1920 }, { label: 'Feed (4:5)', width: 1080, height: 1350 }, { label: 'Square (1:1)', width: 1080, height: 1080 }, { label: 'Landscape (16:9)', width: 1920, height: 1080 }];
