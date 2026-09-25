/** Sandboxed guest shim for Chromium's unsupported synchronous window.prompt. */
import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC } from './ipc.ts'

declare global {
  interface Window {
    __dshGuestPrompt: (message?: string, defaultValue?: string) => string | null
  }
}

// The page receives only a synchronous prompt function. Its message and
// default value never leave the guest; a pending agent lease decides the answer.
contextBridge.exposeInMainWorld('__dshGuestPrompt', (_message?: unknown, defaultValue?: unknown): string | null => {
  const result: unknown = ipcRenderer.sendSync(DESKTOP_IPC.browserGuestPrompt)
  if (typeof result === 'object' && result !== null && 'useDefault' in result &&
    result.useDefault === true && Object.keys(result).length === 1) {
    // oxlint-disable-next-line typescript/no-base-to-string -- window.prompt coerces its default to a DOMString.
    return defaultValue === undefined ? '' : String(defaultValue)
  }
  return typeof result === 'string' && result.length <= 4000 ? result : null
})
contextBridge.executeInMainWorld({ func: () => {
  window.prompt = window.__dshGuestPrompt
} })
