import { useEffect, useRef, useState } from 'preact/hooks';
import { haptic } from '../lib/haptics';
import { Icon } from './icons';

type Detector = { detect: (src: CanvasImageSource) => Promise<{ rawValue: string }[]> };
declare const BarcodeDetector: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } | undefined;

/**
 * Live camera QR reader. Uses the browser's BarcodeDetector where it exists (Chrome, Android)
 * and falls back to jsQR (loaded only when the camera opens) on Safari / iPhone.
 * [accept] returns true when the text is what we were looking for (then the scanner stops).
 */
export function QrScanner({ accept, onCancel }: { accept: (text: string) => boolean; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<'starting' | 'live' | 'found' | 'denied' | 'none'>('starting');
  const [hint, setHint] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let raf = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let lastWrong = '';

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) return setState('none');
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
      } catch (e) {
        return setState(e instanceof DOMException && e.name === 'NotAllowedError' ? 'denied' : 'none');
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => {});
      setState('live');

      let detector: Detector | null = null;
      try {
        if (typeof BarcodeDetector !== 'undefined' && (await BarcodeDetector.getSupportedFormats?.())?.includes('qr_code')) detector = new BarcodeDetector({ formats: ['qr_code'] });
      } catch {
        detector = null;
      }
      const jsqr = detector ? null : (await import('jsqr')).default;
      let busy = false;
      const tick = async () => {
        if (stopped) return;
        raf = requestAnimationFrame(() => void tick());
        if (busy || v.readyState < 2 || !v.videoWidth) return;
        busy = true;
        try {
          let text: string | null = null;
          if (detector) {
            text = (await detector.detect(v))[0]?.rawValue ?? null;
          } else if (jsqr && ctx) {
            const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
            canvas.width = Math.round(v.videoWidth * scale);
            canvas.height = Math.round(v.videoHeight * scale);
            ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            text = jsqr(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
          }
          if (text) {
            if (accept(text)) {
              stopped = true;
              haptic('DRAG_DROP');
              setState('found');
            } else if (text !== lastWrong) {
              lastWrong = text;
              setHint("That's not a Nexus code");
            }
          }
        } finally {
          busy = false;
        }
      };
      void tick();
    };
    void start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div class={`nx-scan ${state}`}>
      <video ref={video} playsInline muted />
      <div class="frame" aria-hidden="true">
        <i class="c tl" />
        <i class="c tr" />
        <i class="c bl" />
        <i class="c br" />
        <span class="line" />
      </div>
      <p class="msg" role="status">
        {state === 'starting' && 'Opening the camera…'}
        {state === 'live' && (hint || 'Point at the Nexus code on your other device')}
        {state === 'found' && 'Got it'}
        {state === 'denied' && 'Camera access is off. Allow it in your browser settings, or open the link instead.'}
        {state === 'none' && 'No camera here. Show the code on this device and scan it with your phone instead.'}
      </p>
      <button class="close press" onClick={onCancel} aria-label="Close camera">
        <Icon name="close" size={22} />
      </button>
    </div>
  );
}
