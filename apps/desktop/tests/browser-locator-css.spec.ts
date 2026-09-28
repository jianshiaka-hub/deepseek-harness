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

it('matches the document-wide one-based nth Playwright CSS result', () => {
  const html = '<html><body><section id="offers">' +
    '<button>Buy</button><div><button>Buy</button></div><button>Other</button>' +
    '<button>Buy</button></section></body></html>'
  expect(count(':nth-match(:text("Buy"), 2)', html)).toBe(1)
  expect(count('#offers :nth-match(:text("Buy"), 2)', html)).toBe(1)
  expect(count('button:nth-match(:text("Buy"), 2)', html)).toBe(1)
  expect(count(':nth-match(button:has-text("Buy"), 3)', html)).toBe(1)
  expect(count(':nth-match(:text("Buy"), 4)', html)).toBe(0)
  expect(count(':nth-match(:text("Buy"), 0)', html)).toBe(0)
  expect(count('button:nth-child(1)', html)).toBe(2)
})

it('matches the smallest regex text in an approved frame', () => {
  const html = '<html><body><nav id="nav"><button>Log in</button>' +
    '<button>log   IN</button><button>Cancel</button>' +
    '<input type="button" value="Submit 42"><script>Hidden 42</script></nav></body></html>'
  expect(count(String.raw`#nav :text-matches("Log\s*in", "i")`, html)).toBe(2)
  expect(count(String.raw`#nav :text-matches("Log", "gi")`, html)).toBe(2)
  expect(count(String.raw`button:text-matches("^Log in$", "")`, html)).toBe(1)
  expect(count(String.raw`input:text-matches("Submit \d+", "")`, html)).toBe(1)
  expect(count(String.raw`nav:has(:text-matches("Log\s*in", "i"))`, html)).toBe(1)
  expect(count(String.raw`:text-matches("Hidden 42", "")`, html)).toBe(0)
  expect(count(String.raw`:text-matches("(", "")`, html)).toBe(0)
  expect(count(String.raw`:text-matches("Log", "bad")`, html)).toBe(0)
  expect(count(`:text-matches("${'a'.repeat(121)}", "")`, html)).toBe(0)
})
