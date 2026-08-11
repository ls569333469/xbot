import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
  // Production is mounted below /xbot/. Local development remains at /.
  base: process.env.VITE_PUBLIC_BASE || (command === 'build' ? '/xbot/' : '/'),
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
}))
