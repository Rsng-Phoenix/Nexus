import '../styles/sheets.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import * as nav from '../state/nav';
import { nexusLogoHtml } from '../ui/nexus-logo';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { Sheet, TextButton } from './kit';
import { animate, BOUNCY, STANDARD, useEnterExit } from './motion';

import { APP_VERSION } from '../config';
const APP_YEAR = '2025 - 2026';
const DEVELOPER = 'Priyanshu Pradhan';
const EMAIL = 'priyanshupradhan0204@gmail.com';
const GITHUB = 'https://github.com/Rsng-Phoenix/Nexus';
const UPDATE_CONFIG = 'https://raw.githubusercontent.com/Rsng-Phoenix/Nexus/main/WebApp/update_config.json';

/** Close this sheet, then open Settings once the history pop has settled. */
function openSettingsAfterClose(): void {
  nav.back();
  setTimeout(() => nav.open({ kind: 'settings' }), 30);
}

/** AboutSheet (MainActivity.kt). */
export function AboutSheet(p: LayerProps) {
  return (
    <Sheet leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} radius={28} scrim={0.75}>
      <div class="nx-ab-body">
        <div class="nx-ab-logo" dangerouslySetInnerHTML={{ __html: nexusLogoHtml(72) }} />
        <div class="nx-ab-title">NEXUS</div>
        <div class="nx-ab-tag">priority matrix</div>
        <div class="nx-ab-divider" />
        <div class="nx-ab-by">Developed by</div>
        <div class="nx-ab-dev">{DEVELOPER}</div>
        <a class="nx-ab-mail" href={`mailto:${EMAIL}`}>{EMAIL}</a>
        <div class="nx-ab-pills">
          <button
            class="nx-ab-pill accent press"
            aria-label={`Version ${APP_VERSION}, see what's new`}
            onClick={() => nav.open({ kind: 'changelog' })}
          >
            v{APP_VERSION}
          </button>
          <span class="nx-ab-pill">© {APP_YEAR}</span>
        </div>
        <div style={{ height: 12 }} />
        <button class="nx-ab-settings press" onClick={openSettingsAfterClose}>
          <Icon name="settings" size={16} />
          Settings
        </button>
        <UpdateChecker />
        <a class="nx-ab-git press" href={GITHUB} target="_blank" rel="noopener noreferrer">
          Github : Rsng-Phoenix
        </a>
      </div>
    </Sheet>
  );
}

// ─── Update checker ────────────────────────────────────────────────────────────

type UpdateState =
  | { k: 'idle' }
  | { k: 'checking' }
  | { k: 'latest' }
  | { k: 'ready'; reg?: ServiceWorkerRegistration; version?: string }
  | { k: 'error' };

function isNewer(remote: string, local: string): boolean {
  const a = remote.split('.').map((n) => parseInt(n, 10) || 0);
  const b = local.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function waitForInstalled(reg: ServiceWorkerRegistration, ms = 8000): Promise<boolean> {
  const sw = reg.installing;
  if (!sw) return Promise.resolve(!!reg.waiting);
  return new Promise((res) => {
    const t = setTimeout(() => res(!!reg.waiting), ms);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'installed' || sw.state === 'activated' || sw.state === 'redundant') {
        clearTimeout(t);
        // autoUpdate builds activate straight away; either way the next load is new.
        res(sw.state !== 'redundant');
      }
    });
  });
}

