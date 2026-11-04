import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5175,
    proxy: {
      // 开发时 API 转发到本地 studio 服务（node server.js）
      '/api': 'http://localhost:8098',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
