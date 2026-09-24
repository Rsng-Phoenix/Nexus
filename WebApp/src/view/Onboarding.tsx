import '../styles/tour.css';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getSettings, patchSettings, sanitizeNickname, settingsSig } from '../settings/store';
import { signInMessage } from '../sync/manager';
import type { LayerProps } from './App';
import { Icon } from './icons';
import { PrimaryButton, TextButton } from './kit';
import { ENTER, EXIT, useEnterExit } from './motion';
import { startTour } from './Tour';

/** Letters, numbers, spaces, _ and - while typing; trimmed by sanitizeNickname on save. */
const typing = (s: string) => s.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 12);

/** First-run profile card (port of ProfileOnboardingOverlay). Not dismissable by Esc. */
export function Onboarding(p: LayerProps) {
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const done = useRef(false);
  const email = settingsSig.value.googleEmail;
  const clean = sanitizeNickname(name);

  useEnterExit(root, p.leaving, p.onExited, [{ opacity: 0 }, { opacity: 1 }], [{ opacity: 1 }, { opacity: 0 }], ENTER, EXIT);
  useEnterExit(
    card,
    p.leaving,
    () => {},
    [{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }],
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(0.96)' }],
    ENTER,
    EXIT
  );

  useEffect(() => {
    // Like the Android dialog (dismissOnBackPress = false): Esc does not skip onboarding.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !p.leaving) e.preventDefault();
    };
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [p.leaving]);

  const finish = (chosen: string) => {
    if (done.current) return;
    done.current = true;
    patchSettings({ profileOnboardingDone: true, displayName: chosen || getSettings().displayName });
    p.onDismiss();
    if (!getSettings().tutorialDone) setTimeout(startTour, 350);
  };

  const google = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const msg = await signInMessage();
      const s = getSettings();
      if (!s.googleEmail) setError(msg);
      else if (!sanitizeNickname(name)) setName(sanitizeNickname(s.displayName));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="nx-ob" ref={root}>
      <div class="nx-ob-card" ref={card} role="dialog" aria-modal="true" aria-labelledby="nx-ob-title">
        <h1 class="nx-ob-title" id="nx-ob-title">
          Welcome to NEXUS
        </h1>
        <label class="nx-ob-q" for="nx-ob-name">
          What should we call you?
        </label>
        <input
          id="nx-ob-name"
          class="nx-ob-input"
          type="text"
          value={name}
          maxLength={12}
          placeholder="Nickname (max 12)"
          autoComplete="nickname"
          autoCapitalize="words"
          spellcheck={false}
          aria-describedby="nx-ob-count"
          onInput={(e) => {
            const el = e.currentTarget;
            const v = typing(el.value);
            if (v !== el.value) el.value = v;
            setName(v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && clean) finish(clean);
          }}
        />
        <div class="nx-ob-count" id="nx-ob-count">
          {clean.length}/12 · letters, numbers, spaces
        </div>
        <div class="nx-ob-divider" />
        {email ? (
          <div class="nx-ob-connected">
            <Icon name="check" size={20} color="var(--nx-accent)" />
            <div>
              <div class="nx-ob-connected-t">Google connected</div>
              <div class="nx-ob-connected-e">{email}</div>
            </div>
          </div>
        ) : (
          <>
            <p class="nx-ob-note">Connect Google to sync tasks across devices</p>
            <button class="nx-ob-google press" onClick={() => void google()} disabled={busy} aria-busy={busy}>
              <GoogleG />
              {busy ? 'Connecting…' : 'Continue with Google'}
            </button>
            {error && (
              <p class="nx-ob-err" role="alert">
                {error}
              </p>
            )}
          </>
        )}
        <div class="nx-ob-actions">
          <TextButton onClick={() => finish('')} color="var(--nx-textSec)">
            Skip for now
          </TextButton>
          <PrimaryButton onClick={() => finish(clean)} disabled={!clean}>
            Continue
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
