import { createReadStream, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// A project site is published at https://<user>.github.io/<repository>/.
// This derives that path automatically in GitHub Actions while keeping '/' locally.
const repository = process.env.GITHUB_REPOSITORY?.split('/')[1]
const isUserSite = repository?.endsWith('.github.io')
const localDatasetPath = fileURLToPath(new URL('./public/data/atlas-sample.zip', import.meta.url))

function localDatasetPlugin(): Plugin {
  const serveDataset = (middlewares: Connect.Server) => {
    middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/data/atlas-sample.zip') {
        next()
        return
      }
      const size = statSync(localDatasetPath).size
      response.setHeader('Content-Type', 'application/zip')
      response.setHeader('Content-Length', size)
      const stream = createReadStream(localDatasetPath)
      stream.on('error', next)
      stream.pipe(response)
    })
  }

  return {
    name: 'serve-local-release-dataset',
    configureServer: (server) => serveDataset(server.middlewares),
    configurePreviewServer: (server) => serveDataset(server.middlewares),
  }
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS && repository && !isUserSite ? `/${repository}/` : '/',
  plugins: [react(), localDatasetPlugin()],
  // Dataset build inputs stay under public/data, but only this small directory
  // is copied into the deployed site. The database itself lives in Releases.
  publicDir: 'site-public',
})
