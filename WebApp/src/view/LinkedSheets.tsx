import { refreshSheet, sheetBusy, sheetOpenUrl, unlinkSheet, upcomingSheetTasks } from '../import/liveSheet';
import { patchSettings, settingsSig, SHEET_REFRESH_CHOICES, sheetRefreshLabel } from '../settings/store';
import { askChoice } from '../state/prompts';
import { restoreTasks } from '../state/store';
import { offerUndo, showSnack } from '../state/toasts';
import { Icon } from './icons';
import { Stepper } from './kit';

const ago = (at: number) => {
  if (!at) return 'Not read yet';
  const m = Math.floor((Date.now() - at) / 60_000);
  return m < 1 ? 'Updated just now' : m < 60 ? `Updated ${m} min ago` : m < 1440 ? `Updated ${Math.floor(m / 60)} h ago` : `Updated ${Math.floor(m / 1440)} d ago`;
};

/** Settings → Import: the Google Sheets that keep updating their tasks. */
export function LinkedSheets() {
  const s = settingsSig.value;
  if (!s.linkedSheets.length) return null;
  const busy = sheetBusy.value;

  const update = async (id: string) => {
    const r = await refreshSheet(id);
    if (!r) return; // the error shows on the row
    const parts = [r.added && `${r.added} added`, r.updated && `${r.updated} updated`, r.removed && `${r.removed} removed`].filter(Boolean);
    showSnack(parts.length ? parts.join(' · ') : 'Already up to date');
  };
  const stop = async (id: string, name: string) => {
    const upcoming = (await upcomingSheetTasks(id)).length;
    const ok = await askChoice({
      title: `Stop updating from “${name}”?`,
      body: upcoming
        ? `It made ${upcoming} upcoming task${upcoming === 1 ? '' : 's'} (today or later, not done). Remove them too, or keep them? Past and finished tasks always stay.`
        : 'New rows in the sheet won’t be added any more. Its tasks are all past or done, so they stay.',
      options: [
        ...(upcoming ? [{ id: 'remove', label: `Stop and remove ${upcoming} upcoming`, tone: 'danger' as const }] : []),
        { id: 'keep', label: upcoming ? 'Stop, keep its tasks' : 'Stop updating', tone: upcoming ? ('plain' as const) : ('danger' as const) }
      ],
      cancelLabel: 'Keep linked'
    });
    if (ok !== 'remove' && ok !== 'keep') return;
    const removed = await unlinkSheet(id, ok === 'remove');
    if (removed.length) offerUndo(`Unlinked · ${removed.length} upcoming task${removed.length === 1 ? '' : 's'} removed`, () => void restoreTasks(removed));
    else showSnack('Sheet unlinked · its tasks stay');
  };

  return (
    <div class="nx-sheets">
      <ul>
        {s.linkedSheets.map((l) => (
          <li key={l.id}>
            <span class="ic"><Icon name="table" size={18} /></span>
            <span class="txt">
              <b>{l.name}</b>
              <small class={l.lastError ? 'err' : ''}>{busy[l.id] ? 'Reading…' : l.lastError || ago(l.lastSyncAt)}</small>
            </span>
            <button class="press" title="Update now" aria-label={`Update ${l.name} now`} disabled={!!busy[l.id]} onClick={() => void update(l.id)}>
              <Icon name="sync" size={16} />
            </button>
            <a class="press" title="Open in Google Sheets" aria-label={`Open ${l.name} in Google Sheets`} href={sheetOpenUrl(l)} target="_blank" rel="noopener noreferrer">
              <Icon name="link" size={16} />
            </a>
            <button class="press danger" title="Stop updating" aria-label={`Stop updating from ${l.name}`} onClick={() => void stop(l.id, l.name)}>
              <Icon name="close" size={16} />
            </button>
          </li>
        ))}
      </ul>
      <div class="nx-inline">
        <span class="lbl">Read them every</span>
        <Stepper
          value={Math.max(0, SHEET_REFRESH_CHOICES.indexOf(s.sheetRefreshMinutes as (typeof SHEET_REFRESH_CHOICES)[number]))}
          min={0}
          max={SHEET_REFRESH_CHOICES.length - 1}
          format={(i) => sheetRefreshLabel(SHEET_REFRESH_CHOICES[i])}
          onChange={(i) => patchSettings({ sheetRefreshMinutes: SHEET_REFRESH_CHOICES[i] })}
        />
      </div>
    </div>
  );
}
