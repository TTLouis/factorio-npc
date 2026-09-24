import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { atomicWrite, check, directory, regularFile, runProcess, stat } from './common.mjs'

async function walkSafe(folder) {
  const out = []
  for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
    const filename = path.join(folder, entry.name)
    check(!entry.isSymbolicLink(), `Symlinks are not allowed in imported mod directories: ${entry.name}`)
    if (entry.isDirectory()) out.push(...await walkSafe(filename))
    else { check(entry.isFile(), `Unexpected special file in mod directory: ${entry.name}`); out.push(filename) }
  }
  return out
}

export async function prepareMods(root, app, workspace) {
  const destination = path.join(workspace, 'mods')
  await directory(destination)
  const userMods = path.join(root, 'mods')
  let list = { mods: [{ name: 'base', enabled: true }] }

  if (await stat(userMods)) {
    await directory(userMods)
    for (const name of await fsp.readdir(userMods)) {
      if (name === 'mod-list.json') {
        await regularFile(path.join(userMods, name))
        list = JSON.parse(await fsp.readFile(path.join(userMods, name), 'utf8'))
        continue
      }
      check(!/^autorio(?:_|$)/.test(name), 'User mods conflict with the managed autorio mod')
      const source = path.join(userMods, name)
      const info = await fsp.lstat(source)
      check(!info.isSymbolicLink(), 'User mod symlinks are not supported')
      if (info.isDirectory()) {
        await walkSafe(source)
        await fsp.cp(source, path.join(destination, name), { recursive: true, force: false, errorOnExist: true })
      }
      else {
        check(info.isFile(), 'Unexpected user mod filesystem entry')
        await fsp.copyFile(source, path.join(destination, name), fs.constants.COPYFILE_EXCL)
      }
    }
  }

  check(list && Array.isArray(list.mods) && list.mods.every(item => typeof item.name === 'string' && typeof item.enabled === 'boolean'), 'Invalid mod-list.json')
  check(!list.mods.some(item => item.name === 'autorio' && item.enabled === false), 'Managed autorio mod is explicitly disabled')
  list.mods = list.mods.filter(item => item.name !== 'autorio')
  list.mods.push({ name: 'autorio', enabled: true })
  await fsp.cp(path.join(app, 'autorio'), path.join(destination, 'autorio_0.1.0'), { recursive: true, force: false, errorOnExist: true })
  await atomicWrite(path.join(destination, 'mod-list.json'), `${JSON.stringify(list, null, 2)}\n`)
  return destination
}

export async function prepareServerSettings(root, game, factorio = { username: '', token: '', public: false }) {
  const data = path.join(root, 'data')
  await directory(data)
  const filename = path.join(data, 'server-settings.json')
  const existing = await stat(filename)
  let current
  if (existing) {
    await regularFile(filename)
    current = JSON.parse(await fsp.readFile(filename, 'utf8'))
    check(current && typeof current === 'object' && !Array.isArray(current), 'server-settings.json must be an object')
  }
  else {
    current = JSON.parse(await fsp.readFile(path.join(game, 'data', 'server-settings.example.json'), 'utf8'))
    current.name = 'SGLuna Factorio NPC'
    current.description = 'SGLuna standalone NPC Factorio server'
  }

  // Factorio refuses to start a public game unless require_user_verification
  // is also true (CommandLineMultiplayer.cpp), so this tracks visibility.public
  // exactly rather than being an independently configurable setting.
  // The NPC must keep playing with zero connected humans, so the server never
  // auto-pauses; Factorio's example settings ship with auto_pause=true.
  const next = {
    ...current,
    visibility: { ...current.visibility, public: factorio.public, lan: false },
    require_user_verification: factorio.public,
    auto_pause: false,
    username: factorio.username,
    token: factorio.token,
  }
  if (!existing || JSON.stringify(next) !== JSON.stringify(current)) {
    await atomicWrite(filename, `${JSON.stringify(next, null, 2)}\n`)
  }
  return filename
}

export async function prepareGameConfig(workspace, game, root) {
  check(!/[\r\n]/.test(game + root), 'Invalid Factorio path')
  const filename = path.join(workspace, 'config.ini')
  await atomicWrite(filename, `[path]\nread-data=${path.join(game, 'data')}\nwrite-data=${root}\n`)
  return filename
}

function normalizeSaveName(value) {
  check(typeof value === 'string' && value.length <= 160 && !/[\x00-\x1f\x7f/\\]/.test(value), 'Invalid save name')
  if (!value) return ''
  return value.endsWith('.zip') ? value : `${value}.zip`
}

export async function selectSave(root, requested = '') {
  const saves = path.join(root, 'saves')
  await directory(saves)
  const normalized = normalizeSaveName(requested)
  if (normalized) {
    const filename = path.join(saves, normalized)
    const existing = await stat(filename)
    if (existing) { await regularFile(filename); return { filename, create: false } }
    return { filename, create: true }
  }

  const candidates = []
  for (const name of await fsp.readdir(saves)) {
    if (!name.endsWith('.zip')) continue
    const filename = path.join(saves, name)
    const info = await fsp.lstat(filename)
    if (info.isFile() && !info.isSymbolicLink()) candidates.push({ filename, mtimeMs: info.mtimeMs })
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.filename.localeCompare(b.filename))
  if (candidates.length) return { filename: candidates[0].filename, create: false }
  return { filename: path.join(saves, 'sgluna-world.zip'), create: true }
}

export async function createSave(filename, game, modDir, configFile, root, log = () => {}) {
  check(!(await stat(filename)), 'Refusing to overwrite an existing save')
  const tempDir = await fsp.mkdtemp(path.join(root, '.airi', 'create-'))
  try {
    const temp = path.join(tempDir, 'world.zip')
    await runProcess(path.join(game, 'bin', 'x64', 'factorio'), [
      '--config', configFile,
      '--mod-directory', modDir,
      '--create', temp,
    ], { cwd: root, timeoutMs: 300000, label: 'Factorio save creation', log })
    await regularFile(temp)
    const handle = await fsp.open(temp, 'r')
    let header
    try { header = Buffer.alloc(4); await handle.read(header, 0, 4, 0) }
    finally { await handle.close() }
    check(header.toString('hex') === '504b0304', 'Factorio did not produce a ZIP save')
    await fsp.link(temp, filename)
  }
  finally { await fsp.rm(tempDir, { recursive: true, force: true }) }
}
