import {
  buildPdfBlob,
  downloadBlob,
  downloadCanvas,
  renderShareImage,
  shareCanvas,
  sharePdf,
  shareText,
  type SharePayload
} from '../share/export';

type Step = 'pick' | 'image' | 'pdf';

export function showShareSheet(payload: SharePayload, onClose?: () => void): void {
  let step: Step = 'pick';
  let previewCanvas: HTMLCanvasElement | null = null;

  const overlay = document.createElement('div');
  overlay.className = 'nx-overlay nx-overlay-sheet';

  const render = (): void => {
    overlay.innerHTML = `
      <div class="nx-bottom-sheet nx-share-sheet" role="dialog">
        <div class="nx-sheet-grab"></div>
        <div class="nx-share-head">
          ${step !== 'pick' ? '<button type="button" class="nx-btn ghost" data-back>←</button>' : ''}
          <strong>${step === 'pick' ? 'Share' : step === 'image' ? 'Image preview' : 'PDF preview'}</strong>
        </div>
        ${
          step === 'pick'
            ? `<div class="nx-share-options">
                <button type="button" class="nx-share-opt" data-text><span>📝</span> Text <span class="nx-chev">›</span></button>
                <button type="button" class="nx-share-opt" data-image><span>🖼</span> Image <span class="nx-chev">›</span></button>
                <button type="button" class="nx-share-opt" data-pdf><span>📄</span> PDF <span class="nx-chev">›</span></button>
              </div>`
            : step === 'image'
              ? `<div class="nx-share-preview-wrap" data-preview></div>
                 <div class="nx-share-actions">
                   <button type="button" class="nx-btn" data-share>Share</button>
                   <button type="button" class="nx-btn ghost" data-save>Save to device</button>
                 </div>`
              : `<p class="nx-share-pdf-hint">PDF includes title and notes. Use Share or Save to device.</p>
                 <div class="nx-share-actions">
                   <button type="button" class="nx-btn" data-share>Share</button>
                   <button type="button" class="nx-btn ghost" data-save>Save to device</button>
                 </div>`
        }
      </div>`;

    if (step === 'image') {
      previewCanvas = renderShareImage(payload.title, payload.contentBody);
      const slot = overlay.querySelector('[data-preview]') as HTMLElement;
      previewCanvas.style.maxWidth = '100%';
      previewCanvas.style.borderRadius = '12px';
      slot.appendChild(previewCanvas);
    }

    overlay.querySelector('[data-back]')?.addEventListener('click', () => {
      step = 'pick';
      render();
    });
    overlay.querySelector('[data-text]')?.addEventListener('click', async () => {
      await shareText(payload);
      close();
    });
    overlay.querySelector('[data-image]')?.addEventListener('click', () => {
      step = 'image';
      render();
    });
    overlay.querySelector('[data-pdf]')?.addEventListener('click', () => {
      step = 'pdf';
      render();
    });
    overlay.querySelectorAll('[data-share]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (step === 'image' && previewCanvas) await shareCanvas(previewCanvas, 'nexus_share.png');
        else await sharePdf(payload);
        close();
      });
    });
    overlay.querySelectorAll('[data-save]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (step === 'image' && previewCanvas) downloadCanvas(previewCanvas, 'nexus_share.png');
        else downloadBlob(buildPdfBlob(payload.title, payload.contentBody), 'nexus_share.pdf');
        close();
      });
    });
  };

  const close = (): void => {
    overlay.remove();
    onClose?.();
  };

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  document.body.appendChild(overlay);
  render();
}
