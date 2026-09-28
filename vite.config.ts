import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// GitHub Pages 網址在子路徑（/taiwan-mahjong/），用相對路徑最保險
export default defineConfig({
  base: './',
  build: { target: 'es2020', assetsDir: 'static' },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['assets/**/*', 'icons/*'],
      manifest: {
        name: '台灣麻將',
        short_name: '台灣麻將',
        description: '台灣 16 張麻將，開房連線或單人對 AI，純娛樂。',
        lang: 'zh-Hant-TW',
        start_url: './',
        scope: './',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'landscape',
        background_color: '#0e4a2f',
        theme_color: '#145638',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
