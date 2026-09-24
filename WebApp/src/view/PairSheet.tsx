import '../styles/pair.css';
import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { calendarProvider } from '../calendar/linked';
import { haptic } from '../lib/haptics';
import { applySetup } from '../pair/apply';
import {
  buildPayload,
  collectSetup,
  newCalendars,
  newPairLink,
  PAIR_TTL_MS,
  pairUrl,
  parsePairLink,
  stillWaiting,
  uploadSetup,
  verifyCode,
  type PairLink,
  type SetupPayload
} from '../pair/pair';
import { enableNotifications, workerAuth } from '../reminders/push';
import { getSettings, settingsSig } from '../settings/store';
import * as nav from '../state/nav';
import { showSnack } from '../state/toasts';
import { signInMessage } from '../sync/manager';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { PrimaryButton, Segmented, Sheet, Switch } from './kit';
import { QrCode } from './QrCode';
import { QrScanner } from './QrScanner';

type Tab = 'send' | 'get';
type Stage =
  | { k: 'show' }
  | { k: 'scan' }
  | { k: 'fetching'; link: PairLink }
  | { k: 'preview'; payload: SetupPayload }
  | { k: 'confirmSend'; link: PairLink; code: string }
  | { k: 'done'; title: string; detail: string; payload?: SetupPayload; added?: number }
  | { k: 'error'; message: string };

/** Phones and tablets get the share sheet (AirDrop, WhatsApp…); computers copy the link. */
const canShare = () => typeof navigator.share === 'function' && /iPhone|iPad|Android/.test(navigator.userAgent);

const hasSetup = () => {
  const s = getSettings();
  return s.linkedCalendars.length > 0 || !!s.googleEmail || !!s.displayName;
};

