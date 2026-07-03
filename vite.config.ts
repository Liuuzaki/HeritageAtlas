import { spawn } from 'node:child_process'
import { defineConfig, type Connect, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// A project site is published at https://<user>.github.io/<repository>/.
// This derives that path automatically in GitHub Actions while keeping '/' locally.
const repository = process.env.GITHUB_REPOSITORY?.split('/')[1]
const isUserSite = repository?.endsWith('.github.io')
const releaseDatasetUrl = 'https://github.com/Liuuzaki/HeritageAtlas/releases/latest/download/atlas-sample.zip'

function startReleaseDownload() {
  const executable = process.platform === 'win32' ? 'curl.exe' : 'curl'
  return spawn(executable, ['--fail', '--location', '--silent', '--show-error', '--no-buffer', releaseDatasetUrl])
}

function releaseDatasetPlugin(): Plugin {
  const serveDataset = (middlewares: Connect.Server) => {
    middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/data/atlas-sample.zip') {
        next()
        return
      }
      const downloader = startReleaseDownload()
      let errorOutput = ''
      downloader.stderr.on('data', (chunk: Buffer) => { errorOutput += chunk.toString() })
      downloader.on('error', next)
      response.setHeader('Content-Type', 'application/zip')
      downloader.stdout.pipe(response)
      downloader.on('close', (code) => {
        if (code !== 0) {
          if (!response.headersSent) {
            response.statusCode = 502
            response.end(errorOutput || 'Could not download the latest atlas release.')
          } else {
            response.destroy(new Error(errorOutput || 'Could not download the latest atlas release.'))
          }
        }
      })
    })
  }

  return {
    name: 'serve-latest-release-dataset',
    configureServer: (server) => serveDataset(server.middlewares),
    configurePreviewServer: (server) => serveDataset(server.middlewares),
  }
}

export default defineConfig({
  base: process.env.GITHUB_ACTIONS && repository && !isUserSite ? `/${repository}/` : '/',
  plugins: [react(), releaseDatasetPlugin()],
  // Dataset build inputs stay under public/data, but only this small directory
  // is copied into the deployed site. The database itself lives in Releases.
  publicDir: 'site-public',
})
