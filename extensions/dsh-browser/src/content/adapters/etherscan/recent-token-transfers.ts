/** Read the same paginated HTML that Etherscan embeds in its Transfers tab. */

const CONTRACT_RE = /^0x[0-9a-fA-F]{40}$/
const HASH_RE = /^0x[0-9a-fA-F]{64}$/
const PAGE_SIZE = 100

export interface TransferRow {
  hash: string
  block: number
  timestamp: number
  from: string
  fromLabel: string
  to: string
  toLabel: string
  amount: string
  method: string
}

function addressCell(cell: Element | undefined): { address: string; label: string } {
  const link = cell?.querySelector('a[data-clipboard-text]')
  const address = link?.getAttribute('data-clipboard-text') ?? ''
  return {
    address: CONTRACT_RE.test(address) ? address : '',
    label: cell?.querySelector('a.hash-tag')?.textContent?.trim() ?? '',
  }
}

/** Parsed rows are intentionally kept separate: one transaction can emit several transfers. */
export function parseTransferPage(html: string): { rows: TransferRow[]; page: number; pages: number; last10k: boolean } {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const status = doc.querySelector('#divTableStatus')?.textContent ?? doc.body.textContent ?? ''
  const match = (doc.body.textContent ?? '').match(/Page\s+(\d+)\s+of\s+(\d+)/i)
  if (!match || !doc.querySelector('table.table')) throw new Error('Etherscan transfer table format changed or the page did not load.')
  const rows: TransferRow[] = []
  for (const tr of doc.querySelectorAll('table.table tbody tr')) {
    const cells = [...tr.querySelectorAll(':scope > td')]
    const hash = cells[1]?.querySelector('a[href^="/tx/"]')?.textContent?.trim() ?? ''
    if (!HASH_RE.test(hash)) continue
    const block = Number(cells[4]?.querySelector('a[href^="/block/"]')?.textContent?.trim())
    const timestamp = Number(tr.querySelector('td.showLocalDate span')?.textContent?.trim())
    if (!Number.isSafeInteger(block) || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error('Etherscan transfer row is missing its block or timestamp.')
    }
    const from = addressCell(cells.at(-4))
    const to = addressCell(cells.at(-2))
    if (!from.address || !to.address) throw new Error('Etherscan transfer row is missing an address.')
    const amount = cells.at(-1)?.querySelector('.td_showAmount')?.getAttribute('data-bs-title')?.split(' | ')[0]
      ?? cells.at(-1)?.querySelector('.td_showAmount')?.textContent?.trim()
      ?? ''
    rows.push({
      hash,
      block,
      timestamp,
      from: from.address,
      fromLabel: from.label,
      to: to.address,
      toLabel: to.label,
      amount,
      method: tr.querySelector('td.td_functionNameOri')?.textContent?.trim() ?? '',
    })
  }
  return { rows, page: Number(match[1]), pages: Number(match[2]), last10k: /Showing the last 10k records/i.test(status) }
}

export async function recentTokenTransfers(args: Record<string, unknown>, maxChars: number): Promise<{ text: string }> {
  if (maxChars < 1500) throw new Error('Increase snapshotMaxChars to at least 1500 for recent transfers.')
  if (location.hostname !== 'etherscan.io' || !/^\/token\/0x[0-9a-fA-F]{40}\/?$/.test(location.pathname)) {
    throw new Error('Open an Etherscan ERC-20 token page before reading its Transfers list.')
  }
  const source = document.querySelector<HTMLIFrameElement>('#tokentxnsiframe')?.getAttribute('src')
  if (!source) throw new Error('This token page has no Transfers iframe.')
  const base = new URL(source, location.origin)
  if (base.origin !== location.origin || base.pathname !== '/token/generic-tokentxns2') {
    throw new Error('Unexpected Etherscan Transfers source.')
  }
  const contract = location.pathname.split('/')[2]
  if (base.searchParams.get('contractAddress')?.toLowerCase() !== contract?.toLowerCase()) {
    throw new Error('Transfers iframe does not match the current token contract.')
  }
  const minutes = typeof args.minutes === 'number' ? args.minutes : 30
  const maxPages = typeof args.maxPages === 'number' ? args.maxPages : 20
  const maxRecords = typeof args.maxRecords === 'number' ? args.maxRecords : 100
  const startPage = typeof args.startPage === 'number' ? args.startPage : 1
  const startRow = typeof args.startRow === 'number' ? args.startRow : 0
  const end = typeof args.windowEnd === 'number' ? args.windowEnd : Math.floor(Date.now() / 1000)
  if (![minutes, maxPages, maxRecords, startPage, end].every((n) => Number.isSafeInteger(n) && n >= 1)
    || !Number.isSafeInteger(startRow) || startRow < 0 || startRow >= PAGE_SIZE
    || minutes > 1440 || maxPages > 100 || maxRecords > 1000 || startPage > 400
    || end > Math.floor(Date.now() / 1000)) throw new Error('Invalid recent transfer limits or continuation cursor.')
  const start = end - minutes * 60
  const rows: TransferRow[] = []
  let pagesRead = 0
  let foundBoundary = false
  let pageCount = 0
  let last10k = false
  let reason = ''
  let nextPage: number | null = null
  let nextRow: number | null = null
  let bytes = 600
  for (let page = startPage; page < startPage + maxPages; page++) {
    const url = new URL(base)
    url.searchParams.set('p', String(page))
    url.searchParams.set('ps', String(PAGE_SIZE))
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`Etherscan Transfers page ${page} returned HTTP ${response.status}.`)
    const parsed = parseTransferPage(await response.text())
    if (parsed.page !== page) throw new Error(`Etherscan returned page ${parsed.page} when page ${page} was requested.`)
    pagesRead++
    pageCount = parsed.pages
    last10k = parsed.last10k
    if (parsed.rows.length === 0) {
      foundBoundary = true
      break
    }
    for (let rowIndex = page === startPage ? startRow : 0; rowIndex < parsed.rows.length; rowIndex++) {
      const row = parsed.rows[rowIndex]
      if (row.timestamp < start) { foundBoundary = true; break }
      if (row.timestamp > end) continue
      const size = JSON.stringify(row).length + 2
      if (rows.length >= maxRecords || bytes + size > maxChars - 400) {
        reason = rows.length >= maxRecords ? 'maxRecords' : 'outputBudget'
        nextPage = page
        nextRow = rowIndex
        break
      }
      rows.push(row)
      bytes += size
    }
    if (reason || foundBoundary || page >= pageCount) break
  }
  if (!reason && !foundBoundary && startPage + pagesRead - 1 < pageCount) {
    reason = 'maxPages'
    nextPage = startPage + pagesRead
    nextRow = 0
  }
  if (!reason && !foundBoundary && last10k && startPage + pagesRead - 1 >= pageCount) reason = 'EtherscanLast10kLimit'
  const result = {
    source: base.pathname,
    contract,
    windowStart: new Date(start * 1000).toISOString(),
    windowEnd: new Date(end * 1000).toISOString(),
    pagesRead,
    totalPagesVisible: pageCount,
    matchingRowsReturned: rows.length,
    complete: reason === '',
    incompleteReason: reason || null,
    nextPage,
    nextRow,
    windowEndUnix: end,
    note: 'Rows come from the live Etherscan Transfers HTML. New blocks can shift page boundaries during pagination.',
    rows,
  }
  return { text: JSON.stringify(result) }
}
