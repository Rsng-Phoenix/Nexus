/**
 * Fuzzy matching for the command palette. Pure, so it is unit tested (fuzzy.test.ts).
 *
 * A query matches when every one of its characters (spaces aside) appears in the text in order.
 * Substrings score far above scattered letters; matches at the start of the text or of a word,
 * and runs of consecutive letters, score higher still, so "cal ca" finds "call CA" before
 * "cancel the car wash". Case and accents are ignored.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = fold(query).replace(/\s+/g, ' ').trim();
  if (!q) return 0;
  const t = fold(text);
  const at = t.indexOf(q);
  if (at >= 0) {
    // Whole query as a substring: 100 base, +50 at the very start, +25 at a word start, and a
    // little less for longer texts so an exact-ish title wins over a long one containing it.
    return 100 + (at === 0 ? 50 : wordStart(t, at) ? 25 : 0) - Math.min(20, (t.length - q.length) * 0.5);
  }
  let score = 0;
  let ti = 0;
  let lastHit = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;
    const hit = t.indexOf(ch, ti);
    if (hit < 0) return null;
    score += 1;
    if (hit === lastHit + 1) score += 3; // consecutive
    else if (wordStart(t, hit)) score += 5;
    score -= Math.min(5, (hit - ti) * 0.5); // gap
    lastHit = hit;
    ti = hit + 1;
  }
  return Math.max(0, score);
}

/** Items that match [query], best first (original order breaks ties). */
export function rankFuzzy<T>(query: string, items: T[], text: (item: T) => string, limit = Infinity): T[] {
  const scored: Array<{ item: T; score: number; i: number }> = [];
  items.forEach((item, i) => {
    const score = fuzzyScore(query, text(item));
    if (score != null) scored.push({ item, score, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((s) => s.item);
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function wordStart(t: string, i: number): boolean {
  return i === 0 || /[^\p{L}\p{N}]/u.test(t[i - 1]);
}
