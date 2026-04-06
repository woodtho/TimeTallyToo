import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Custom domain timetally.ca serves from the root, so base must be "/".
  // GitHub redirects woodtho.github.io/TimeTallyToo/* to the custom domain.
  base: "/",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
})
