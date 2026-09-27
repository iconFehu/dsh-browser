/** Registry of optional site adapters. Core pageAssets stays site-agnostic. */

import * as etherscan from './etherscan/index.ts'

export const adapters = {
  etherscan,
} as const

export type AdapterName = keyof typeof adapters
