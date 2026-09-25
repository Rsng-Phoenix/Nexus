import { refreshSheet, sheetBusy, sheetOpenUrl, unlinkSheet } from '../import/liveSheet';
import { patchSettings, settingsSig, SHEET_REFRESH_CHOICES, refreshLabel } from '../settings/store';
import { askChoice } from '../state/prompts';
import { showSnack } from '../state/toasts';
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
    const ok = await askChoice({
      title: `Stop updating from “${name}”?`,
      body: 'The tasks it already made stay in Nexus. New rows in the sheet won’t be added any more.',
      options: [{ id: 'stop', label: 'Stop updating', tone: 'danger' }],
      cancelLabel: 'Keep it'
    });
    if (ok !== 'stop') return;
    await unlinkSheet(id);
    showSnack('Sheet unlinked · its tasks stay');
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
          format={(i) => refreshLabel(SHEET_REFRESH_CHOICES[i])}
          onChange={(i) => patchSettings({ sheetRefreshMinutes: SHEET_REFRESH_CHOICES[i] })}
        />
      </div>
    </div>
  );
}
