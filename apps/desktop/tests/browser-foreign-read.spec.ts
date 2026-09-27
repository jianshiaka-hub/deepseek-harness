import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { auditBrowserFrames, readBrowserForeignText } from '../src/browser-foreign-read.ts'

const topUrl = 'https://example.test/page'
const sites = ['https://example.test', 'https://embedded.test']

function fixture() {
  const top = { detached: false, frameTreeNodeId: 1, origin: sites[0], url: topUrl,
    framesInSubtree: [] as unknown[] }
  const foreign = { detached: false, frameTreeNodeId: 2, origin: sites[1],
    url: 'https://embedded.test/widget', executeJavaScript: vi.fn(async () =>
      ({ text: 'Foreign visible text', roles: '- button "Open"' })) }
  top.framesInSubtree.push(top, foreign)
  const guest = { mainFrame: top, isDestroyed: () => false, isLoadingMainFrame: () => false,
    getURL: () => topUrl } as unknown as WebContents
  return { top, foreign, guest }
}

it('audits real frame origins and reads only after every exact origin is approved', async () => {
  const h = fixture()
  const audit = auditBrowserFrames(h.guest, topUrl)
  expect(audit.origins).toEqual(sites)
  expect(audit.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  await expect(readBrowserForeignText(h.guest, topUrl, [sites[0]!]))
    .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  expect(h.foreign.executeJavaScript).not.toHaveBeenCalled()
  await expect(readBrowserForeignText(h.guest, topUrl, sites)).resolves.toMatchObject({
    frames: [{ origin: sites[1], text: 'Foreign visible text', roles: '- button "Open"' }],
  })
})

it('refuses a foreign frame that changes during its bounded read', async () => {
  const h = fixture()
  h.foreign.executeJavaScript.mockImplementationOnce(async () => {
    h.foreign.url = 'https://embedded.test/next'
    return { text: 'New content', roles: '- button "Next"' }
  })
  await expect(readBrowserForeignText(h.guest, topUrl, sites))
    .rejects.toThrow('SIDEBAR_NAVIGATED')
})
