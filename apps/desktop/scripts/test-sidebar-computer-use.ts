/** Qualify the installed Computer Use plugin against a private, real Desktop Browser tab. */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDevelopmentProjectMetadata, createPluginProfile } from '../src/project-manager.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { desktopTargetPlatform, developmentRuntimeDirectory, resolveDesktopBuildTarget } from './desktop-build-paths.mjs'

const repo = resolve(import.meta.dirname, '../../..')
const plugin = resolve(process.env.DSH_COMPUTER_USE_PLUGIN_DIR ?? join(repo, '../dsh-computer-use-safe'))
const evidence = join(repo, 'apps/desktop/.desktop-build/qualification')
await mkdir(evidence, { recursive: true })
const root = await mkdtemp(join(evidence, 'electron-sidebar-computer-use-'))
const application = join(root, 'app')
const project = join(application, '.desktop-build/development/project')
const profile = join(root, 'home/profiles/desktop')
const manifest = JSON.parse(await readFile(join(repo, 'apps/desktop/package.json'), 'utf8')) as { version: string }
const pnpm = JSON.parse(await readFile(join(repo, 'apps/desktop/node_modules/pnpm/package.json'), 'utf8')) as { version: string }
const page = createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  if (request.url === '/frame') {
    response.end('<!doctype html><button onclick="document.getElementById(\'frameResult\').textContent = \'frame clicked\'">Frame action</button><p id="frameResult">frame idle</p>')
    return
  }
  response.end('<!doctype html><title>Isolated Computer Use</title><h1>Isolated Computer Use</h1><section data-testid="group-a"><p data-testid="duplicate">Shared</p></section><section data-testid="group-b"><p data-testid="duplicate">Shared</p></section><div id="generic" onclick="this.setAttribute(\'data-state\',\'clicked\')">Generic tile</div><button id="action" data-testid="action" onclick="document.getElementById(\'result\').textContent = \'clicked\'">Click test button</button><p id="result">idle</p><input id="name" aria-label="Name" placeholder="Your name" type="text"><input id="disabled" aria-label="Disabled" disabled><div id="hidden" style="display:none">Hidden element</div><iframe id="inner" src="/frame"></iframe><div style="height:2000px">End of page</div>')
})
await new Promise<void>((done, reject) => {
  page.once('error', reject)
  page.listen(0, '127.0.0.1', done)
})
const address = page.address()
if (address === null || typeof address === 'string') throw new Error('Private browser page did not allocate a port')
const pageUrl = `http://127.0.0.1:${address.port}/`
try {
  // This rule exists only inside the disposable HOME for the private test page.
  await mkdir(join(root, '.dsh-computer-use-safe'), { recursive: true })
  await writeFile(join(root, '.dsh-computer-use-safe/browser-sites.json'), JSON.stringify({
    version: 1, allowed: [new URL(pageUrl).origin], blocked: [],
  }))
  const require = createRequire(import.meta.url)
  const electron = require('electron') as string
  const release = { schemaVersion: 1 as const, version: manifest.version,
    nodeVersion: execFileSync(electron, ['-p', 'process.versions.node'],
      { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true }).trim(),
    pnpmVersion: pnpm.version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION }
  const target = resolveDesktopBuildTarget()
  createDevelopmentProjectMetadata(project, release)
  createPluginProfile(profile)
  await writeFile(join(project, 'desktop-runtime.json'), JSON.stringify({
    schemaVersion: 1, release, ...desktopTargetPlatform(target), files: [],
    sharedPackages: ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']
      .map(name => ({ name, version: manifest.version, path: `node_modules/${name}` })),
  }))
  await cp(join(repo, 'apps/desktop/lib/types'), join(application, 'lib'), { recursive: true })
  await cp(join(repo, 'apps/desktop/lib/welcome'), join(application, 'lib/welcome'), { recursive: true })
  await cp(join(repo, 'apps/desktop/renderer'), join(application, 'renderer'), { recursive: true })
  for (const name of ['preload-app', 'preload-browser-guest', 'preload-mandatory', 'preload-update-dialog', 'preload-welcome']) {
    await cp(join(repo, `apps/desktop/lib/${name}.cjs`), join(application, `lib/${name}.cjs`))
  }
  await cp(join(plugin, 'lib'), join(application, 'computer-use/lib'), { recursive: true })
  await cp(join(plugin, 'native/macos/bin'), join(application, 'computer-use/native/macos/bin'), { recursive: true })
  await cp(join(plugin, 'package.json'), join(application, 'computer-use/package.json'))
  await symlink(join(plugin, 'node_modules'), join(application, 'computer-use/node_modules'), 'dir')
  await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'desktop-sidebar-computer-use-qualification',
    version: manifest.version, type: 'module' }))
  for (const owner of [application, project]) {
    await symlink(join(repo, 'node_modules/.pnpm/node_modules'), join(owner, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
  const targetRoot = join(application, '.desktop-build/targets', target)
  await mkdir(targetRoot, { recursive: true })
  await symlink(join(repo, 'apps/desktop/.desktop-build/targets', target, 'runtime'), join(targetRoot, 'runtime'),
    process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'llm-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'agent-preset-registry', config: { default: 'standard' } },
    { insert: [
      { id: 'computer-use-safe', name: pathToFileURL(join(application, 'computer-use/lib/index.js')).href },
      { id: 'sidebar-computer-use-qualification',
        name: new URL('../tests/fixtures/sidebar-computer-use-host.mjs', import.meta.url).href },
    ] },
  ]))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(?:path|systemroot|windir|comspec|pathext)$/iu.test(name)))
  const child = spawn(electron, [fileURLToPath(new URL('../tests/fixtures/sidebar-computer-use-workspace.mjs', import.meta.url)), '--lang=zh-CN'], {
    cwd: root, env: { ...environment, DSH_HOME: join(root, 'home'), USERPROFILE: root, HOME: root,
      TEMP: root, TMP: root, TMPDIR: root, DSH_SIDEBAR_CU_ROOT: root, DSH_SIDEBAR_CU_TOKEN: randomUUID(),
      DSH_SIDEBAR_CU_PAGE_URL: pageUrl, DSH_DESKTOP_PRIMARY_RUNTIME_DIR: developmentRuntimeDirectory(),
      DSH_DESKTOP_OPEN_DEVTOOLS: '0' }, stdio: 'inherit', windowsHide: false,
  })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, 120_000)
  try {
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { done({ code, signal }) })
    })
    if (timedOut || result.signal !== null || result.code !== 0) {
      throw new Error(`Sidebar Computer Use qualification failed: timeout=${String(timedOut)}, signal=${String(result.signal)}, exit=${String(result.code)}; evidence=${root}`)
    }
    console.log(`Electron sidebar Computer Use evidence: ${root}`)
  } finally { clearTimeout(timer) }
} finally {
  await new Promise<void>((resolveClose) => { page.closeAllConnections(); page.close(() => resolveClose()) })
  removeOwnedDirectory(application)
}
