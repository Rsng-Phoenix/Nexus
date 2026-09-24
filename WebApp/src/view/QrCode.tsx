import type { JSX } from 'preact';
import { useMemo } from 'preact/hooks';
import { encode } from 'uqr';
import { nexusLogoHtml } from '../ui/nexus-logo';

const POSITION = 2;

/**
 * A QR code drawn as round dots that ripple in from the centre, with rounded finder corners and
 * the Nexus mark in the middle (error correction H keeps it readable with the logo on top).
 */
export function QrCode({ text, size = 240 }: { text: string; size?: number }) {
  const qr = useMemo(() => encode(text, { ecc: 'H', border: 0 }), [text]);
  const n = qr.size;
  const mid = (n - 1) / 2;
  const logo = Math.round(n * 0.22) | 1; // odd, so it sits exactly in the middle
  const lo = Math.floor(mid - logo / 2);
  const hi = lo + logo;
  const maxD = Math.hypot(mid, mid);

  const dots: JSX.Element[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!qr.data[y][x] || qr.types[y][x] === POSITION) continue;
      if (x >= lo && x < hi && y >= lo && y < hi) continue;
      const d = Math.hypot(x - mid, y - mid) / maxD;
      dots.push(<circle key={`${x}.${y}`} cx={x + 0.5} cy={y + 0.5} r={0.42} style={{ '--d': d.toFixed(3) } as JSX.CSSProperties} />);
    }
  }
  const finder = (x: number, y: number) => (
    <g key={`f${x}.${y}`} class="finder">
      <rect x={x + 0.5} y={y + 0.5} width={6} height={6} rx={1.9} fill="none" stroke-width={1} />
      <rect x={x + 2} y={y + 2} width={3} height={3} rx={0.9} />
    </g>
  );

  return (
    <div class="nx-qr" style={{ width: `${size}px`, height: `${size}px` }} role="img" aria-label="QR code">
      <svg viewBox={`-1 -1 ${n + 2} ${n + 2}`} width={size} height={size}>
        <rect x={-1} y={-1} width={n + 2} height={n + 2} rx={2.4} class="bg" />
        <g class="dots">{dots}</g>
        {finder(0, 0)}
        {finder(n - 7, 0)}
        {finder(0, n - 7)}
      </svg>
      <span class="logo" style={{ width: `${(logo / (n + 2)) * 100}%`, height: `${(logo / (n + 2)) * 100}%` }} dangerouslySetInnerHTML={{ __html: nexusLogoHtml(64) }} />
    </div>
  );
}
