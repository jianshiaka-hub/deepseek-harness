/** Real Electron verifies cross-origin Sidebar frame resource grants and inventory expiry. */
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const builtAssets = fileURLToPath(new URL('../lib/types/browser-foreign-assets.js', import.meta.url))
const hasDisplay = process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)

it.skipIf(!hasDisplay)('reads only approved foreign-frame assets and expires their inventory on navigation', async () => {
  if (!existsSync(builtAssets)) throw new Error(`Missing built Browser assets ${builtAssets}; run pnpm run build:lib:host`)
  const userData = await mkdtemp(join(tmpdir(), 'dsh-browser-assets-'))
  try {
    const electron: unknown = require('electron')
    if (typeof electron !== 'string') throw new Error('Electron executable is unavailable')
    const fixture = fileURLToPath(new URL('./fixtures/browser-foreign-assets-electron.cjs', import.meta.url))
    const result = await execa(electron, [fixture, userData], {
      env: { ELECTRON_RUN_AS_NODE: undefined },
      timeout: 40_000, forceKillAfterDelay: 5_000, reject: false,
    })
    expect(result.timedOut, result.stderr).toBe(false)
    expect(result.signal, result.stderr).toBeUndefined()
    expect(result.exitCode, result.stderr).toBe(0)
    const report: unknown = JSON.parse(result.stdout.trim())
    expect(report).toMatchObject({
      frameCount: 2,
      assetBytes: 19,
      deniedBeforeGrant: true,
      deniedWithoutAssetGrant: true,
      foreignButtonName: true,
      staleAfterForeignReload: true,
    })
    expect(report).toHaveProperty('assetCount', 3)
  } finally {
    await rm(userData, { recursive: true, force: true })
  }
})
