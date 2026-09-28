import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { checkBrowserFrameAssets, fetchBrowserFrameAsset,
  listBrowserFrameAssets } from '../src/browser-foreign-assets.ts'

const topUrl = 'https://example.test/page'
const frameUrl = 'https://embedded.test/widget'
const origins = ['https://example.test', 'https://embedded.test']
const marker = 'd0be5364-7bfb-4c28-b20d-3e59eb143aa0'

function fixture() {
  const events = new EventEmitter()
  const seenUrls: string[] = []
  const makeFrame = (id: number, url: string, assetUrl: string) => {
    const document = {
      documentElement: {}, baseURI: url,
      querySelectorAll: () => [{ tagName:'IMG',currentSrc:assetUrl,shadowRoot:null,
        parentElement:null,getAttribute:(name: string) => name === 'src' ? assetUrl : null }],
    }
    const fetch = vi.fn(async (target: string, init: { redirect: string }) => {
      seenUrls.push(target)
      expect(init.redirect).toBe('manual')
      return { ok:true,headers:{ get:() => 'image/png' },body:{ getReader:() => {
        let read = false
        return { read:async () => read ? { done:true } : (read = true,
        { done:false,value:Uint8Array.from([1,2,3]) }),cancel:async () => {} }
      } } }
    })
    const context = { document,location:{ href:url },URL,performance:{ getEntriesByType:() => [] },
      getComputedStyle:() => ({ getPropertyValue:() => '' }),fetch,AbortSignal,
      Uint8Array,btoa,TextEncoder }
    return { detached:false,frameTreeNodeId:id,origin:new URL(url).origin,url,
      executeJavaScript:vi.fn(async (code: string): Promise<unknown> => {
        const value: unknown = runInNewContext(code,context)
        return value
      }) }
  }
  const top = makeFrame(1,topUrl,'https://example.test/top.png')
  const foreign = makeFrame(2,frameUrl,'https://assets.test/foreign.png')
  Object.assign(top,{ framesInSubtree:[top,foreign] })
  const guest = Object.assign({} as WebContents,{ mainFrame:top,isDestroyed:() => false,
    isLoadingMainFrame:() => false,getURL:() => topUrl,
    on:events.on.bind(events),off:events.off.bind(events),once:events.once.bind(events) })
  return { guest,events,top,foreign,seenUrls }
}

it('reads no foreign frame before all exact sites are approved', async () => {
  const h = fixture()
  await expect(listBrowserFrameAssets(h.guest,topUrl,[origins[0]!],marker))
    .rejects.toThrow('SIDEBAR_FRAME_SITE_NOT_APPROVED')
  expect(h.top.executeJavaScript).not.toHaveBeenCalled()
  expect(h.foreign.executeJavaScript).not.toHaveBeenCalled()
})

it('lists and fetches an inventoried asset only from its original frame', async () => {
  const h = fixture()
  const list = await listBrowserFrameAssets(h.guest,topUrl,origins,marker)
  expect(list.frames.map(row => row.frameId)).toEqual([1,2])
  expect(list.assets).toHaveLength(2)
  expect(await checkBrowserFrameAssets(h.guest,topUrl,origins,marker)).toBe(true)
  const foreign = list.assets.find(row => row.frameIndex === 1)!
  await expect(fetchBrowserFrameAsset(h.guest,topUrl,origins,
    'https://unapproved.test',marker,foreign.id))
    .rejects.toThrow('SIDEBAR_ASSET_SITE_NOT_APPROVED')
  expect(h.seenUrls).toHaveLength(0)
  const value = await fetchBrowserFrameAsset(h.guest,topUrl,origins,
    'https://assets.test',marker,foreign.id)
  expect(value).toEqual({ base64:'AQID',size:3,contentType:'image/png' })
  expect(h.seenUrls).toEqual(['https://assets.test/foreign.png'])
  await expect(fetchBrowserFrameAsset(h.guest,topUrl,origins,
    'https://assets.test',marker,`${marker}:1:missing`))
    .rejects.toThrow('UNKNOWN_ASSET_ID')
})

it('invalidates an inventory when a frame starts navigating to the same URL', async () => {
  const h = fixture()
  await listBrowserFrameAssets(h.guest,topUrl,origins,marker)
  h.events.emit('will-frame-navigate')
  await expect(checkBrowserFrameAssets(h.guest,topUrl,origins,marker))
    .rejects.toThrow('STALE_ASSET_INVENTORY')
  expect(h.seenUrls).toHaveLength(0)
})
