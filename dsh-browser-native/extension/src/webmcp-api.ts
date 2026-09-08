import type { WebMcpApi, WebMcpTool } from '../../src/shared/webmcp-capability.js'

type PageTool = WebMcpTool & { inputSchema?: unknown }

async function pageTools(): Promise<PageTool[]> {
  const context = (navigator as Navigator & { modelContext?: { getTools?: () => Promise<unknown> } }).modelContext
  if (context?.getTools) return await context.getTools() as PageTool[]
  const fallback = (globalThis as typeof globalThis & { __webmcpTools?: PageTool[] }).__webmcpTools
  return Array.isArray(fallback) ? fallback : []
}

async function pageCall(name: string, input: unknown, registrationId: string): Promise<unknown> {
  const context = (navigator as Navigator & { modelContext?: { invokeTool?: (name: string, input: unknown) => Promise<unknown> } }).modelContext
  if (context?.invokeTool) return context.invokeTool(name, input)
  const fallback = (globalThis as typeof globalThis & { __webmcpInvoke?: (name: string, input: unknown, registrationId: string) => Promise<unknown> }).__webmcpInvoke
  if (fallback) return fallback(name, input, registrationId)
  throw new Error('This page does not expose a WebMCP tool runtime')
}

export class ChromeWebMcpApi implements WebMcpApi {
  async fetchTools(tabId: number, signal: AbortSignal): Promise<readonly WebMcpTool[]> {
    if (signal.aborted) throw new Error('WebMCP request cancelled')
    const result = await chrome.scripting.executeScript({ target: { tabId }, func: pageTools })
    return (result[0]?.result ?? []) as PageTool[]
  }

  async call(tabId: number, tool: WebMcpTool, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) throw new Error('WebMCP request cancelled')
    const result = await chrome.scripting.executeScript({ target: { tabId }, args: [tool.name, input, tool.registrationId], func: pageCall })
    return result[0]?.result
  }
}
