// 控制台前端原始碼在這裡；`npm run build:console` 產出單一檔案 public/discord-console.html。
// 產物同時是伺服器唯一會讀的頁面（src/core/discord-console.mjs），所以 build 要把 JS／CSS 全部內嵌。
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { fileURLToPath } from 'node:url';
import { consoleSourceHash } from '../scripts/console-source-hash.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const sourceHash = consoleSourceHash(fileURLToPath(new URL('..', import.meta.url)));

export default defineConfig({
  // 設定檔在 console/，但 vite 的 root 預設是工作目錄，這裡固定成原始碼目錄。
  root: ROOT,
  plugins: [
    vue(),
    {
      // 產物記下原始碼指紋；scripts/build-console.mjs --check 靠它抓忘記重建。
      name: 'console-source-stamp',
      transformIndexHtml: (html) => html.replace('</head>', `<!-- console-source:${sourceHash} -->\n</head>`),
    },
    viteSingleFile(),
  ],
  build: {
    outDir: '../public',
    emptyOutDir: false,
    // 入口刻意叫 discord-console.html：輸出檔名沿用入口，伺服器只讀這一個檔案。
    rollupOptions: { input: 'discord-console.html' },
  },
  // 開發時 `npm run dev:console`：頁面走 vite，/api 交給本機跑著的控制台（預設 3110）。
  server: {
    proxy: { '/api': 'http://127.0.0.1:3110' },
  },
});
