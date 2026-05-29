/** Matches Android formatReminderLabel in NotesBlocks.kt */
export function formatReminderLabel(
  millis: number | null,
  dateOnly: boolean,
  intervalMin: number,
  endDate: number
): string | null {
  if (millis == null) return null;
  const d = new Date(millis);
  const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const endDateStr =
    endDate > 0
      ? new Date(endDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : null;
  let intervalStr = 'every 2h';
  if (intervalMin === 60) intervalStr = 'every 1h';
  else if (intervalMin > 0) intervalStr = `every ${intervalMin}m`;
  if (endDateStr) return `${dateStr} – ${endDateStr} · ${intervalStr}`;
  if (dateOnly) return `${dateStr} · All day (${intervalStr})`;
  return `${dateStr} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
