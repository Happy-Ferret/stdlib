import * as http from 'http'
import * as path from 'path'
import * as url from 'url'
import * as fs from 'fs'
import std from './main'

export interface Request extends http.IncomingMessage {
  params: any
  body: any
}

type Controller = (req: Request, res: http.ServerResponse) => any

export interface Router {
  (req: http.IncomingMessage, res: http.ServerResponse): void
  get: (path: string, fn: Controller) => void
  post: (path: string, fn: Controller) => void
  put: (path: string, fn: Controller) => void
  delete: (path: string, fn: Controller) => void
}

const mimes = new Map([
  ['.js', 'application/javascript'],
  ['.css', 'text/css'],
  ['.html', 'text/html'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
])

const getMimeType = (m: string) => mimes.get(path.extname(m)) || 'text/html'

const makeFileSender = (publicPath: string) => async (res: http.ServerResponse, filename: string) => {
  res.setHeader('Content-Type', getMimeType(filename))
  const fullpath = path.join(publicPath, filename)
  const fileExists = await std.fs.exists(fullpath)
  if (!fileExists) return console.log(`${fullpath} does not exist`)
  return fs.createReadStream(fullpath).pipe(res)
}

const bodyReader = (req: http.IncomingMessage): Promise<string> => new Promise((done, fail) => {
  let data = ''
  req.on('data', m => data += m)
  req.on('end', () => done(data))
  req.on('error', fail)
})

const makeRouter = (routePrefix = '/api', cors?: string) => {
  type HttpHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void
  interface Param {
    key: string
    ix: number
  }

  interface Route {
    matcher: RegExp
    params: Param[]
    method: string
    fn: Controller
  }

  const routes: Route[] = []
  const routePrefixMatcher = new RegExp(`^${routePrefix}`)

  const addRoute = ({ method, path, fn }: { method: string, path: string, fn: HttpHandler }) => {
    const parts = path.match(/\/[\w:]+/g) || []
    const params = parts.reduce((res, path, ix) => (/^\/:/.test(path) && res.push({
      key: path.slice(2),
      ix,
    }), res), [] as Param[])

    const regex = parts.reduce((res, path) => /^\/:/.test(path)
      ? res += '\/((?:[^\/]+?))'
      : res += `\\${path}`, '')

    const matcher = new RegExp(`^${regex}(?:\/(?=$))?$`, 'i')
    routes.push({ matcher, params, fn, method: method.toUpperCase() })
  }

  const getController = ({ path, method }: { path: string, method: string }) => {
    const route = routes.find(m => m.matcher.test(path) && m.method === method)
    if (!route) return {}
    const paths = path.match(/\/\w+/g) || []
    const params = route.params.reduce((res, m) => ({ ...res, [m.key]: paths[m.ix].slice(1) }), {})
    return { params, controller: route.fn }
  }

  const router = async (req: Request, res: http.ServerResponse) => {
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', cors)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, X-Requested-With')
      if (req.method === 'OPTIONS') return (res.writeHead(200), res.end())
    }

    const { pathname = '' } = url.parse(req.url!)
    const routeName = pathname.replace(routePrefixMatcher, '')
    const { controller, params } = getController({ method: req.method!, path: routeName })

    if (!controller) {
      console.warn('no route found:', pathname)
      return res.writeHead(404).end()
    }

    const contentType = req.headers['content-type']
    req.params = params

    if (req.method === 'POST') {
      const data = await bodyReader(req)
      req.body = contentType === 'application/json'
        ? std.parseJSON(data)
        : data
    }

    let response
    try {
      response = await controller(req, res)
    } catch(e) {
      console.error(e)
      res.write(JSON.stringify({ error: 'something went wrong on the server' }))
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end()
      return
    }

    const resData = std.is.object(response)
      ? JSON.stringify(response)
      : response

    if (std.is.object(response)) res.writeHead(200, { 'content-type': 'application/json' })

    res.end(resData)
  }

  const api = new Proxy(router, {
    get: (_, method: string) => (path: string, fn: HttpHandler) => addRoute({ method, path, fn }),
  })

  return api as unknown as Router
}

export default { makeRouter, makeFileSender }
