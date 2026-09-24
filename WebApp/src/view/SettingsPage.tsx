import { enableNotifications, needsHomeScreenInstall, notificationState, sendTestPush } from '../reminders/push';
import '../styles/settings.css';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { getAllTasksIncludingDeleted, mergeRestoreTasks, replaceAllTasks } from '../db/tasks';
import { canVibrate, haptic } from '../lib/haptics';
import {
  CHECK_IN_DAYS_RANGE,
  patchSettings,
  resetSettings,
  settingsSig,
  SNOOZE_CHOICES,
  TRASH_DAYS_RANGE
} from '../settings/store';
import * as nav from '../state/nav';
import { activeTasks, archivedTasks, isDemo, purgeExpired, recentlyDeleted, reload } from '../state/store';
import { showSnack } from '../state/toasts';
import { exportFullBackup, parseFullBackup, previewRestore } from '../sync/backup';
import { scheduleSync } from '../sync/manager';
import type { Task, ThemeMode } from '../types';
import type { LayerProps } from './App';
import {
  Chevron,
  Dialog,
  GroupDivider,
  Page,
  PageHeader,
  SectionHeader,
  Segmented,
  SettingsGroup,
  SettingsRow,
  Slider,
  Stepper,
  Switch,
  TextButton
} from './kit';

// Same tints as NexusHubSheet.kt
const Amber = '#FFAA00';
const Green = '#00D084';
const Blue = '#3B9EFF';
const Red = '#FF4060';
const Accent = 'var(--nx-accent)';

const APP_VERSION = '3.6';

const daysLabel = (d: number) => (d === 1 ? '1 day' : `${d} days`);

function hourLabel(h: number): string {
  const hr = ((h + 11) % 12) + 1;
  return `${hr} ${h < 12 ? 'AM' : 'PM'}`;
}

function snoozeLabel(m: number): string {
  return m >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}m`;
}

/** Local value while dragging; re-syncs when the stored setting changes (reset, other tab). */
function useDraft<T>(stored: T): [T, (v: T) => void] {
  const [v, setV] = useState(stored);
  useEffect(() => setV(stored), [stored]);
  return [v, setV];
}

/** AnimatedVisibility(expandVertically() + fadeIn()). Content stays mounted, inert while closed. */
function Collapse({ open, children }: { open: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current as (HTMLDivElement & { inert?: boolean }) | null;
    if (el) el.inert = !open;
  }, [open]);
  return (
    <div ref={ref} class={`nx-collapse ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div>{children}</div>
    </div>
  );
}

function InlineSetting({ label, children }: { label: string; children: ComponentChildren }) {
  return (
    <div class="nx-inline">
      <span class="lbl">{label}</span>
      {children}
    </div>
  );
}

type Perm = 'on' | 'local' | 'off' | 'blocked' | 'unsupported' | 'install';

function notifSubtitle(p: Perm): string {
  switch (p) {
    case 'on':
      return 'On · reminders ring even when Nexus is closed';
    case 'local':
      return 'Only while Nexus is open · tap to finish setup';
    case 'blocked':
      return 'Blocked in browser settings';
    case 'install':
      return 'On iPhone: Share → Add to Home Screen, then open Nexus from there';
    case 'unsupported':
      return 'Not supported by this browser';
    default:
      return 'Off · tap to allow';
  }
}

type RestorePending = {
  incoming: Task[];
  existingCount: number;
  uniqueCount: number;
  duplicateCount: number;
};

