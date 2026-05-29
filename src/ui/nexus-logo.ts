/** SVG matching Android NexusLogoCanvas: diamond quadrants + sweep-gradient ring */
export function nexusLogoHtml(size = 72): string {
  const s = size;
  const cx = s / 2;
  const cy = s / 2;
  const r = s * 0.46;
  const d = r * 0.72;
  const uid = `nx-${Math.random().toString(36).slice(2, 9)}`;
  return `<svg class="nx-logo-svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" aria-hidden="true">
    <defs>
      <linearGradient id="${uid}-ring" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#FF4060"/>
        <stop offset="33%" stop-color="#FFAA00"/>
        <stop offset="66%" stop-color="#3B9EFF"/>
        <stop offset="100%" stop-color="#00D084"/>
      </linearGradient>
    </defs>
    <polygon points="${cx},${cy - d} ${cx - d},${cy} ${cx},${cy}" fill="#FF4060"/>
    <polygon points="${cx},${cy - d} ${cx + d},${cy} ${cx},${cy}" fill="#FFAA00"/>
    <polygon points="${cx + d},${cy} ${cx},${cy + d} ${cx},${cy}" fill="#3B9EFF"/>
    <polygon points="${cx - d},${cy} ${cx},${cy + d} ${cx},${cy}" fill="#00D084"/>
    <line x1="${cx}" y1="${cy - d}" x2="${cx}" y2="${cy + d}" stroke="rgba(255,255,255,0.12)" stroke-width="0.6"/>
    <line x1="${cx - d}" y1="${cy}" x2="${cx + d}" y2="${cy}" stroke="rgba(255,255,255,0.12)" stroke-width="0.6"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#${uid}-ring)" stroke-width="2.5" stroke-linecap="round"/>
  </svg>`;
}
