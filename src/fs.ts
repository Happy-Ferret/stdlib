import { join, dirname, relative, sep } from 'path'
import { promisify as P } from 'util'
import watchFile from './fs-watch'
import * as fs from 'fs'
import std from './main'

export interface DirFileInfo {
  name: string
  path: string
  relativePath: string
  dir: boolean
  file: boolean
  symlink: boolean
}

export interface CopyOptions { overwrite?: boolean }
type RemoveOpts = { ignoreNotExist?: boolean }

const exists = (path: string): Promise<boolean> => new Promise(fin => fs.access(path, e => fin(!e)))
const readFile = (path: string, encoding = 'utf8') => P(fs.readFile)(path, encoding)
const writeFile = async (path: string, data: string) => {
  await ensureDir(dirname(path))
  return P(fs.writeFile)(path, data)
}

const emptyStat = {
  isDirectory: () => false,
  isFile: () => false,
  isSymbolicLink: () => false,
}

const getFSStat = async (path: string) => P(fs.stat)(path).catch((_) => emptyStat)

const getDirFiles = async (path: string): Promise<DirFileInfo[]> => {
  const paths = await P(fs.readdir)(path).catch((_e: string) => []) as string[]
  const filepaths = paths.map(f => ({ name: f, path: join(path, f) }))

  const filesreq = await Promise.all(filepaths.map(async f => ({
    path: f.path,
    name: f.name,
    relativePath: f.path,
    stats: await getFSStat(f.path),
  })))

  return filesreq.map(({ name, path, relativePath, stats }) => ({
    name,
    path,
    relativePath,
    dir: stats.isDirectory(),
    file: stats.isFile(),
    symlink: stats.isSymbolicLink(),
  }))
}

const getDirs = async (path: string) => (await getDirFiles(path)).filter(m => m.dir)
const getFiles = async (path: string) => (await getDirFiles(path)).filter(m => m.file)
const isFile = async (path: string) => (await P(fs.stat)(path)).isFile()
const copyFile = (src: string, dest: string) => P(fs.copyFile)(src, dest)

const getDirsFilesRecursively = async (startPath: string): Promise<DirFileInfo[]> => {
  const dive = async (path: string): Promise<DirFileInfo[]> => {
    const paths = await P(fs.readdir)(path).catch(() => []) as string[]
    const filepaths = paths.map(f => ({ name: f, path: join(path, f) }))
    const filesreq = await Promise.all(filepaths.map(async f => ({
      path: f.path,
      name: f.name,
      relativePath: relative(startPath, f.path),
      stats: await getFSStat(f.path),
    })))

    const meta = filesreq.map(({ name, path, relativePath, stats }) => ({
      name,
      path,
      relativePath,
      dir: stats.isDirectory(),
      file: stats.isFile(),
      symlink: stats.isSymbolicLink(),
    }))

    return meta
      .filter(m => m.dir)
      .reduce(async (q, dir) => {
        const res = await q
        const df = await dive(dir.path)
        return [...res, ...df]
      }, Promise.resolve(meta))
  }

  return dive(startPath)
}

const remove = async (path: string, { ignoreNotExist } = {} as RemoveOpts) => {
  if (!(await exists(path))) {
    if (ignoreNotExist) return
    throw new Error(`remove: ${path} does not exist`)
  }

  if (await isFile(path)) return P(fs.unlink)(path)

  const dfs = await getDirsFilesRecursively(path)
  if (!dfs.length) return P(fs.rmdir)(path)

  const files = dfs.filter(m => m.file)
  await Promise.all(files.map(f => P(fs.unlink)(f.path)))
  await dfs
    .filter(m => m.dir)
    .map(m => ({ ...m, depth: m.path.split(sep).length }))
    .sort((a, b) => b.depth - a.depth)
    .reduce(async (q, m) => {
      return (await q, P(fs.rmdir)(m.path))
    }, Promise.resolve())

  return P(fs.rmdir)(path)
}

/** Copy file or dir from source to destination path. Destination path should be the final path. */
const copy = async (srcPath: string, destPath: string, options = {} as CopyOptions) => {
  if (await isFile(srcPath)) {
    await ensureDir(destPath)
    return copyFile(srcPath, destPath)
  }

  if (options.overwrite) await remove(destPath, { ignoreNotExist: true })
  const dfs = await getDirsFilesRecursively(srcPath)
  const files = dfs.filter(m => m.file).map(m => m.relativePath)

  return Promise.all(files.map(async file => {
    const destdir = join(destPath, dirname(file))
    await ensureDir(destdir)
    const srcfile = join(srcPath, file)
    const dstfile = join(destPath, file)
    return copyFile(srcfile, dstfile)
  }))
}

const rename = async (path: string, newPath: string) => {
  if (!(await exists(path))) throw new Error(`rename: ${path} does not exist`)
  return P(fs.rename)(path, newPath)
}

const ensureDir = (path: string) => std.path.parts(path).reduce((q, dir, ix, arr) => q.then(() => {
  return P(fs.mkdir)(join(...arr.slice(0, ix), dir)).catch(() => {})
}), Promise.resolve())

export default {
  exists,
  readFile,
  writeFile,
  remove,
  copy,
  rename,
  ensureDir,
  getDirs,
  getFiles,
  getDirFiles,
  getDirsFilesRecursively,
  watchFile,
}