export function SettingsPage(p: LayerProps) {
  const s = settingsSig.value;
  const archivedCount = archivedTasks.value.length;
  const deletedCount = recentlyDeleted.value.length;
  const deviceCount = activeTasks.value.filter((t) => !isDemo(t)).length;

  const [trash, setTrash] = useDraft(s.trashDays);
  const [retention, setRetention] = useDraft(s.retentionDays);
  const [fontScale, setFontScale] = useDraft(s.fontScale);
  const [strength, setStrength] = useDraft(s.vibrationStrength);
  const [confirmReset, setConfirmReset] = useState(false);
  const [restore, setRestore] = useState<RestorePending | null>(null);
  const [perm, setPerm] = useState<Perm>('off');
  const readPerm = async (): Promise<Perm> => (needsHomeScreenInstall() ? 'install' : await notificationState());
  const fileInput = useRef<HTMLInputElement>(null);
  // Keep the dialog's text while it animates out after the choice clears `restore`.
  const lastRestore = useRef<RestorePending | null>(null);
  if (restore) lastRestore.current = restore;
  const shown = restore ?? lastRestore.current;

  useEffect(() => {
    const refresh = () => void readPerm().then(setPerm);
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, []);

  const requestNotifications = async () => {
    const r = await enableNotifications();
    if (r === 'error') showSnack("Couldn't reach the reminder service. Try again in a moment.");
    if (r === 'denied') showSnack('Notifications are blocked for this site in your browser settings.');
    setPerm(await readPerm());
  };
  const testNotification = async () => {
    const ok = await sendTestPush();
    showSnack(ok ? 'Test sent. It should appear in a few seconds.' : "Test couldn't be sent. Tap the row to set up again.");
  };

  const exportBackup = async () => {
    try {
      const json = exportFullBackup(await getAllTasksIncludingDeleted());
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `nexus_backup_${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      showSnack(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const incoming = parseFullBackup(await file.text());
      const existing = activeTasks.value.filter((t) => !isDemo(t));
      const pv = previewRestore(existing, incoming);
      setRestore({ incoming, existingCount: existing.length, ...pv });
    } catch (err) {
      showSnack(err instanceof Error ? err.message : 'Could not read that file');
    }
  };

  const runRestore = async (mode: 'merge' | 'replace') => {
    const r = restore;
    setRestore(null);
    if (!r) return;
    try {
      let n: number;
      if (mode === 'merge') n = await mergeRestoreTasks(r.incoming);
      else {
        await replaceAllTasks(r.incoming);
        n = r.incoming.length;
      }
      await reload();
      scheduleSync();
      haptic('SYNC_SUCCESS');
      showSnack(`Restored ${n} tasks`);
    } catch (err) {
      showSnack(err instanceof Error ? err.message : 'Restore failed');
    }
  };

  const hapticsOn = canVibrate && s.vibrationEnabled;

  return (
    <Page leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class="nx-settings">
      <PageHeader title="Settings" onBack={p.onDismiss} />
      <div class="nx-page-scroll narrow">
        <SectionHeader>Tasks</SectionHeader>
        <SettingsGroup>
          <SettingsRow
            icon="archive"
            title="Archived"
            subtitle="Hidden from the matrix, kept forever"
            tint={Blue}
            onClick={() => nav.open({ kind: 'vault', which: 'archived' })}
            trailing={<Chevron badge={archivedCount > 0 ? String(archivedCount) : null} />}
          />
          <GroupDivider />
          <SettingsRow
            icon="deleteOutline"
            title="Recently deleted"
            subtitle={`Restore anything from the last ${s.trashDays} days`}
            tint={Red}
            onClick={() => nav.open({ kind: 'vault', which: 'deleted' })}
            trailing={<Chevron badge={deletedCount > 0 ? String(deletedCount) : null} />}
          />
          <SettingsRow icon="timer" title="Keep deleted tasks" subtitle={`In Recently deleted for ${daysLabel(trash)}`} tint={Red} />
          <div class="nx-slider-row">
            <Slider
              label="Keep deleted tasks, days"
              value={trash}
              min={TRASH_DAYS_RANGE[0]}
              max={TRASH_DAYS_RANGE[1]}
              onInput={setTrash}
              onCommit={(v) => patchSettings({ trashDays: v })}
            />
          </div>
          <GroupDivider />
          <SettingsRow
            icon="autoDelete"
            title="Auto-delete done tasks"
            subtitle={`Completed & won't-do, after ${retention} days`}
            tint={Amber}
          />
          <div class="nx-slider-row">
            <Slider
              label="Auto-delete done tasks, days"
              value={retention}
              min={1}
              max={90}
              onInput={setRetention}
              onCommit={(v) => {
                patchSettings({ retentionDays: v });
                void purgeExpired();
              }}
            />
          </div>
          <GroupDivider />
          <SettingsRow
            icon="checklist"
            title="Checked items sink to the bottom"
            subtitle="In task descriptions"
            tint={Green}
            trailing={
              <Switch
                label="Checked items sink to the bottom"
                checked={s.autoArrange}
                onChange={(v) => patchSettings({ autoArrange: v })}
              />
            }
          />
        </SettingsGroup>

        <SectionHeader>Appearance</SectionHeader>
        <SettingsGroup>
          <div class="nx-settings-pad">
            <Segmented<ThemeMode>
              options={[
                ['SYSTEM', 'System'],
                ['LIGHT', 'Light'],
                ['DARK', 'Dark']
              ]}
              value={s.themeMode}
              onChange={(v) => patchSettings({ themeMode: v })}
            />
          </div>
          <GroupDivider />
          <SettingsRow
            icon="formatSize"
            title="Text size"
            subtitle={`Task titles and notes · ${Math.round(fontScale * 100)}%`}
            tint={Accent}
          />
          <div class="nx-slider-row">
            <Slider
              label="Text size"
              value={fontScale}
              min={0.85}
              max={1.45}
              step={0.01}
              onInput={setFontScale}
              onCommit={(v) => patchSettings({ fontScale: v })}
            />
          </div>
        </SettingsGroup>

        <SectionHeader>Feel &amp; notifications</SectionHeader>
        <SettingsGroup>
          <SettingsRow
            icon="vibration"
            title="Haptics"
            subtitle={canVibrate ? 'Taps, drags, completions' : 'Not supported by this browser (iPhone) · visual feedback only'}
            tint={Accent}
            trailing={
              canVibrate ? (
                <Switch label="Haptics" checked={s.vibrationEnabled} onChange={(v) => patchSettings({ vibrationEnabled: v })} />
              ) : (
                <button role="switch" aria-checked={false} aria-label="Haptics" disabled class="nx-switch nx-switch-disabled">
                  <span class="thumb" />
                </button>
              )
            }
          />
          <Collapse open={hapticsOn}>
            <div class="nx-slider-row split">
              <span class="nx-slider-end">Light</span>
              <Slider
                label="Haptic strength"
                value={strength}
                min={0.1}
                max={1}
                step={0.05}
                onInput={setStrength}
                onCommit={(v) => {
                  patchSettings({ vibrationStrength: v });
                  haptic('DRAG_DROP');
                }}
              />
              <span class="nx-slider-end">Strong</span>
            </div>
          </Collapse>
          <GroupDivider />
          <SettingsRow
            icon="bellRing"
            title="Check-in when I'm away"
            subtitle={`A summary of pending tasks if you don't open Nexus for ${daysLabel(s.checkInDays)}`}
            tint={Amber}
            trailing={
              <Switch
                label="Check-in when I'm away"
                checked={s.checkInEnabled}
                onChange={(v) => patchSettings({ checkInEnabled: v })}
              />
            }
          />
          <Collapse open={s.checkInEnabled}>
            <InlineSetting label="Remind me after">
              <Stepper
                value={s.checkInDays}
                min={CHECK_IN_DAYS_RANGE[0]}
                max={CHECK_IN_DAYS_RANGE[1]}
                format={daysLabel}
                onChange={(v) => patchSettings({ checkInDays: v })}
              />
            </InlineSetting>
          </Collapse>
          <GroupDivider />
          <SettingsRow
            icon="bell"
            title="Notifications on this device"
            subtitle={notifSubtitle(perm)}
            tint={Blue}
            onClick={perm === 'off' || perm === 'local' ? () => void requestNotifications() : undefined}
            trailing={
              perm === 'on' ? (
                <TextButton onClick={() => void testNotification()}>Send test</TextButton>
              ) : perm === 'off' || perm === 'local' ? (
                <Chevron />
              ) : null
            }
          />
        </SettingsGroup>

        <SectionHeader>Reminders</SectionHeader>
        <SettingsGroup>
          <SettingsRow icon="snooze" title="Snooze length" subtitle="Used by the Snooze button on reminders" tint={Blue} />
          <div class="nx-settings-seg">
            <Segmented<number>
              options={SNOOZE_CHOICES.map((m) => [m, snoozeLabel(m)] as [number, string])}
              value={s.snoozeMinutes}
              onChange={(v) => patchSettings({ snoozeMinutes: v })}
            />
          </div>
          <GroupDivider />
          <SettingsRow
            icon="schedule"
            title="Repeating reminder hours"
            subtitle={`All-day and date-range reminders ring between ${hourLabel(s.windowStart)} and ${hourLabel(s.windowEnd)}`}
            tint={Green}
          />
          <InlineSetting label="From">
            <Stepper
              value={s.windowStart}
              min={0}
              max={s.windowEnd - 1}
              format={hourLabel}
              onChange={(v) => patchSettings({ windowStart: v })}
            />
          </InlineSetting>
          <InlineSetting label="Until">
            <Stepper
              value={s.windowEnd}
              min={s.windowStart + 1}
              max={23}
              format={hourLabel}
              onChange={(v) => patchSettings({ windowEnd: v })}
            />
          </InlineSetting>
          <div class="nx-settings-gap" />
        </SettingsGroup>

        <SectionHeader>Backup</SectionHeader>
        <SettingsGroup>
          <SettingsRow
            icon="upload"
            title="Export backup"
            subtitle="Save all tasks as a JSON file"
            tint={Green}
            onClick={() => void exportBackup()}
          />
          <GroupDivider />
          <SettingsRow
            icon="download"
            title="Restore from file"
            subtitle="Choose how to merge before anything changes"
            tint={Blue}
            onClick={() => fileInput.current?.click()}
          />
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json,text/plain"
            hidden
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => void onFile(e)}
          />
        </SettingsGroup>

        <SectionHeader>Help</SectionHeader>
        <SettingsGroup>
          <SettingsRow
            icon="school"
            title="Replay the tour"
            tint={Accent}
            onClick={() => {
              p.onDismiss();
              window.dispatchEvent(new CustomEvent('nexus:start-tour'));
            }}
          />
          <GroupDivider />
          <SettingsRow
            icon="restart"
            title="Reset settings"
            subtitle="Your tasks are not touched"
            tint={Red}
            titleColor={Red}
            onClick={() => setConfirmReset(true)}
          />
        </SettingsGroup>

        <p class="nx-settings-footer">
          Nexus v{APP_VERSION} · {deviceCount} tasks on this device
        </p>
      </div>

      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset all settings?"
        actions={
          <>
            <TextButton color="var(--nx-textSec)" onClick={() => setConfirmReset(false)}>
              Cancel
            </TextButton>
            <TextButton
              color={Red}
              onClick={() => {
                resetSettings();
                void purgeExpired();
                setConfirmReset(false);
              }}
            >
              Reset
            </TextButton>
          </>
        }
      >
        Theme, text size, haptics, reminder, check-in and auto-delete numbers go back to defaults. Tasks stay.
      </Dialog>

      <Dialog
        open={restore !== null}
        onClose={() => setRestore(null)}
        title="Restore backup"
        actions={
          shown && (
            <div class="nx-restore-actions">
              <TextButton onClick={() => void runRestore('merge')}>Add {shown.uniqueCount} new tasks</TextButton>
              <TextButton color={Red} onClick={() => void runRestore('replace')}>
                Replace everything
              </TextButton>
              <TextButton color="var(--nx-textSec)" onClick={() => setRestore(null)}>
                Cancel
              </TextButton>
            </div>
          )
        }
      >
        {shown && (
          <div class="nx-restore-body">
            <span>
              The file has {shown.incoming.length} tasks. You have {shown.existingCount} now.
            </span>
            <span class="strong">
              {shown.uniqueCount} new · {shown.duplicateCount} already here
            </span>
            <span class="small">Adding never removes your current tasks.</span>
          </div>
        )}
      </Dialog>
    </Page>
  );
}
