/** Token-bound controls for one private Desktop + Host + Computer Use qualification. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const inject = ['agents', 'agentPresets', 'tools']

export async function apply(ctx) {
  const root = process.env.DSH_SIDEBAR_CU_ROOT
  const token = process.env.DSH_SIDEBAR_CU_TOKEN
  const site = process.env.DSH_SIDEBAR_CU_PAGE_URL
  if (!root || !token || !site) throw new Error('Private Sidebar Computer Use qualification configuration is missing')
  const origin = new URL(site).origin
  const sessions = []
  const approvals = []
  let sidebarRequestCount = 0
  const sidebarRequests = []
  const bridgeCalls = []
  const bridges = new Set()
  const { SidebarBridge } = await import(pathToFileURL(join(root, 'app/computer-use/lib/sidebar-bridge.js')).href)
  const originalHandle = SidebarBridge.prototype.handle
  SidebarBridge.prototype.handle = async function (endpoint, payload, signal) {
    bridges.add(this)
    const call = { endpoint, selectedTab: payload?.selectedTab ?? null, result: undefined }
    try {
      const value = await originalHandle.call(this, endpoint, payload, signal)
      call.result = 'ok'
      return value
    } catch (error) {
      call.result = error?.code ?? error?.name ?? 'error'
      throw error
    } finally {
      bridgeCalls.push(call)
      if (bridgeCalls.length > 20) bridgeCalls.shift()
    }
  }
  let owned
  ctx.on('session/created', session => { sessions.push(session.id) })
  ctx.on('connection/request', async (request, _response, next) => {
    if (request.url?.includes('/api/cu-sidebar/')) {
      sidebarRequestCount++
      sidebarRequests.push({ method: request.method, url: request.url, at: Date.now() })
      if (sidebarRequests.length > 20) sidebarRequests.shift()
    }
    return next()
  })
  ctx.on('approval/request', request => {
    const allowed = request.toolName === 'computer-use-safe' && request.reason?.includes(origin)
    approvals.push({ tool: request.toolName, allowed, reason: request.reason })
    return Promise.resolve(allowed ? 'allowed-once' : 'rejected')
  }, { prepend: true })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.headers['x-qualification-token'] !== token) {
      response.writeHead(403).end()
      return
    }
    void (async () => {
      if (request.url === '/status') {
        return { sessions, agents: ctx.agents.list().map(agent => ({ id: agent.id, sessionId: agent.session.id })),
          approvals, sidebarRequestCount, sidebarRequests, bridgeCalls,
          selectedTabs: [...bridges].flatMap(bridge => bridge.list()) }
      }
      if (request.url !== '/invoke') throw new Error('Unknown qualification operation')
      const chunks = []
      for await (const chunk of request) {
        chunks.push(chunk)
        if (Buffer.concat(chunks).length > 8192) throw new Error('Qualification request is too large')
      }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (typeof input.sessionId !== 'string' || typeof input.code !== 'string' || input.code.length > 4096) {
        throw new Error('Invalid qualification tool call')
      }
      let agent = ctx.agents.get(input.sessionId)
      if (agent === undefined) {
        owned = await ctx.agents.create({ sessionId: input.sessionId, meta: { cwd: root },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard') } })
        agent = owned.agent
      }
      // The private tool probe stands in for one agent turn. DSH's approval
      // service correctly refuses decisions outside a durable turn boundary.
      const turn = agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1
      agent.session.append('turn/start', { turn })
      try {
        const result = await ctx.tools.execute({ callId: `sidebar-cu-${randomUUID()}`, name: 'computer_js',
          arguments: { code: input.code }, agent, signal: AbortSignal.timeout(30000) })
        return { result, approvals }
      } finally {
        agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
    })().then(value => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(value))
    }).catch(error => { response.writeHead(500).end(String(error?.stack ?? error)) })
  })
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
    await owned?.dispose()
  })
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  await writeFile(join(root, 'sidebar-cu-control.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }))
}
