/**
 * Project header/sidebar icon: one of 10 Apple-style emoji + one of 10
 * background tones. Stored as `projects.logo_emoji` and `projects.logo_color` (each 0–9).
 */

/** Common emoji from the Apple keyboard set — single grapheme each. */
export const PROJECT_LOGO_EMOJIS = [
  '📁',
  '💡',
  '🚀',
  '⚙️',
  '🎯',
  '📌',
  '🧩',
  '✨',
  '🌐',
  '🔧',
] as const;

export const PROJECT_LOGO_EMOJI_COUNT = PROJECT_LOGO_EMOJIS.length;
export const PROJECT_LOGO_COLOR_COUNT = 10;

export function clampLogoEmoji(n: unknown): number {
  const max = PROJECT_LOGO_EMOJI_COUNT - 1;
  let v: number;
  if (typeof n === 'number') v = n;
  else if (typeof n === 'string') v = parseInt(n, 10);
  else v = 0;
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > max) return max;
  return Math.floor(v);
}

export function clampLogoColor(n: unknown): number {
  const max = PROJECT_LOGO_COLOR_COUNT - 1;
  let v: number;
  if (typeof n === 'number') v = n;
  else if (typeof n === 'string') v = parseInt(n, 10);
  else v = 0;
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > max) return max;
  return Math.floor(v);
}
