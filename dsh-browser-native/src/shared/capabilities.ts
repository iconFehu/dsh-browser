export type CapabilityId =
  | 'botDetection'
  | 'browserAuth'
  | 'cdp'
  | 'management'
  | 'pageAssets'
  | 'viewport'
  | 'visibility'
  | 'webmcp'

export interface CapabilityDescriptor {
  readonly id: CapabilityId
  readonly description: string
  readonly internalOnly?: boolean
}

export const CAPABILITIES: readonly CapabilityDescriptor[] = [
  { id: 'botDetection', description: 'Report bot-detection and CAPTCHA states.' },
  { id: 'browserAuth', description: 'Coordinate user-controlled browser authentication.' },
  { id: 'cdp', description: 'Send allowlisted Chrome DevTools Protocol commands and read events.' },
  { id: 'management', description: 'Manage windows, tabs, tab groups, and bookmarks.' },
  { id: 'pageAssets', description: 'List and bundle assets observed on the current page.' },
  { id: 'viewport', description: 'Set and clear an explicit browser viewport override.' },
  { id: 'visibility', description: 'Read or change browser visibility.' },
  { id: 'webmcp', description: 'Discover and invoke tools registered by the current page.', internalOnly: true },
]

export function capabilityById(id: string): CapabilityDescriptor | undefined {
  return CAPABILITIES.find((capability) => capability.id === id)
}