/** Scan to set up: move linked calendars and settings between your devices with a QR code. */
export function PairSheet(p: LayerProps & { link?: PairLink }) {
  const [tab, setTab] = useState<Tab>(() => (hasSetup() ? 'send' : 'get'));
  const [stage, setStage] = useState<Stage>(() => (p.link ? { k: 'fetching', link: p.link } : { k: 'show' }));
  // Came here instead of the first-run screen and didn't finish: show that screen again.
  useEffect(
    () =>
      nav.onLayerClose(p.id, () => {
        if (!getSettings().profileOnboardingDone) setTimeout(() => nav.open({ kind: 'onboarding' }), 320);
      }),
    []
  );

  // A link opened / scanned: either collect a setup, or confirm sending ours.
  useEffect(() => {
    if (stage.k !== 'fetching') return;
    const link = stage.link;
    let live = true;
    void (async () => {
      if (link.mode === 'send') {
        const code = await verifyCode(link);
        if (live) setStage({ k: 'confirmSend', link, code });
        return;
      }
      try {
        const payload = await collectSetup(link);
        if (!live) return;
        setStage(payload ? { k: 'preview', payload } : { k: 'error', message: 'This code has expired or was already used. Make a new one on the other device.' });
      } catch (e) {
        if (live) setStage({ k: 'error', message: e instanceof Error ? e.message : 'Something went wrong' });
      }
    })();
    return () => {
      live = false;
    };
  }, [stage]);

  const onScanned = (text: string) => {
    const link = parsePairLink(text);
    if (!link) return false;
    setStage({ k: 'fetching', link });
    return true;
  };

  return (
    <Sheet leaving={p.leaving} onExited={p.onExited} onDismiss={p.onDismiss} class="nx-pair" maxHeight="96%">
      <div class="nx-pair-body">
        {stage.k === 'show' && (
          <>
            <header class="nx-pair-head">
              <h2>Set up another device</h2>
              <p>Your linked calendars and settings, moved in seconds. Tasks follow through Google Drive sync.</p>
            </header>
            <Segmented<Tab>
              options={[
                ['send', 'Send from this device'],
                ['get', 'Get a setup here']
              ]}
              value={tab}
              onChange={setTab}
            />
            {tab === 'send' ? <ShowSend key="send" onDone={(st) => setStage(st)} /> : <ShowGet key="get" onPayload={(payload) => setStage({ k: 'preview', payload })} />}
            <button class="nx-pair-scan press" onClick={() => setStage({ k: 'scan' })}>
              <Icon name="qrScan" size={20} />
              <span>
                <b>Scan a code instead</b>
                <small>{tab === 'send' ? 'The other device shows “Get a setup here”' : 'The other device shows “Send from this device”'}</small>
              </span>
              <Icon name="chevronRight" size={18} class="go" />
            </button>
          </>
        )}

        {stage.k === 'scan' && <QrScanner accept={onScanned} onCancel={() => setStage({ k: 'show' })} />}

        {stage.k === 'fetching' && (
          <div class="nx-pair-wait">
            <span class="nx-pair-spinner" />
            <p>Opening the code…</p>
          </div>
        )}

        {stage.k === 'preview' && <Preview payload={stage.payload} onApplied={(added) => setStage({ k: 'done', title: 'You’re all set', detail: doneDetail(stage.payload, added), payload: stage.payload, added })} onCancel={p.onDismiss} />}

        {stage.k === 'confirmSend' && (
          <ConfirmSend
            link={stage.link}
            code={stage.code}
            onSent={() => setStage({ k: 'done', title: 'Sent', detail: 'Your other device is setting itself up now.' })}
            onCancel={p.onDismiss}
          />
        )}

        {stage.k === 'done' && <Done {...stage} onClose={p.onDismiss} />}

        {stage.k === 'error' && (
          <div class="nx-pair-wait err">
            <Icon name="warning" size={34} />
            <p>{stage.message}</p>
            <PrimaryButton onClick={() => setStage({ k: 'show' })}>Try again</PrimaryButton>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function doneDetail(p: SetupPayload, added: number): string {
  const bits = [added ? `${added} calendar${added === 1 ? '' : 's'} linked` : 'Calendars already here', 'settings copied'];
  return `${bits.join(' · ')} from ${p.from}.`;
}

/** The countdown ring and QR, shared by both directions. */
function CodeCard({ link, expiresAt, status, statusKind }: { link: PairLink; expiresAt: number; status: string; statusKind: 'wait' | 'ok' | 'err' }) {
  const [code, setCode] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => void verifyCode(link).then(setCode), [link]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, expiresAt - now);
  const url = pairUrl(link);
  const copy = async () => {
    try {
      if (canShare()) await navigator.share({ title: 'Nexus setup', url });
      else {
        await navigator.clipboard.writeText(url);
        showSnack('Link copied · open it on your other device (it works once, for 10 minutes)');
      }
    } catch {
      /* share sheet dismissed */
    }
  };
  return (
    <div class={`nx-pair-card ${statusKind}`}>
      <div class="ring" style={{ '--p': String(left / PAIR_TTL_MS) } as JSX.CSSProperties}>
        <QrCode text={url} size={220} />
        <span class="sheen" aria-hidden="true" />
      </div>
      <div class="check" aria-label={`Check code ${code}`}>
        {code.split('').map((d, i) => (
          <span key={i} style={{ animationDelay: `${i * 70}ms` }}>
            {d}
          </span>
        ))}
      </div>
      <p class={`status ${statusKind}`} role="status">
        {statusKind === 'wait' && <span class="pulse" />}
        {status}
      </p>
      <div class="actions">
        <span class="timer">{left > 0 ? `Expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}` : 'Expired'}</span>
        <button class="nx-text-btn press" onClick={() => void copy()}>
          <Icon name="link" size={15} /> {canShare() ? 'Share link' : 'Copy link'}
        </button>
      </div>
    </div>
  );
}

/** This device uploads its setup; the other device scans and collects it. */
function ShowSend({ onDone }: { onDone: (s: Stage) => void }) {
  const [round, setRound] = useState(0);
  const link = useMemo(() => newPairLink('get'), [round]);
  const [expiresAt, setExpiresAt] = useState(0);
  const [status, setStatus] = useState<{ t: string; k: 'wait' | 'ok' | 'err' }>({ t: 'Preparing a secure code…', k: 'wait' });
  const payload = useMemo(() => buildPayload(), [round]);

  useEffect(() => {
    let live = true;
    let timer = 0;
    setStatus({ t: 'Preparing a secure code…', k: 'wait' });
    void uploadSetup(link, payload)
      .then(() => {
        if (!live) return;
        const until = Date.now() + PAIR_TTL_MS;
        setExpiresAt(until);
        setStatus({ t: 'Scan this with the camera on your other device', k: 'wait' });
        const poll = async () => {
          if (!live) return;
          if (Date.now() > until) return setStatus({ t: 'This code expired', k: 'err' });
          if (!(await stillWaiting(link).catch(() => true))) {
            haptic('DRAG_DROP');
            return onDone({ k: 'done', title: 'Sent', detail: 'Your other device has your calendars and settings.' });
          }
          timer = window.setTimeout(() => void poll(), 2500);
        };
        timer = window.setTimeout(() => void poll(), 2500);
      })
      .catch((e: Error) => live && setStatus({ t: e.message, k: 'err' }));
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [link]);

  const cals = payload.calendars.length;
  return (
    <>
      <CodeCard link={link} expiresAt={expiresAt || Date.now() + PAIR_TTL_MS} status={status.t} statusKind={status.k} />
      <ul class="nx-pair-what">
        <li>
          <Icon name="event" size={16} /> {cals ? `${cals} linked calendar${cals === 1 ? '' : 's'}` : 'No linked calendars yet'}
        </li>
        <li>
          <Icon name="tune" size={16} /> Theme, notifications and calendar settings
        </li>
        {payload.account && (
          <li>
            <Icon name="lock" size={16} /> Suggests {payload.account} for sign-in
          </li>
        )}
      </ul>
      {status.k === 'err' && <PrimaryButton onClick={() => setRound((r) => r + 1)}>Make a new code</PrimaryButton>}
      <p class="nx-pair-fine">Encrypted on this device. The key is only inside the code, so not even Nexus can read it. Works once, for 10 minutes.</p>
    </>
  );
}

/** This device shows a code; the other device scans it and sends its setup here. */
function ShowGet({ onPayload }: { onPayload: (p: SetupPayload) => void }) {
  const [round, setRound] = useState(0);
  const link = useMemo(() => newPairLink('send'), [round]);
  const [expiresAt] = useState(() => Date.now() + PAIR_TTL_MS);
  const [until, setUntil] = useState(expiresAt);
  const [status, setStatus] = useState<{ t: string; k: 'wait' | 'ok' | 'err' }>({ t: 'Waiting for your other device…', k: 'wait' });

  useEffect(() => {
    let live = true;
    let timer = 0;
    const end = Date.now() + PAIR_TTL_MS;
    setUntil(end);
    setStatus({ t: 'Waiting for your other device…', k: 'wait' });
    const poll = async () => {
      if (!live) return;
      if (Date.now() > end) return setStatus({ t: 'This code expired', k: 'err' });
      try {
        const payload = await collectSetup(link);
        if (payload && live) {
          haptic('DRAG_DROP');
          return onPayload(payload);
        }
      } catch (e) {
        if (e instanceof Error && !e.message.includes('reach')) return live && setStatus({ t: e.message, k: 'err' });
      }
      timer = window.setTimeout(() => void poll(), 2000);
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [link]);

  return (
    <>
      <CodeCard link={link} expiresAt={until} status={status.t} statusKind={status.k} />
      <ol class="nx-pair-steps">
        <li>On the device that has your setup, open Nexus</li>
        <li>Settings → Account &amp; sync → Set up another device</li>
        <li>Tap “Scan a code instead” and point it here</li>
      </ol>
      {status.k === 'err' && <PrimaryButton onClick={() => setRound((r) => r + 1)}>Make a new code</PrimaryButton>}
      <p class="nx-pair-fine">Or scan it with your phone’s camera if Nexus is open in that phone’s browser.</p>
    </>
  );
}

function Preview({ payload, onApplied, onCancel }: { payload: SetupPayload; onApplied: (added: number) => void; onCancel: () => void }) {
  const fresh = newCalendars(payload, settingsSig.value.linkedCalendars);
  const [cals, setCals] = useState(fresh.length > 0);
  const [prefs, setPrefs] = useState(true);
  const providers = [...new Set(fresh.map((c) => calendarProvider(c.url).label))];
  return (
    <div class="nx-pair-preview">
      <div class="from">
        <span class="orb" aria-hidden="true">
          <Icon name="desktop" size={22} />
        </span>
        <div>
          <h2>Setup from {payload.from}</h2>
          <p>Choose what to bring over</p>
        </div>
      </div>
      <label class="nx-pair-opt">
        <Icon name="event" size={20} />
        <span>
          <b>{fresh.length ? `${fresh.length} linked calendar${fresh.length === 1 ? '' : 's'}` : 'Linked calendars'}</b>
          <small>{fresh.length ? providers.join(', ') : payload.calendars.length ? 'Already on this device' : 'None on the other device'}</small>
        </span>
        <Switch label="Linked calendars" checked={cals && fresh.length > 0} onChange={(v) => setCals(v)} />
      </label>
      <label class="nx-pair-opt">
        <Icon name="tune" size={20} />
        <span>
          <b>Settings</b>
          <small>Theme, notifications, calendar and reminder preferences</small>
        </span>
        <Switch label="Settings" checked={prefs} onChange={setPrefs} />
      </label>
      <div class="nx-pair-buttons">
        <button class="nx-text-btn press" onClick={onCancel}>
          Cancel
        </button>
        <PrimaryButton
          icon="check"
          disabled={!(cals && fresh.length) && !prefs}
          onClick={() => {
            haptic('DRAG_DROP');
            onApplied(applySetup(payload, { calendars: cals, prefs }));
          }}
        >
          Set up this device
        </PrimaryButton>
      </div>
    </div>
  );
}

function ConfirmSend({ link, code, onSent, onCancel }: { link: PairLink; code: string; onSent: () => void; onCancel: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const payload = useMemo(() => buildPayload(), []);
  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      await uploadSetup(link, payload);
      haptic('DRAG_DROP');
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send');
      setBusy(false);
    }
  };
  return (
    <div class="nx-pair-preview">
      <div class="from">
        <span class="orb" aria-hidden="true">
          <Icon name="send" size={20} />
        </span>
        <div>
          <h2>Send your setup?</h2>
          <p>Only to your own device. Its screen should show this number:</p>
        </div>
      </div>
      <div class="nx-pair-card ok bare">
        <div class="check">
          {code.split('').map((d, i) => (
            <span key={i} style={{ animationDelay: `${i * 70}ms` }}>
              {d}
            </span>
          ))}
        </div>
      </div>
      <ul class="nx-pair-what">
        <li>
          <Icon name="event" size={16} /> {payload.calendars.length} linked calendar{payload.calendars.length === 1 ? '' : 's'} (their private links)
        </li>
        <li>
          <Icon name="tune" size={16} /> Your settings{payload.account ? ` and your Google address` : ''}
        </li>
      </ul>
      {err && <p class="nx-pair-err">{err}</p>}
      <div class="nx-pair-buttons">
        <button class="nx-text-btn press" onClick={onCancel}>
          Cancel
        </button>
        <PrimaryButton icon="send" disabled={busy} onClick={() => void send()}>
          {busy ? 'Sending…' : 'Send'}
        </PrimaryButton>
      </div>
    </div>
  );
}

function Done({ title, detail, payload, added, onClose }: { title: string; detail: string; payload?: SetupPayload; added?: number; onClose: () => void }) {
  const s = settingsSig.value;
  const [registered, setRegistered] = useState<boolean | null>(null);
  useEffect(() => {
    if (added) void workerAuth().then((a) => setRegistered(!!a));
  }, [added]);
  const signIn = payload?.account && !s.googleEmail;
  return (
    <div class="nx-pair-done">
      <span class="burst" aria-hidden="true">
        {Array.from({ length: 12 }, (_, i) => (
          <i key={i} style={{ '--a': `${i * 30}deg`, '--c': ['#00C6FF', '#00FF94', '#FFD600', '#FF6A00', '#FF3D6B', '#4A90E2'][i % 6] } as JSX.CSSProperties} />
        ))}
      </span>
      <span class="tick">
        <svg viewBox="0 0 52 52" aria-hidden="true">
          <circle cx="26" cy="26" r="24" />
          <path d="M15 27l7 7 15-16" />
        </svg>
      </span>
      <h2>{title}</h2>
      <p>{detail}</p>
      <div class="next">
        {added && registered === false ? (
          <PrimaryButton icon="bell" onClick={() => void enableNotifications().then(() => workerAuth().then((a) => setRegistered(!!a)))}>
            Turn on notifications to load calendars
          </PrimaryButton>
        ) : null}
        {signIn ? (
          <PrimaryButton icon="sync" color="var(--nx-surfaceEl)" class="alt" onClick={() => void signInMessage(payload!.account)}>
            Sign in as {payload!.account}
          </PrimaryButton>
        ) : null}
        <button class="nx-text-btn press" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
