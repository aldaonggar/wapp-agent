export const QUIET_MS = 3000;
export const UNFINISHED_MS = 8000;
export const MAX_WAIT_MS = 15000;

const TRAILING_WORDS = new Set(["and", "so", "but", "or", "because"]);
const OPENERS = new Set(["hey", "hi", "hello", "yo", "wait", "hold", "quick", "hmm", "btw", "one"]);

export function looksUnfinished(text: string): boolean {
  const t = text.trim();
  if (/(\.\.\.|…|:|,)$/.test(t)) return true;
  const words = t.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const strip = (w: string) => w.replace(/[^\p{L}\p{N}']/gu, "");
  return TRAILING_WORDS.has(strip(words[words.length - 1])) || (words.length <= 3 && OPENERS.has(strip(words[0])));
}

export function turnDue(now: number, burstStartedAt: number, lastText: string): number {
  return Math.min(now + (looksUnfinished(lastText) ? UNFINISHED_MS : QUIET_MS), burstStartedAt + MAX_WAIT_MS);
}

export function bubblePauseMs(chars: number): number {
  return Math.min(2000, 400 + 15 * chars);
}
