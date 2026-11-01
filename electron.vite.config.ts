import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      // chokidar is ESM-only; bundle it so the CJS main process can load it.
      externalizeDeps: { exclude: ['chokidar'] }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
