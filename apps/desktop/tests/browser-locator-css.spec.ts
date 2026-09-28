import { expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { sidebarLocateCode } from '../src/browser-locator-script.ts'

const url = 'https://embedded.test/widget'

function count(selector: string, html = '<html><body>' +
    '<article class="card"><div>Say "Hi" to Cat</div><button>Open</button></article>' +
    '<article class="card"><div>Other item</div></article>' +
    '</body></html>'): number {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  try {
    Object.defineProperty(dom.window.Element.prototype, 'getClientRects', {
      value(this: Element) { return this.hasAttribute('data-hidden') ? [] : [{ width: 10, height: 10 }] },
    })
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
  expect(count('article:has(> div):first-child')).toBe(1)
})

it('matches smallest text and visible CSS pseudos in an approved frame', () => {
  const html = '<html><body><nav id="nav">' +
    '<button> Log <span>in</span></button><button data-hidden>Hidden</button>' +
    '<input type="button" value="Submit"><p>Download</p>' +
    '<div><span><em>Deep</em></span></div>' +
    '<div>Echo<span>Echo</span></div><script>Secret</script></nav></body></html>'
  expect(count('#nav :text("log")', html)).toBe(1)
  expect(count('#nav :text-is("Log")', html)).toBe(1)
  expect(count('#nav :text-is("log")', html)).toBe(0)
  expect(count('#nav :text-is("Echo")', html)).toBe(1)
  expect(count('#nav :text("submit")', html)).toBe(1)
  expect(count('#nav :text("deep")', html)).toBe(1)
  expect(count('#nav :text-is("Secret")', html)).toBe(0)
  expect(count('input:has-text("submit")', html)).toBe(1)
  expect(count('button:visible', html)).toBe(1)
  expect(count('nav:has(> button:visible)', html)).toBe(1)
  expect(count('button:text("log"):visible', html)).toBe(1)
})
