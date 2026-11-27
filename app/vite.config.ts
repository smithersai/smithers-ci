import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { resolve } from "node:path"

export default defineConfig({
  root: resolve(process.cwd(), "app"),
  publicDir: resolve(process.cwd(), "app/public"),
  plugins: [react()],
  build: {
    outDir: resolve(process.cwd(), "dist/ui"),
    emptyOutDir: true
  },
  server: {
    port: 5179,
    strictPort: false
  }
})
