import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Plugin } from 'vite'

export const DEV_PORT = 1420

const HOSTS = new Set([`localhost:${DEV_PORT}`, `127.0.0.1:${DEV_PORT}`])

function home(): string {
  const dir = process.env.VAQUITA_HOME
  return resolve(dir ? dir : join(homedir(), 'Library', 'Application Support', 'vaquita'))
}

// Dev-only: hands the daemon endpoint (which holds the token) to a page served by
// this dev server. The Host and Sec-Fetch-Site checks keep other local pages and
// cross-origin fetches out. No CORS headers are ever added.
export function vaquitaDevEndpoint(): Plugin {
  return {
    name: 'vaquita-dev-endpoint',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__vaquita/endpoint', async (req, res) => {
        const url = req.url ?? ''
        if (
          !(url === '' || url === '/' || url.startsWith('?')) ||
          req.method !== 'GET' ||
          !HOSTS.has(req.headers.host ?? '') ||
          req.headers['sec-fetch-site'] !== 'same-origin'
        ) {
          res.statusCode = 403
          res.end()
          return
        }
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Content-Type', 'application/json')
        try {
          res.statusCode = 200
          res.end(await readFile(join(home(), 'endpoint.json')))
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            res.statusCode = 503
            res.end('{"error":"not-running"}')
          } else {
            // Log only the error code; the file holds the token.
            server.config.logger.error(`vaquita dev endpoint: read failed (${(e as NodeJS.ErrnoException).code})`)
            res.statusCode = 500
            res.end('{"error":"read failed"}')
          }
        }
      })
    },
  }
}
