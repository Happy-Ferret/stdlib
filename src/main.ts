import httpServer from './http-server'
import fakeModule from './fake-module'
import * as cp from 'child_process'
import shellEnv from './shell-env'
import { Transform } from 'stream'
import * as pth from 'path'
import * as net from 'net'
import * as os from 'os'
import fs from './fs'

export interface CancelPromise<T> {
  promise: Promise<T>
  cancel: () => any
}

export interface PromiseBossOptions {
  timeout?: number
}

export interface ITask<T> {
  done: (value: T) => void
  promise: Promise<T>
}

type TypeChecker = (thing: any) => boolean

interface Types {
  string: TypeChecker
  number: TypeChecker
  array: TypeChecker
  object: TypeChecker
  null: TypeChecker
  asyncfunction: TypeChecker
  function: TypeChecker
  promise: TypeChecker
  map: TypeChecker
  set: TypeChecker
}

const arrReplace = <T>(arr: T[], matcher: (val: T) => any, patch: Partial<T>): T[] | undefined => {
  const foundIndex = arr.findIndex(matcher)
  if (!~foundIndex) return
  const copy = [...arr]
  const itemToPatch = copy[foundIndex]
  const patchedItem = { ...itemToPatch, ...patch }
  copy.splice(foundIndex, 1, patchedItem)
  return copy
}

const listof = <T>(count: number, fn: (index: number) => T) => {
  const resultList: T[] = []
  for (let ix = 0; ix < count; ix++) {
    resultList.push(fn(ix))
  }
  return resultList
}

const minmax = (min: number, max: number) => (...numbers: number[]) => {
  return Math.min(max, Math.max(min, ...numbers))
}

const pathParts = (path: string) => {
  const properPath = pth.normalize(path)
  const parts = properPath.split(pth.sep)
  const { root } = pth.parse(properPath)
  return [ root, ...parts ].filter(m => m)
}

