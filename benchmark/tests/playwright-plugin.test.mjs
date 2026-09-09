import test from 'node:test'
import assert from 'node:assert/strict'
import { defineTools } from '../plugin/playwright-browser.mjs'

test('Playwright baseline exposes the canonical model-facing browser contract', () => {
  const tools = defineTools(async () => ({ text: 'ok' }))
  assert.deepEqual(tools.map((tool) => tool.name), [
    'pageAssets.snapshot',
    'management.tabs.click',
    'management.tabs.type',
    'management.tabs.press',
    'management.tabs.scroll',
    'management.tabs.navigate',
    'management.tabs.back',
    'management.tabs.forward',
    'management.tabs.reload',
    'pageAssets.getText',
    'management.tabs.wait',
  ])
  assert.match(tools.find((tool) => tool.name === 'pageAssets.snapshot').description, /untrusted data/u)
  assert.equal(tools.find((tool) => tool.name === 'management.tabs.click').parameters.index.description, 'Element index from the pageAssets.snapshot inventory.')
  assert.equal(tools.find((tool) => tool.name === 'management.tabs.type').parameters.replace.description, 'When true, clear the existing value before entering text. Defaults to append.')
})
