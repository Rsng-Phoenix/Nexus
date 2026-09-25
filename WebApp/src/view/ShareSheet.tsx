import '../styles/sheets.css';
import { useMemo, useState } from 'preact/hooks';
import { shareFileName } from '../share/doc';
import { canvasPng, downloadBlob, shareFile, shareText, type SharePayload } from '../share/export';
import { pagesToPdf, renderShareCard, renderSharePages } from '../share/render';
import { showSnack } from '../state/toasts';
import type { LayerProps } from './App';
import { Icon, type IconName } from './icons';
import { Chevron, IconButton, PrimaryButton, Sheet } from './kit';

type Step = 'pick' | 'image' | 'pdf';


/** ShareExportSheet (MainActivity.kt): pick a format, preview, then share or save. */
export function ShareSheet(p: LayerProps & { payload: SharePayload }) {
  const { payload } = p;
  const [step, setStep] = useState<Step>('pick');
  const [wentBack, setWentBack] = useState(false);
  const [busy, setBusy] = useState(false);

  // Drawn once per format, only when its preview is first opened.
  const [card, setCard] = useState<HTMLCanvasElement | null>(null);
  const [pages, setPages] = useState<HTMLCanvasElement[] | null>(null);
  const preview = useMemo(() => {
    const c = step === 'pdf' ? pages?.[0] : step === 'image' ? card : null;
    return c ? c.toDataURL(step === 'pdf' ? 'image/jpeg' : 'image/png', 0.85) : '';
  }, [step, card, pages]);
  const doc = payload.doc;

  const openPreview = (s: Exclude<Step, 'pick'>) => {
    if (s === 'image' && !card) setCard(renderShareCard(doc));
    if (s === 'pdf' && !pages) setPages(renderSharePages(doc));
    setWentBack(false);
    setStep(s);
  };
  const fileBlob = async () => (step === 'pdf' ? pagesToPdf(pages ?? renderSharePages(doc), doc.title) : canvasPng(card ?? renderShareCard(doc)));
  const fileName = () => shareFileName(doc, step === 'pdf' ? 'pdf' : 'png');

  const back = () => {
    setWentBack(true);
    setStep('pick');
  };

  const guard = async (fn: () => Promise<void> | void, closeAfter: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      if (closeAfter) p.onDismiss();
    } catch {
      showSnack("Couldn't share that");
    } finally {
      setBusy(false);
    }
  };

  const sendText = () =>
    guard(async () => {
      const fellBack = typeof navigator.share !== 'function';
      await shareText(payload);
      if (fellBack) showSnack('Copied to clipboard');
    }, true);

  const share = () => guard(async () => shareFile(await fileBlob(), fileName(), payload.subject), true);

  const save = () =>
    guard(async () => {
      downloadBlob(await fileBlob(), fileName());
      showSnack(`Saved ${fileName()}`);
    }, false);

  const previewing = step !== 'pick';

  return (
    <Sheet
      leaving={p.leaving}
      onExited={p.onExited}
      onDismiss={p.onDismiss}
      radius={28}
      class={`nx-sh-sheet ${previewing ? 'preview' : ''}`}
    >
      <div class="nx-sh-body">
        <div class="nx-sh-head">
          {previewing && <IconButton icon="back" label="Back to formats" onClick={back} />}
          <div class="nx-sh-head-text">
            <div class="nx-sh-title">{step === 'image' ? 'Image' : step === 'pdf' ? 'PDF' : 'Share'}</div>
            <div class="nx-sh-sub" title={payload.title}>{payload.title}</div>
          </div>
        </div>

        {step === 'pick' ? (
          <div class={`nx-sh-step ${wentBack ? 'back' : ''}`} key="pick">
            <ShareOption icon="text" title="Text" subtitle="For chats: bold title, dates, ☐ checklist" onClick={() => void sendText()} />
            <ShareOption icon="image" title="Image" subtitle="A Nexus card with priority, dates and checklist" onClick={() => openPreview('image')} />
            <ShareOption icon="pdf" title="PDF" subtitle="Printable A4 pages · any language" onClick={() => openPreview('pdf')} />
          </div>
        ) : (
          <div class="nx-sh-step" key={step}>
            <div class="nx-sh-preview">
              <div class="nx-sh-card">
                {preview && <img src={preview} alt={`Preview of ${payload.title}`} />}
                {step === 'pdf' && <span class="nx-sh-badge">{pages && pages.length > 1 ? `PDF · ${pages.length} pages` : 'PDF'}</span>}
              </div>
            </div>
            <div class="nx-sh-actions">
              <button class="nx-sh-save press" onClick={() => void save()} disabled={busy}>
                <Icon name="download" size={18} />
                Save
              </button>
              <PrimaryButton icon="share" onClick={() => void share()} disabled={busy}>
                Share
              </PrimaryButton>
            </div>
          </div>
        )}
      </div>
    </Sheet>
  );
}

function ShareOption({ icon, title, subtitle, onClick }: { icon: IconName; title: string; subtitle: string; onClick: () => void }) {
  return (
    <button class="nx-sh-opt press clickable" onClick={onClick}>
      <Icon name={icon} size={22} />
      <span class="nx-sh-opt-text">
        <span class="nx-sh-opt-title">{title}</span>
        <span class="nx-sh-opt-sub">{subtitle}</span>
      </span>
      <Chevron />
    </button>
  );
}