const resolvePath = (path: string, dir: string) => {
  if (path.startsWith('/')) return pth.resolve(path)
  if (path.startsWith('~/')) return pth.resolve(path.replace(/^~\//, `${os.homedir()}/`))
  if (path.startsWith('./') || path.startsWith('../')) return pth.join(dir, path)
}

const pathReducer = (p = '') => ((p, levels = 0) => ({ reduce: () =>
  levels ? pth.basename(pth.join(p, '../'.repeat(levels++))) : (levels++, pth.basename(p))
}))(p)

const isOnline = (host = 'google.com') => new Promise(fin => {
  require('dns').lookup(host, (e: any) => fin(!(e && e.code === 'ENOTFOUND')))
})

const findIndexRight = (line: string, pattern: RegExp, start: number) => {
  for (let ix = start || line.length; ix > 0; ix--) {
    if (pattern.test(line[ix])) return ix
  }
}

const EarlyPromise = (init: (resolve: (resolvedValue: any) => void, reject: (error: any) => void) => void) => {
  let delayExpired = false
  const promise = new Promise(init)
  const eventually = (cb: (value: any) => void) => promise.then(val => delayExpired && cb(val))
  const maybeAfter = ({ time, or: defaultValue }: { time: number, or: any }) => Promise.race([
    promise.then(val => !delayExpired ? val : undefined),
    new Promise(fin => setTimeout(() => (delayExpired = true, fin(defaultValue)), time))
  ])

  return { maybeAfter, eventually, fail: promise.catch }
}

const requireDir = async (path: string) => (await fs.getDirFiles(path))
  .filter(m => m.file)
  .filter(m => pth.extname(m.name) === '.js')
  .map(m => require(m.path))

function debounce (fn: Function, wait = 1) {
  if (!fn) throw new Error('bruh, ya need a function here!')
  let timeout: NodeJS.Timer
  return function(this: any, ...args: any[]) {
    const ctx = this
    clearTimeout(timeout)
    timeout = setTimeout(() => fn.apply(ctx, args), wait)
  }
}

const throttle = (fn: (...args: any[]) => void, delay: number) => {
  let throttling = false
  let args: any[] | undefined

  const executor = (...a: any[]) => {
    if (throttling) return (args = a, undefined)
    throttling = true
    fn(...a)
    setTimeout(() => (throttling = false, args && (executor(...args), args = undefined)), delay)
  }

  return executor
}

const flatobj = (obj: any, path = ''): [string, any][] => {
  if (!api.is.object(obj)) return [ [path, obj] ]
  const loc = (key: string) => [path, key].join('.')
  return Object
    .entries(obj)
    .reduce((res: any[], [ key, val ]) => api.is.object(val)
      ? [...res, ...flatobj(val, loc(key))]
      : [...res, [loc(key), val]], [])
}

const objDeepGet = (obj: object) => (givenPath: string | string[]) => {
  const path = typeof givenPath === 'string' ? givenPath.split('.') : givenPath.slice()

  const dive = (obj = {} as any): any => {
    const pathPoint = path.shift()
    if (pathPoint == null) return
    const val = Reflect.get(obj, pathPoint)
    if (val === undefined) return
    return path.length ? dive(val) : val
  }

  return dive(obj)
}

const dedupOn = <T>(list: T[], comparator: (a: T, b: T) => boolean): T[] => list.filter((m, ix) => {
  return ix === list.findIndex(s => comparator(m, s))
})

const defaultProtoKeys = Object.keys(Object.getOwnPropertyDescriptors(Object.getPrototypeOf({})))

const threadSafeObject = <T>(obj: T): T => {
  // @ts-ignore
  if (!is.object(obj)) return Array.isArray(obj) ? obj.map(v => threadSafeObject(v)) : obj

  const proto = Object.getPrototypeOf(obj)
  const mainDesc = Object.entries(Object.getOwnPropertyDescriptors(obj))
  const protoDesc = Object.entries(Object.getOwnPropertyDescriptors(proto))

  const collectValues = ((res: any, [ key, desc ]: any) => {
    if (defaultProtoKeys.includes(key)) return res
    if (typeof desc.value === 'function') return res

    // @ts-ignore
    const value = obj[key]
    const threadSafeValue = Array.isArray(value)
      ? value.map(v => threadSafeObject(v))
      : threadSafeObject(value)

    Reflect.set(res, key, threadSafeValue)
    return res
  })

  const part1 = protoDesc.reduce(collectValues, {})
  const part2 = mainDesc.reduce(collectValues, {})

  return { ...part1, ...part2 }
}

class NewlineSplitter extends Transform {
  private buffer: string

  constructor() {
    super({ encoding: 'utf8' })
    this.buffer = ''
  }

  _transform(chunk: string, _: any, done: Function) {
    const pieces = ((this.buffer != null ? this.buffer : '') + chunk).split(/\r?\n/)
    this.buffer = pieces.pop() || ''
    pieces.forEach(line => this.push(line))
    done()
  }
}

const MapMap = <A, B, C>(initial?: any[]) => {
  const m = new Map<A, Map<B, C>>(initial)

  const set = (key: A, subkey: B, value: C) => {
    const sub = m.get(key) || new Map()
    sub.set(subkey, value)
    m.set(key, sub)
  }

  const updateObject = (key: A, subkey: B, objectDiff: C) => {
    const sub = m.get(key) || new Map()
    const previousObject = sub.get(subkey) || {}
    if (!api.is.object(previousObject)) throw new Error(`MapMap: trying to update object but the current value is not an object`)
    sub.set(subkey, Object.assign(previousObject, objectDiff))
    m.set(key, sub)
  }

  const get = (key: A, subkey: B) => {
    const sub = m.get(key)
    if (!sub) return
    return sub.get(subkey)
  }

  const has = (key: A, subkey: B) => {
    const sub = m.get(key)
    if (!sub) return false
    return sub.has(subkey)
  }

  const remove = (key: A, subkey: B) => {
    const sub = m.get(key)
    if (!sub) return
    sub.delete(subkey)
  }

  const forEach = (key: A, fn: (value: C, key: B) => void) => {
    const sub = m.get(key)
    if (!sub) return
    sub.forEach(fn)
  }

  const size = () => m.size
  const subsize = (key: A) => {
    const sub = m.get(key)
    if (!sub) return -1
    return sub.size
  }

  const keys = (key: A) => {
    const sub = m.get(key)
    if (!sub) return []
    return sub.keys()
  }

  const entries = (key: A) => {
    const sub = m.get(key)
    if (!sub) return []
    return [...sub.entries()]
  }

  return {
    get raw() { return m },
    set,
    get,
    has,
    remove,
    updateObject,
    forEach,
    size,
    subsize,
    keys,
    entries,
  }
}

class MapList<A, B> extends Map<A, B[]> {
  add(key: A, values: B[]) {
    const list = this.get(key) || []
    list.push(...values)
    this.set(key, list)
  }

  replace(key: A, values: B[]) {
    const list = [...values]
    this.set(key, list)
  }
}

class MapSetter<A, B> extends Map<A, Set<B>> {
  add(key: A, value: B) {
    const s = this.get(key) || new Set()
    this.set(key, s.add(value))
    return () => this.remove(key, value)
  }

  addMany(key: A, values: B[]) {
    return values.map(val => this.add(key, val))
  }

  addMultiple(keys: A[], value: B) {
    keys.forEach(key => this.add(key, value))
    return () => this.removeMultiple(keys, value)
  }

  addMultipleValues(keys: A[], values: B[]) {
    const removalFuncs = values.map(value => this.addMultiple(keys, value))
    return () => removalFuncs.forEach(fn => fn())
  }

  replace(key: A, value: B) {
    const s = this.get(key) || new Set()
    s.clear()
    this.set(key, s.add(value))
    return () => this.remove(key, value)
  }

  replaceMany(key: A, values: B[]) {
    const s = this.get(key) || new Set()
    s.clear()
    return values.map(val => this.add(key, val))
  }

  remove(key: A, value: B) {
    const s = this.get(key)
    if (!s) return false
    return s.delete(value)
  }

  removeMultiple(keys: A[], value: B) {
    keys.forEach(key => this.remove(key, value))
  }

  getList(key: A): B[] {
    const s = this.get(key)
    return s ? [...s] : []
  }
}

const MapSet = <A, B, C>(initial?: any[]) => {
  const m = new Map<A, MapSetter<B, C>>(initial)

  const set = (key: A, subkey: B, value: C) => {
    const sub = m.get(key) || new MapSetter()
    sub.add(subkey, value)
    m.set(key, sub)
  }

  const get = (key: A, subkey: B) => {
    const sub = m.get(key)
    if (!sub) return
    return sub.get(subkey)
  }

  const has = (key: A, subkey: B) => {
    const sub = m.get(key)
    if (!sub) return false
    return sub.has(subkey)
  }

  const remove = (key: A, subkey: B) => {
    const sub = m.get(key)
    if (!sub) return
    sub.delete(subkey)
  }

  const forEach = (key: A, fn: (value: Set<C>, key: B) => void) => {
    const sub = m.get(key)
    if (!sub) return
    sub.forEach(fn)
  }

  const size = () => m.size
  const subsize = (key: A) => {
    const sub = m.get(key)
    if (!sub) return -1
    return sub.size
  }

  const keys = (key: A) => {
    const sub = m.get(key)
    if (!sub) return []
    return sub.keys()
  }

  const entries = (key: A) => {
    const sub = m.get(key)
    if (!sub) return []
    return [...sub.entries()]
  }

  return {
    get raw() { return m },
    set,
    get,
    has,
    remove,
    forEach,
    size,
    subsize,
    keys,
    entries,
  }
}

const tryNetConnect = (path: string, interval = 500, timeout = 5e3): Promise<ReturnType<typeof net.createConnection>> => new Promise((done, fail) => {
  const timeoutTimer = setTimeout(fail, timeout)

  const attemptConnection = () => {
    const socket = net.createConnection(path)

    socket.once('connect', () => {
      clearTimeout(timeoutTimer)
      socket.removeAllListeners('error')
      done(socket)
    })

    // swallow errors until we connect
    socket.on('error', () => {})
    socket.once('close', () => setTimeout(attemptConnection, interval))
  }

  attemptConnection()
})

const PromiseBoss = () => {
  const $cancel = Symbol('cancel')
  type CancelFn = () => any
  let previousCancel: CancelFn | null
  let externalControlTask = api.Task()

  /** Schedule a cancellable promise which can be cancelled by next invocation or timeout */
  const schedule = <T>(cancellablePromise: CancelPromise<T>, options: PromiseBossOptions): Promise<T> => new Promise(async (ok, no) => {
    previousCancel && previousCancel()
    previousCancel = cancellablePromise.cancel
    externalControlTask = api.Task()

    const result = await Promise.race([
      cancellablePromise.promise,
      externalControlTask.promise,
      new Promise(done => setTimeout(() => done($cancel), options.timeout || 1e3)),
    ]).catch(no)

    if (result === $cancel) {
      previousCancel = null
      cancellablePromise.cancel()
      return
    }

    previousCancel = null
    ok(result as T)
  }) as Promise<T>

  const cancelCurrentPromise = () => externalControlTask.done($cancel)

  return { schedule, cancelCurrentPromise }
}

const deepFreeze = (obj: any) => {
  Object.freeze(obj)
  Object.getOwnPropertyNames(obj).forEach(prop => {
    const thawed = obj.hasOwnProperty(prop)
      && obj[prop] !== null
      && (typeof obj[prop] === 'object' || typeof obj[prop] === 'function')
      && !Object.isFrozen(obj[prop])
    if (thawed) deepFreeze(obj[prop])
  })
  return obj
}

const patchObject = <T extends object>(original: T, patch: Partial<T>): boolean => {
  let changed = false
  const op = (original: T, patch: Partial<T>) => {
    Object.keys(patch).forEach(key => {
      const oval = Reflect.get(original, key)
      const pval = Reflect.get(patch, key)
      const oisobj = api.is.object(oval)
      const pisobj = api.is.object(pval)
      if (pisobj && oval != null) return op(oval, pval)
      const same = !pisobj && !oisobj && oval === pval
      if (same) return
      changed = true
      Reflect.set(original, key, pval)
    })
  }

  op(original, patch)
  return changed
}

const $HOME = os.homedir()

const api = {
  http: httpServer,
  fakeModule,
  shellEnv,
  $HOME,
  fs,
  MapMap,
  MapList,
  MapSetter,
  MapSet,
  PromiseBoss,
  arrReplace,
  listof,
  minmax,
  isOnline,
  findIndexRight,
  EarlyPromise,
  requireDir,
  flatobj,
  objDeepGet,
  dedupOn,
  threadSafeObject,
  NewlineSplitter,
  tryNetConnect,
  time: {
    debounce,
    throttle,
    delay: (t: number) => new Promise(d => setTimeout(d, t)),
  },
  xdgConfigPath: process.env.XDG_CONFIG_HOME || (process.platform === 'win32'
    ? `${$HOME}/AppData/Local`
    : `${$HOME}/.config`),
  case: {
    snake: (m: string) => m.split('').map(ch => /[A-Z]/.test(ch) ? '_' + ch.toLowerCase(): ch).join(''),
    pascal: (m: string) => m[0].toUpperCase() + m.slice(1),
    camel: (m: string) => m[0].toLowerCase() + m.slice(1),
    hasUpper: (m: string) => m.toLowerCase() !== m,
  },
  nullish: (m = null) => m,
  type: (m: any) => (Object.prototype.toString.call(m).match(/^\[object (\w+)\]/) || [])[1].toLowerCase(),
  is: new Proxy<Types>({} as Types, { get: (_, key) => (val: any) => api.type(val) === key }),
  within: (target: number, tolerance: number) => (candidate: number) => Math.abs(target - candidate) <= tolerance,
  objToMap: (obj: object, map: Map<any, any>) => Object.entries(obj).forEach(([k, v]) => map.set(k, v)),
  parseJSON: <T>(m: string | Buffer): T => { try { return JSON.parse(m as string) } catch(_) { return {} as T } },
  ID: (val = 0) => ({ next: () => (val++, val) }),
  pipe: <T>(...fns: Function[]) => (...a: any[]) => fns.reduce((res, fn, ix) => ix ? fn(res) : fn(...res), a) as unknown as T,
  onProp: <T>(cb: (name: PropertyKey) => void): T => new Proxy({}, { get: (_, name) => cb(name) }) as T,
  onFnCall: <T>(cb: (name: string, args: any[]) => void): T => new Proxy({}, { get: (_, name) => (...args: any[]) => cb(name as string, args) }) as T,
  proxyFn: (cb: (name: string, data?: any) => void) => new Proxy({}, { get: (_, name) => (data?: any) => cb(name as string, data) }) as { [index: string]: (data?: any) => void },
  uri: {
    toPath: (m: string) => m.replace(/^\S+:\/\//, ''),
    asCwd: (m = '') => pth.dirname(api.uri.toPath(m)),
    asFile: (m = '') => pth.basename(api.uri.toPath(m)),
  },
  Task: <T>(): ITask<T> => ( (done = (_: T) => {}, promise = new Promise<T>(m => done = m)) => ({ done, promise }) )(),
  uuid: (): string => (<any>[1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,(a: any)=>(a^Math.random()*16>>a/4).toString(16)),
  shell: (cmd: string, opts?: object): Promise<string> => new Promise(fin => cp.exec(cmd, opts, (_, out) => fin(out + ''))),
  getPipeName: (name: string) => process.platform === 'win32'
    ? `\\\\.\\pipe\\${name}${api.uuid()}-sock`
    : pth.join(os.tmpdir(), `${name}${api.uuid()}.sock`),
  path: {
    reduce: pathReducer,
    resolve: resolvePath,
    parts: pathParts,
    relativeToHome: (path: string) => path.includes($HOME)
      ? path.replace($HOME, '~')
      : path,
    relativeToCwd: (path: string, cwd: string) => path.includes(cwd)
      ? path.replace(cwd, '').replace(/^\//, '')
      : path,
    simplify: (fullpath: string, cwd: string) => fullpath.includes(cwd)
      ? fullpath.split(cwd + '/')[1]
      : fullpath.includes($HOME) ? fullpath.replace($HOME, '~') : fullpath,
  },
  args: process.argv.slice(2).reduce((res, arg, ix, arr) => {
    const next = arr[ix + 1]
    const nextIsValue = typeof next === 'string' && !next.startsWith('--')
    const rawval = nextIsValue ? next : true
    const value = Number.isNaN(parseInt(rawval as any)) ? rawval : <any>rawval - 0
    if (arg.startsWith('--')) Reflect.set(res, arg.slice(2), value)
    return res
  }, {} as any),
  deepFreeze,
  patchObject,
}

export default api
