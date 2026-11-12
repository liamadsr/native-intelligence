// Font names, with nothing that draws: which family a text style means, and the shape of a face the composition
// loads. Kept apart from font-faces.ts (which loads faces through the player's font loader) so server code can use
// these names without pulling the player in.
export type FontFace = { family: string; file: string; weight: string; style: 'normal' | 'italic' };
/** What the five generic names mean now: modern families, downloaded on first use (Fontshare / Google Fonts). */
export const DEFAULT_FAMILIES = { sans: 'Inter', display: 'Satoshi', heavy: 'Clash Display', serif: 'Instrument Serif', mono: 'JetBrains Mono' } as const;
export type GenericFont = keyof typeof DEFAULT_FAMILIES;
export const familyOf = (font?: string) => font && font in DEFAULT_FAMILIES ? DEFAULT_FAMILIES[font as GenericFont] : font?.trim() || DEFAULT_FAMILIES.sans;
const fallback = (font?: string) => font === 'serif' ? 'Georgia, "Times New Roman", serif' : font === 'mono' ? '"SF Mono", Menlo, monospace' : '"Inter", "SF Pro Display", Helvetica, Arial, sans-serif';
export const fontStack = (font?: string) => `"${familyOf(font)}", ${fallback(font)}`;