async function checkRemoteConfig(): Promise<UpdateState> {
  try {
    const r = await fetch(`${UPDATE_CONFIG}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return { k: 'error' };
    const cfg = (await r.json()) as { versionName?: string; latest_version?: string };
    const remote = String(cfg.versionName ?? cfg.latest_version ?? '');
    if (remote && isNewer(remote, APP_VERSION)) return { k: 'ready', version: remote };
    return { k: 'latest' };
  } catch {
    return { k: 'error' };
  }
}

async function checkForUpdate(): Promise<UpdateState> {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration().catch(() => undefined) : undefined;
  if (!reg) return checkRemoteConfig();
  try {
    await reg.update();
  } catch {
    return checkRemoteConfig();
  }
  if (reg.waiting) return { k: 'ready', reg };
  if (reg.installing && (await waitForInstalled(reg))) return { k: 'ready', reg };
  return { k: 'latest' };
}

function applyUpdate(reg?: ServiceWorkerRegistration): void {
  const waiting = reg?.waiting;
  if (waiting && 'serviceWorker' in navigator) {
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', go, { once: true });
    waiting.postMessage({ type: 'SKIP_WAITING' });
    setTimeout(go, 1500);
    return;
  }
  location.reload();
}

function UpdateChecker() {
  const [st, setSt] = useState<UpdateState>({ k: 'idle' });
  const box = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const run = async () => {
    if (st.k === 'checking') return;
    setSt({ k: 'checking' });
    const started = Date.now();
    const next = await checkForUpdate();
    // Give the spinner a beat so the result doesn't flash.
    const wait = Math.max(0, 450 - (Date.now() - started));
    setTimeout(() => {
      if (alive.current) setSt(next);
    }, wait);
  };

  useEffect(() => {
    if (st.k !== 'idle' && st.k !== 'checking' && box.current)
      animate(box.current, [{ transform: 'scale(0.97)' }, { transform: 'scale(1)' }], { duration: 260, easing: BOUNCY, fill: 'none' });
  }, [st.k]);

  const checking = st.k === 'checking';
  return (
    <div class="nx-ab-update" ref={box} aria-live="polite">
      {st.k !== 'ready' && (
        <button class="nx-ab-update-btn press" onClick={() => void run()} disabled={checking}>
          <span class={checking ? 'nx-pf-spin' : ''} style={{ display: 'inline-flex' }}>
            <Icon name="sync" size={16} />
          </span>
          {checking ? 'Checking…' : 'Check for update'}
        </button>
      )}
      {st.k === 'latest' && (
        <span class="nx-ab-status ok" key="latest">
          <Icon name="check" size={14} />
          You're on the latest version
        </span>
      )}
      {st.k === 'error' && (
        <span class="nx-ab-status" key="error">Couldn't check right now. Try again later.</span>
      )}
      {st.k === 'ready' && (
        <>
          <span class="nx-ab-status ready" key="ready">
            <Icon name="download" size={14} />
            {st.version ? `Update ready · v${st.version}` : 'Update ready'}
          </span>
          <button class="nx-ab-reload press" onClick={() => applyUpdate(st.reg)}>Reload</button>
        </>
      )}
    </div>
  );
}

// ─── Changelog ─────────────────────────────────────────────────────────────────

/** Copied from MainActivity.kt ChangelogDialog (emoji stripped). */
const ANDROID_CHANGES = [
  'Smart add: type "call CA tomorrow 5pm !1" and Nexus sets the date, reminder and priority for you',
  "Reliable reminders: one tap in Settings so the phone's battery saver can't stop your reminders",
  'Imported tasks now wait in an Imported folder inside each quadrant; only the ones due today step onto the matrix. Their reminders still ring on time',
  'One version everywhere: web, Nexus Desk and Android are all 4.0',
  'Share, redesigned: chat-ready text, a branded image card, and multi-page PDFs with selectable text in any language',
  'Link a Google Sheet: its rows become tasks and keep updating as the sheet changes',
  'Linked sheets: one title for every row (e.g. "Appointment"), dates like "24th Sep", and battery-friendly updates you control',
  'Scan to set up now brings your linked Google Sheets to the other device too',
  'Unlinking a sheet can remove its upcoming tasks (past and finished ones stay), with Undo',
  'Late alerts: a sheet row that arrives after its alert time (its day not over) alerts you once right away, so a late read never swallows a reminder',
  'Sheet import keeps every reason when rows share a title and date',
  'Linked calendars now reach all your devices when you are signed in: add, rename or remove one once and your other devices follow',
  'Show Nexus in Google, Apple or Outlook Calendar: a live link that updates as you add, change or finish tasks',
  'Clash radar: meetings that overlap across your linked calendars are flagged, with a clash note in meeting alerts',
  'Scan to set up: copy linked calendars and settings to another device with a QR code (encrypted end to end)',
  'Moved or cancelled single meetings in a recurring series now show correctly',
  'Deadlines: pick a due day and get alerts days before, on the day or after',
  'A calendar with your deadlines, reminders and linked Google / iCloud / Zoho / Outlook calendars',
  'Every calendar item says where it is from (Nexus, Google, iCloud, Zoho, Outlook); tap a calendar in the legend to hide it',
  'Linked calendars are checked every 15 minutes (you choose) and whenever you open Nexus',
  'Optional heads-up before meetings from your linked calendars, with a Join button',
  'Join button for Google Meet, Zoom and Teams links in your calendar',
  'Add any task with a deadline to Google, Apple or Outlook Calendar in one tap',
  'Choose whether Nexus opens on the Matrix or the Calendar',
  'Settings reorganised into clear categories',
  'Nexus Desk for Mac and Windows: a floating Nexus window with a hot corner, installed with one command',
  'Import deadlines from Excel or CSV — every dated row becomes a task, with alerts you choose',
  'Import and export calendar (.ics) files',
  'Home-screen widgets: Matrix, Today, Quick add, Next up and a single quadrant',
  'Full notification control: pause, per-type switches, grouping and an hourly safety limit',
  'Switching Google accounts asks what to do with the tasks on this device',
  'Multi-line descriptions and tap anywhere in a description to type',
  '"Delete all" in a quadrant now only touches that quadrant — with Undo',
  'Recently deleted: restore anything you deleted (you choose how long it is kept)',
  'You set the numbers: check-in delay, snooze length, reminder hours, trash retention',
  'A hands-on tour: you do each step yourself instead of reading slides',
  'Archive tasks, then find, restore or delete them from Settings',
  'Smooth drag-to-reorder with haptics, plus swipe to complete / delete',
  'All-day & date-range reminders now repeat through the day; swipe one away to stop it',
  'Reminders clear themselves after ringing and survive a phone restart',
  "A gentle check-in if you haven't opened Nexus for a few days",
  'Completed pinned tasks no longer stick to the top',
  'Sharing always previews the task you picked',
  'Rotating the screen no longer resets the app',
  'Vibration on/off switch',
  'Updates open GitHub instead of installing in-app (fixes Play Protect warnings)',
  'Much smaller, faster app'
];

const WEB_CHANGES = [
  'Nexus Desk for Mac shows reminders as real macOS notifications; ⌃⌥N (Ctrl+Alt+N on Windows) adds a task from any app',
  'Sync rides out Wi-Fi changes and waking from sleep instead of saying Google Drive is unreachable',
  'Keyboard first: ⌘K / Ctrl+K opens a command palette that finds any task or action; arrows or J K H L move a highlight round the matrix (Space done, P pin, ⌫ delete, ⌥1–4 move); smart add reads "call CA tomorrow 5pm !1" as the date, reminder and priority; ? lists every shortcut',
  'Imported tasks now wait in an Imported folder inside each quadrant; only the ones due today step onto the matrix. Their reminders still ring on time',
  'One version everywhere: web, Nexus Desk and Android are all 4.0',
  'Share, redesigned: chat-ready text with dates and ☐ checklist, a branded image card, and proper multi-page PDFs in any language',
  'Link a Google Sheet: its rows become tasks and keep updating as the sheet changes (your ticks and edits stay)',
  'Linked sheets: one title for every row (e.g. "Appointment"), dates like "24th Sep", uploaded Excel files in Google Drive, and a "Only when I tap Update" choice to save battery',
  'Scan to set up now brings your linked Google Sheets to the other device too',
  'Sheet import keeps every reason when rows share a title and date, instead of dropping the extra rows',
  'Nexus Desk: no more keychain password prompts, and the matrix follows the window size straight away',
  'Linked calendars now reach all your devices (phone, other browsers, Nexus Desk) when you are signed in',
  'Nexus Desk for Mac loads linked calendars itself, no notifications needed',
  'Show Nexus in Google, Apple or Outlook Calendar: a live link that updates as you add, change or finish tasks',
  'Clash radar: meetings that overlap across your linked calendars are flagged',
  'Scan to set up: copy linked calendars and settings to another device with a QR code',
  'Nexus Desk: a calendar view, open a task to rename it, tick its checklist, move it or set a deadline; optional separate calendar window',
  'Nexus Desk for Mac uses no power while waiting for the hot corner',
  'Stays signed in to Google Drive (no more hourly sign-in)',
  'Mini window that stays on top of every app (Chrome, Edge, Brave)',
  'On a computer: press Enter anywhere for a new task',
  'Windows 11 widgets (install from Edge) and Dock / taskbar shortcuts',
  'Dragging a task keeps it right under your pointer',
  'Rebuilt to match the Android app, with the same gestures and settings',
  'Two-way Google Drive sync that actually saves your edits',
  'Install it from your browser for its own window and icon'
];

export function ChangelogDialog(p: LayerProps) {
  const card = useRef<HTMLDivElement>(null);
  const shade = useRef<HTMLDivElement>(null);
  useEnterExit(
    card,
    p.leaving,
    p.onExited,
    [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'scale(1)' }],
    [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.96)' }],
    { duration: 280, easing: BOUNCY },
    { duration: 170, easing: STANDARD }
  );
  useEnterExit(shade, p.leaving, () => {}, [{ opacity: 0 }, { opacity: 1 }], [{ opacity: 1 }, { opacity: 0 }],
    { duration: 200, easing: 'linear' }, { duration: 170, easing: 'linear' });
  return (
    <div class="nx-ab-cl-wrap" data-leaving={p.leaving || undefined}>
      <div ref={shade} class="nx-scrim" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={p.onDismiss} />
      <div ref={card} class="nx-ab-cl" role="dialog" aria-modal="true" aria-labelledby="nx-ab-cl-title">
        <h2 id="nx-ab-cl-title">What's new in {APP_VERSION}</h2>
        <div class="nx-ab-cl-list">
          <ul>
            {ANDROID_CHANGES.map((c) => (
              <li key={c}>
                <span class="nx-ab-dot" aria-hidden="true" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
          <h3>On the web</h3>
          <ul>
            {WEB_CHANGES.map((c) => (
              <li key={c}>
                <span class="nx-ab-dot" aria-hidden="true" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
        <div class="nx-ab-cl-actions">
          <TextButton onClick={p.onDismiss}>Got it</TextButton>
        </div>
      </div>
    </div>
  );
}
