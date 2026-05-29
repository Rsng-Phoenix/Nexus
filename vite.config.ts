import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon.svg'],
      manifest: {
        name: 'Nexus',
        short_name: 'Nexus',
        description: 'Priority matrix — syncs with Nexus Android',
        theme_color: '#080810',
        background_color: '#080810',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: './',
        start_url: './',
        icons: [
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: 'index.html'
      }
    })
  ]
});
