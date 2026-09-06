// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function manifest(name: string): { permissions: string[]; minimum_chrome_version?: string } {
  return JSON.parse(readFileSync(join(process.cwd(), name), 'utf8')) as { permissions: string[]; minimum_chrome_version?: string }
}

describe('manifest permission split', () => {
  it('requests debugger and downloads only in the Chrome manifest', () => {
    const chrome = manifest('manifest.json')
    const firefox = manifest('manifest.firefox.json')
    expect(chrome.permissions).toEqual(expect.arrayContaining(['debugger', 'downloads']))
    expect(firefox.permissions).not.toContain('debugger')
    expect(firefox.permissions).not.toContain('downloads')
  })

  it('keeps the shared permission baseline in both manifests', () => {
    const chrome = manifest('manifest.json')
    const firefox = manifest('manifest.firefox.json')
    // sidePanel is Chrome-only UI (Firefox declares sidebar_action instead).
    expect(chrome.permissions).toContain('sidePanel')
    expect(firefox.permissions).not.toContain('sidePanel')
    for (const permission of ['storage', 'tabs', 'activeTab', 'scripting', 'webNavigation', 'alarms', 'notifications']) {
      expect(chrome.permissions).toContain(permission)
      expect(firefox.permissions).toContain(permission)
    }
  })
})
