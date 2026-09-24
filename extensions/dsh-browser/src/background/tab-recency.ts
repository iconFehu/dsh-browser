const STORAGE_KEY = 'browserTabLastActivated'

/** Activation order survives MV3 worker restarts. Closed tabs are pruned when listed. */
export class TabRecency {
  private times = new Map<number, number>()
  readonly ready: Promise<void>

  constructor(private readonly storage: Pick<typeof chrome.storage.local, 'get' | 'set'> = chrome.storage.local) {
    this.ready = storage.get(STORAGE_KEY).then((result) => {
      const saved = result[STORAGE_KEY]
      if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return
      for (const [id, time] of Object.entries(saved)) {
        if (Number.isSafeInteger(Number(id)) && typeof time === 'number' && Number.isFinite(time)) {
          this.times.set(Number(id), time)
        }
      }
    }).catch(() => {})
  }

  async activated(tabId: number, time = Date.now()): Promise<void> {
    await this.ready
    this.times.set(tabId, time)
    await this.persist()
  }

  async removed(tabId: number): Promise<void> {
    await this.ready
    if (this.times.delete(tabId)) await this.persist()
  }

  async replace(oldId: number, newId: number): Promise<void> {
    await this.ready
    const time = this.times.get(oldId)
    this.times.delete(oldId)
    if (time !== undefined) this.times.set(newId, time)
    await this.persist()
  }

  async forTabs(tabs: chrome.tabs.Tab[]): Promise<Map<number, number>> {
    await this.ready
    const live = new Set(tabs.map((tab) => tab.id))
    let changed = false
    for (const id of this.times.keys()) {
      if (!live.has(id)) { this.times.delete(id); changed = true }
    }
    if (changed) await this.persist()
    return new Map(this.times)
  }

  private persist(): Promise<void> {
    return this.storage.set({ [STORAGE_KEY]: Object.fromEntries(this.times) }).catch(() => {})
  }
}
