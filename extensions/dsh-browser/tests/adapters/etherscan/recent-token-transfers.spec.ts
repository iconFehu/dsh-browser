// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { parseTransferPage, recentTokenTransfers } from '../../../src/content/adapters/etherscan/recent-token-transfers.ts'

const hash = `0x${'a'.repeat(64)}`
const from = `0x${'b'.repeat(40)}`
const to = `0x${'c'.repeat(40)}`
const contract = `0x${'d'.repeat(40)}`

function page(pageNumber: number, timestamps: number[]): string {
  return `<html><body><div id="divTableStatus">Showing the last 10k records</div><p>Page ${pageNumber} of 400</p><table class="table"><tbody>${timestamps.map((timestamp) => `
    <tr><td></td><td><a href="/tx/${hash}">${hash}</a></td>
    <td class="td_functionNameOri">transfer</td><td></td><td><a href="/block/123">123</a></td>
    <td></td><td></td><td class="showLocalDate"><span>${timestamp}</span></td>
    <td><a class="hash-tag">Sender</a><a data-clipboard-text="${from}"></a></td><td></td>
    <td><a class="hash-tag">Receiver</a><a data-clipboard-text="${to}"></a></td>
    <td><span class="td_showAmount" data-bs-title="1.234 | $1">1.23</span></td></tr>`).join('')}</tbody></table></body></html>`
}

describe('Etherscan recent transfers', () => {
  it('parses the page timestamp, full amount, and addresses', () => {
    const parsed = parseTransferPage(page(2, [1_700_000_000]))
    expect(parsed).toMatchObject({ page: 2, pages: 400, last10k: true })
    expect(parsed.rows[0]).toMatchObject({ hash, timestamp: 1_700_000_000, amount: '1.234', from, to })
  })

  it('returns a continuation cursor without losing rows at the output boundary', async () => {
    vi.stubGlobal('location', { hostname: 'etherscan.io', pathname: `/token/${contract}`, origin: 'https://etherscan.io' })
    document.body.innerHTML = `<iframe id="tokentxnsiframe" src="/token/generic-tokentxns2?contractAddress=${contract}&sid=test&p=1"></iframe>`
    const end = 1_700_000_100
    const fetcher = vi.fn(async (url: URL) => ({ ok: true, text: async () => page(Number(url.searchParams.get('p')), [end - 1, end - 2]) }))
    vi.stubGlobal('fetch', fetcher)
    try {
      const first = JSON.parse((await recentTokenTransfers({ minutes: 30, windowEnd: end, maxRecords: 1 }, 4000)).text)
      expect(first).toMatchObject({ complete: false, nextPage: 1, nextRow: 1, matchingRowsReturned: 1 })
      expect(fetcher.mock.calls[0][0].searchParams.get('ps')).toBe('100')
      const second = JSON.parse((await recentTokenTransfers({ minutes: 30, windowEnd: end, startPage: first.nextPage, startRow: first.nextRow, maxRecords: 1 }, 4000)).text)
      expect(second.rows[0].timestamp).toBe(end - 2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
