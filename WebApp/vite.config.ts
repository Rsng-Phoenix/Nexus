import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Content-Security-Policy for production builds: the page may only run its own scripts and
 * talk to Google sign-in/Drive and the Nexus reminder relay. Added at build time so the dev
 * server's hot-reload still works.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
  "img-src 'self' data: blob: https://*.googleusercontent.com",
  "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://accounts.google.com https://nexus-push.priyanshupradhan0204.workers.dev https://raw.githubusercontent.com",
  'frame-src https://accounts.google.com',
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

const securityHeaders = {
  name: 'nexus-csp',
  apply: 'build' as const,
  transformIndexHtml(html: string) {
    return html.replace(
      '<meta charset="UTF-8" />',
      `<meta charset="UTF-8" />\n  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  <meta name="referrer" content="strict-origin-when-cross-origin" />`
    );
  }
};

export default defineConfig({
  base: './',
  plugins: [
    securityHeaders,
    VitePWA({
      registerType: 'autoUpdate',
      // Custom service worker: offline shell + reminder notifications (src/sw.ts).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectManifest: { globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'] },
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'Nexus',
        short_name: 'Nexus',
        description: 'Priority matrix — syncs with Nexus Android',
        theme_color: '#080810',
        background_color: '#080810',
        display: 'standalone',
        orientation: 'any',
        scope: './',
        start_url: './',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' }
        ]
      },
    })
  ]
});
