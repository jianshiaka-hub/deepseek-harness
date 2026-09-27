import { expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { sidebarLocateCode } from '../src/browser-locator-script.ts'

const url = 'https://embedded.test/widget'

function count(selector: string): number {
  const dom = new JSDOM('<html><body>' +
    '<article class="card"><div>Say "Hi" to Cat</div><button>Open</button></article>' +
    '<article class="card"><div>Other item</div></article>' +
    '</body></html>', { url, runScripts: 'outside-only' })
  try {
    const query = { method: 'locator', value: selector, exact: false } as const
    const result = dom.window.eval(sidebarLocateCode(url, query)) as { count: number }
    return result.count
  } finally {
    dom.window.close()
  }
}

it('matches nested has-text and CSS-escaped strings in an approved frame', () => {
  expect(count(String.raw`article:has(div:has-text("say \"hi\""))`)).toBe(1)
  expect(count(String.raw`article:has-text("C\61 t"):nth-of-type(1)`)).toBe(1)
  expect(count(String.raw`article:has(div:has-text("missing"))`)).toBe(0)
  expect(count(String.raw`article:has-text("say" "hi")`)).toBe(0)
})
