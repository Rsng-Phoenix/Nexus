import '../styles/tour.css';
import { useEffect, useState } from 'preact/hooks';
import { nexusLogoHtml } from '../ui/nexus-logo';
import { reducedMotion } from './motion';

/**
 * Port of NexusSplashScreen: ~1s total. Quadrants converge (420ms), then N-E-X-U-S springs in
 * 45ms apart starting at 180ms, a 560ms hold, and a 240ms fade out.
 */
export function Splash({ onDone }: { onDone: () => void }) {
  const [reduced] = useState(reducedMotion);
  const [out, setOut] = useState(false);

  useEffect(() => {
    const fadeAt = reduced ? 200 : 180 + 560;
    const fadeMs = reduced ? 300 : 240;
    let t2 = 0;
    const t1 = window.setTimeout(() => {
      setOut(true);
      t2 = window.setTimeout(onDone, fadeMs);
    }, fadeAt);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div class={`nx-splash${out ? ' out' : ''}${reduced ? ' reduced' : ''}`} role="status" aria-label="Nexus, priority matrix">
      <div class="nx-splash-center" aria-hidden="true">
        <div class="nx-splash-logo" dangerouslySetInnerHTML={{ __html: nexusLogoHtml(96) }} />
        <div class="nx-splash-word">
          {'NEXUS'.split('').map((c, i) => (
            <span key={i} class="nx-splash-letter" style={{ animationDelay: `${180 + i * 45}ms` }}>
              {c}
            </span>
          ))}
        </div>
        <div class="nx-splash-sub">priority matrix</div>
      </div>
      <div class="nx-splash-credits">
        <div class="nx-splash-dev">Developed by Priyanshu Pradhan</div>
        <div class="nx-splash-ver">v3.6 · 2025 - 2026</div>
      </div>
    </div>
  );
}
