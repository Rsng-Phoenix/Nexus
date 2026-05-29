/** Matches Android `app_logo_png.xml` (ring arcs + diamond quadrants). */
export function nexusLogoHtml(size = 72): string {
  return `<svg class="nx-logo-svg" width="${size}" height="${size}" viewBox="0 0 512 512" aria-hidden="true">
    <path d="M256,32 A224,224 0 0,1 420,92" fill="none" stroke="#00C6FF" stroke-width="20"/>
    <path d="M420,92 A224,224 0 0,1 480,256" fill="none" stroke="#00FF94" stroke-width="20"/>
    <path d="M480,256 A224,224 0 0,1 420,420" fill="none" stroke="#FFD600" stroke-width="20"/>
    <path d="M420,420 A224,224 0 0,1 256,480" fill="none" stroke="#FF6A00" stroke-width="20"/>
    <path d="M256,480 A224,224 0 0,1 92,420" fill="none" stroke="#FF3D6B" stroke-width="20"/>
    <path d="M92,420 A224,224 0 0,1 32,256" fill="none" stroke="#4A90E2" stroke-width="20"/>
    <path d="M32,256 A224,224 0 0,1 92,92" fill="none" stroke="#00C48C" stroke-width="20"/>
    <path d="M92,92 A224,224 0 0,1 256,32" fill="none" stroke="#00C6FF" stroke-width="20"/>
    <path fill="#FF3D6B" d="M256,40 L40,256 L256,256 Z"/>
    <path fill="#FFA500" d="M256,40 L472,256 L256,256 Z"/>
    <path fill="#00C48C" d="M40,256 L256,472 L256,256 Z"/>
    <path fill="#4A90E2" d="M472,256 L256,472 L256,256 Z"/>
  </svg>`;
}
