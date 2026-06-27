import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// A project site is published at https://<user>.github.io/<repository>/.
// This derives that path automatically in GitHub Actions while keeping '/' locally.
const repository = process.env.GITHUB_REPOSITORY?.split('/')[1]
const isUserSite = repository?.endsWith('.github.io')

export default defineConfig({
  base: process.env.GITHUB_ACTIONS && repository && !isUserSite ? `/${repository}/` : '/',
  plugins: [react()],
})
