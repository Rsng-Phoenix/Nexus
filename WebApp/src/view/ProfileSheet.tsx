import '../styles/sheets.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { patchSettings, profileLastSyncedLabel, sanitizeNickname, settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { activeTasks, isDemo } from '../state/store';
import { showSnack } from '../state/toasts';
import { countDriveTasks, isSyncing, onSyncState, runSync, signInMessage, signOutFlow } from '../sync/manager';
import type { LayerProps } from './App';
import { Dialog, GroupDivider, IconButton, Sheet, SettingsGroup, SettingsRow, TextButton } from './kit';
import { Avatar, syncing } from './Shell';

const RED = '#FF4060';
const BLUE = '#3B9EFF';
const NICK_MAX = 12;

/** Close this sheet, then open Settings once the history pop has settled. */
function openSettingsAfterClose(): void {
  nav.back();
  setTimeout(() => nav.open({ kind: 'settings' }), 30);
}

/** ProfileMenuSheet (UserProfileUi.kt). */
export function ProfileSheet(p: LayerProps) {
  const s = settingsSig.value;
  const signedIn = !!s.googleEmail;
  const busy = syncing.value || isSyncing();
  const [driveCount, setDriveCount] = useState<number | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [, setTick] = useState(0);

  const localCount = activeTasks.value.filter((t) => !isDemo(t)).length;

  const loadDrive = () => {
    if (!settingsSig.peek().googleEmail) return;
    setDriveCount(undefined);
    countDriveTasks().then(setDriveCount, () => setDriveCount(null));
  };

  useEffect(() => {
    if (signedIn) loadDrive();
  }, [signedIn]);

  useEffect(() => {
    const off = onSyncState((b, result) => {
      if (!b && result?.ok) loadDrive();
    });
    // Keep "Last synced n min ago" fresh while the sheet is open.
    const t = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const driveLabel = driveCount === undefined ? '…' : driveCount === null ? null : String(driveCount);
  const syncSub = `${profileLastSyncedLabel()} · ${localCount} here${driveLabel !== null ? ` · ${driveLabel} in Drive` : ''}`;

  const syncNow = async () => {
    if (busy) return;
    const r = await runSync();
    showSnack(r.message);
  };

  const signInNow = async () => {
    if (signingIn) return;
    setSigningIn(true);
    try {
      const msg = await signInMessage();
      showSnack(msg);
    } catch {
      showSnack('Sign-in failed');
    } finally {
      setSigningIn(false);
    }
  };

  return (
    <>
    <Sheet leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} radius={28}>
      <div class="nx-pf-body">
        <div class="nx-pf-id">
          <Avatar size={52} ring={busy} />
          <div class="nx-pf-id-text">
            <span class="nx-pf-name">{sanitizeNickname(s.displayName) || 'Hey there'}</span>
            <span class="nx-pf-email">{signedIn ? s.googleEmail : 'Not signed in · tasks stay on this device'}</span>
          </div>
          <IconButton icon="edit" label="Edit name" size={20} onClick={() => setEditing(true)} />
        </div>

        {signedIn ? (
          <SettingsGroup>
            <SettingsRow
              icon="sync"
              title={busy ? 'Syncing…' : 'Sync now'}
              subtitle={syncSub}
              onClick={busy ? undefined : () => void syncNow()}
              trailing={busy ? <span class="nx-pf-spinner" role="status" aria-label="Syncing" /> : undefined}
            />
          </SettingsGroup>
        ) : (
          <SettingsGroup>
            <SettingsRow
              icon="cloud"
              tint={BLUE}
              title={signingIn ? 'Signing in…' : 'Back up with Google Drive'}
              subtitle="Sync with your Android phone and other devices"
              onClick={signingIn ? undefined : () => void signInNow()}
              trailing={signingIn ? <span class="nx-pf-spinner" role="status" aria-label="Signing in" /> : undefined}
            />
          </SettingsGroup>
        )}

        <SettingsGroup>
          <SettingsRow icon="settings" title="Settings" onClick={openSettingsAfterClose} />
          {signedIn && (
            <>
              <GroupDivider />
              <SettingsRow
                icon="logout"
                tint={RED}
                titleColor={RED}
                title="Sign out"
                subtitle="Choose whether tasks stay on this device"
                onClick={() => {
                  void signOutFlow().then((msg) => {
                    if (!msg) return;
                    setDriveCount(undefined);
                    showSnack(msg);
                  });
                }}
              />
            </>
          )}
        </SettingsGroup>
      </div>
    </Sheet>

      {/* Dialogs sit outside the transformed sheet so they centre on the screen. */}
      <NicknameDialog open={editing} current={s.displayName} onClose={() => setEditing(false)} />

    </>
  );
}

/** ChangeNicknameDialog. */
function NicknameDialog({ open, current, onClose }: { open: boolean; current: string; onClose: () => void }) {
  const [value, setValue] = useState(current);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setValue(sanitizeNickname(current));
    const t = setTimeout(() => {
      input.current?.focus();
      input.current?.select();
    }, 60);
    return () => clearTimeout(t);
  }, [open]);
  const clean = sanitizeNickname(value);
  const save = () => {
    if (!clean) return;
    patchSettings({ displayName: clean });
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Change name"
      actions={
        <>
          <TextButton color="var(--nx-textSec)" onClick={onClose}>Cancel</TextButton>
          <TextButton onClick={save} disabled={!clean}>Save</TextButton>
        </>
      }
    >
      <input
        ref={input}
        class="nx-pf-input"
        type="text"
        aria-label="Your name"
        autocapitalize="words"
        autocomplete="nickname"
        maxLength={NICK_MAX}
        value={value}
        onInput={(e) => {
          const el = e.currentTarget;
          // Keep inner spaces while typing; sanitizeNickname trims ends on save.
          const next = el.value.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, NICK_MAX);
          if (next !== el.value) el.value = next;
          setValue(next);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            save();
          }
        }}
      />
      <div class="nx-pf-count">
        {clean.length}/{NICK_MAX} · letters, numbers, spaces
      </div>
    </Dialog>
  );
}
