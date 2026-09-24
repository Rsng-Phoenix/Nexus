/**
 * Deadline field helpers (spec 3.7 §1). `dueAlerts` is a comma list of day offsets relative to
 * `dueDate`, sorted ascending, unique, each in [-30, 30]; garbage entries are dropped.
 */
export const DUE_ALERT_MIN_OFFSET = -30;
export const DUE_ALERT_MAX_OFFSET = 30;
/** Default for `dueAlertTime`: minutes after local midnight (540 = 09:00). */
export const DEFAULT_DUE_ALERT_TIME = 540;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(s: string): boolean {
  const m = ISO_DATE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function normalizeDueOffsets(offsets: Iterable<number>): number[] {
  const set = new Set<number>();
  for (const o of offsets) {
    if (Number.isInteger(o) && o >= DUE_ALERT_MIN_OFFSET && o <= DUE_ALERT_MAX_OFFSET) set.add(o);
  }
  return [...set].sort((a, b) => a - b);
}

export function parseDueAlerts(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const nums: number[] = [];
  for (const part of raw.split(',')) {
    const p = part.trim();
    if (/^[+-]?\d+$/.test(p)) nums.push(Number(p));
  }
  return normalizeDueOffsets(nums);
}

export function formatDueAlerts(offsets: Iterable<number>): string {
  return normalizeDueOffsets(offsets).join(',');
}

export function clampAlertTime(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_DUE_ALERT_TIME;
  return Math.min(1439, Math.max(0, Math.round(minutes)));
}
