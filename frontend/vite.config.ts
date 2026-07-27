import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // Production may be mounted below /xbot/ while local development stays at /.
  base: process.env.VITE_PUBLIC_BASE || '/',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3011',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3011',
        ws: true,
      }
    }
  }
})
