import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // ws：Shell 模式的终端走 WebSocket；AGENTCTL_API 可以指向别的实例（例如 8799 上的测试实例）
      '/api': { target: process.env.AGENTCTL_API ?? 'http://127.0.0.1:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
