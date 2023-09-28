import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import type { ChronocatSatoriServerConfig } from '../config/types'
import type { DispatchMessage } from '../dispatch'
import { selfProfile } from '../ipc/globalVars'
import { timeout } from '../utils/time'
import index from './index.html'
import type { Routes } from './routes'
import { routes } from './routes'
import type { WebSocketIncomingMessage } from './types'
import { Op } from './types'

declare const __DEFINE_CHRONO_VERSION__: string

const prefix = '/v1/'
const poweredBy = `Chronocat/${__DEFINE_CHRONO_VERSION__}`

const buildEventIdCounter = () => {
  let i = 0
  return () => ++i
}

export const initSatoriServer = async (config: ChronocatSatoriServerConfig) => {
  // 预处理 self_url
  if (!config.self_url || config.self_url === 'https://chronocat.vercel.app')
    config.self_url = `http://127.0.0.1:${config.port}`
  if (config.self_url.endsWith('/'))
    config.self_url = config.self_url.slice(0, config.self_url.length - 1)

  const authorizedClients: WebSocket[] = []

  const getId = buildEventIdCounter()

  const server = createServer((req, res) => {
    if (!req.url) {
      res.writeHead(400)
      res.end('404 bad request')
      return
    }

    const url = new URL(req.url, `http://${req.headers.host}`)

    res.setHeader('Server', poweredBy)
    res.setHeader('X-Powered-By', poweredBy)

    if (url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=UTF-8',
        'Cache-Control': 'no-cache',
        'Content-Length': index.byteLength,
      })
      res.end(index)
    }

    if (
      config.token &&
      !(
        req.headers.authorization?.slice(0, 7) === 'Bearer ' &&
        req.headers.authorization.slice(7) === config.token
      )
    ) {
      res.writeHead(401)
      res.end('401 unauthorized')
      return
    }

    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(404)
      res.end('404 not found')
      return
    }

    const method = routes[url.pathname.slice(prefix.length) as Routes]

    if (!method) {
      res.writeHead(404)
      res.end('404 not found')
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(400)
      res.end('400 bad request')
      return
    }

    try {
      const result = method(buildRouteCtx(req, res))

      if (!res.writableEnded) {
        res.writeHead(200, {
          'Content-Type': 'application/json',
        })
        res.end(JSON.stringify(result))
      }

      return
    } catch (e) {
      console.log(e)

      res.writeHead(500)
      res.end('500 internal server error')

      return
    }
  })

  const wsServer = new WebSocketServer({
    server,
    path: prefix + 'event',
  })

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  wsServer.on('connection', async (ws) => {
    let authorized = false

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    ws.on('message', async (raw) => {
      const message = JSON.parse(
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        raw.toString(),
      ) as WebSocketIncomingMessage

      switch (message.op) {
        case Op.Ping: {
          ws.send(
            JSON.stringify({
              op: Op.Pong,
            }),
          )
          return
        }

        case Op.Identify: {
          if (authorized) {
            ws.send(
              JSON.stringify({
                op: Op.Event,
                body: {
                  id: getId(),
                  platform: 'chronocat',
                  self_id: selfProfile.value!.uin,
                  timestamp: new Date().getTime(),
                  type: 'chrono-unsafe-warning-2132',
                },
              }),
            )
            return
          }

          if (config.token && message.body?.token !== config.token) {
            ws.close(3000, 'Unauthorized')
            return
          }

          authorized = true
          authorizedClients.push(ws)
          ws.on('close', () =>
            authorizedClients.splice(authorizedClients.indexOf(ws), 1),
          )

          ws.send(
            JSON.stringify({
              op: Op.Ready,
            }),
          )

          return
        }

        default: {
          ws.send(
            JSON.stringify({
              op: Op.Event,
              body: {
                id: getId(),
                platform: 'chronocat',
                self_id: selfProfile.value!.uin,
                timestamp: new Date().getTime(),
                type: 'chrono-unsafe-warning-2133',
              },
            }),
          )
          return
        }
      }
    })

    setTimeout(() => {
      if (!authorized) ws.close(3000, 'Unauthorized')
    }, timeout)
  })

  const dispatcher = (message: DispatchMessage) =>
    authorizedClients.forEach(
      (ws) =>
        void message.toSatori(config).then((events) =>
          events.forEach((body) =>
            ws.send(
              JSON.stringify({
                op: Op.Event,
                body: {
                  ...body,
                  id: getId(),
                },
              }),
            ),
          ),
        ),
    )

  server.listen(config.port, config.listen)

  return {
    dispatcher,
  }
}

function buildRouteCtx(
  req: IncomingMessage,
  res: ServerResponse<IncomingMessage>,
) {
  const buffer = () => {
    const chunks: Buffer[] = []
    return new Promise<Buffer>((resolve, reject) => {
      req.on('data', (chunk) => {
        chunks.push(chunk as Buffer)
      })
      req.on('end', () => {
        resolve(Buffer.concat(chunks))
      })
      req.on('error', () => {
        reject()
      })
    })
  }

  const string = () => buffer().then((b) => b.toString('utf-8'))

  const json = () => string().then((s) => JSON.parse(s) as unknown)

  return {
    req,
    res,
    buffer,
    string,
    json,
  }
}