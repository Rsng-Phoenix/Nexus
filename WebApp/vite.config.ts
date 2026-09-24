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
      injectManifest: { globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,json}'] },
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
        ],
        // Right-click the Dock / taskbar icon (installed app).
        shortcuts: [
          { name: 'New task', short_name: 'New task', url: './?action=add', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Calendar', short_name: 'Calendar', url: './?open=calendar', icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }] }
        ],
        // Windows 11 Widgets board (installed from Edge). Rendered by the service worker.
        widgets: [
          {
            name: 'Nexus · Today',
            short_name: 'Today',
            description: 'Overdue and due-today tasks and today’s reminders. Tick them off from the widget.',
            tag: 'nexus-today',
            template: 'nexus-today',
            ms_ac_template: 'widgets/today.json',
            data: 'widgets/today-data.json',
            type: 'application/json',
            screenshots: [{ src: 'icons/icon-512.png', sizes: '512x512', label: 'Nexus Today widget' }],
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }],
            auth: false,
            update: 900
          },
          {
            name: 'Nexus · Matrix',
            short_name: 'Matrix',
            description: 'Your four priorities at a glance, with the top tasks in each.',
            tag: 'nexus-matrix',
            template: 'nexus-matrix',
            ms_ac_template: 'widgets/matrix.json',
            data: 'widgets/matrix-data.json',
            type: 'application/json',
            screenshots: [{ src: 'icons/icon-512.png', sizes: '512x512', label: 'Nexus Matrix widget' }],
            icons: [{ src: 'icons/icon-192.png', sizes: '192x192' }],
            auth: false,
            update: 900
          }
        ]
      } as Record<string, unknown>,
    })
  ]
});
