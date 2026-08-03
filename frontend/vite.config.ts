import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    hmr: {
      host: '192.168.1.199',
      port: 5173,
    },
    proxy: {
      '/api': {
        target: 'http://localhost:13132',
        changeOrigin: true,
      },
    },
  },
})