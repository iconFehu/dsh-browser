// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  actionCoveredByTrustedOrigins,
  actionCoveredByTrustedTiers,
  normalizeTrustedOrigin,
  originMatchesTrusted,
} from '../src/security/trusted-origins.ts'
import type { ApprovalPrompt } from '../src/security/approval.ts'

function action(overrides: Partial<ApprovalPrompt> = {}): ApprovalPrompt {
  return {
    kind: 'action',
    action: 'management.tabs.click',
    summary: 'click',
    origins: ['https://app.example.com'],
    canTrust: true,
    ...overrides,
  }
}

describe('normalizeTrustedOrigin', () => {
  it('canonicalizes exact origins and HTTPS wildcard aliases', () => {
    expect(normalizeTrustedOrigin(' https://Example.com/path ')).toBe('https://example.com')
    expect(normalizeTrustedOrigin('*.Example.com')).toBe('https://*.example.com')
    expect(normalizeTrustedOrigin('https://%2A.Example.com')).toBe('https://*.example.com')
  })

  it('preserves explicit wildcard schemes and non-default ports', () => {
    expect(normalizeTrustedOrigin('http://*.example.com')).toBe('http://*.example.com')
    expect(normalizeTrustedOrigin('https://*.example.com:8443')).toBe('https://*.example.com:8443')
  })

  it('rejects malformed or overly broad wildcard entries', () => {
    expect(normalizeTrustedOrigin('https://*.example.com/path')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.localhost')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://user:pass@*.example.com')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.co.uk')).toBeUndefined()
    expect(normalizeTrustedOrigin('https://*.github.io')).toBeUndefined()
  })

  it('allows registrable and narrower wildcard roots', () => {
    expect(normalizeTrustedOrigin('https://*.example.co.uk')).toBe('https://*.example.co.uk')
    expect(normalizeTrustedOrigin('https://*.user.github.io')).toBe('https://*.user.github.io')
    expect(normalizeTrustedOrigin('https://*.api.example.com')).toBe('https://*.api.example.com')
  })
})

describe('originMatchesTrusted', () => {
  const trusted = ['https://*.example.com', 'https://secure.example.net:8443']

  it('matches the wildcard base domain and proper subdomains', () => {
    expect(originMatchesTrusted('https://example.com', trusted)).toBe(true)
    expect(originMatchesTrusted('https://api.example.com', trusted)).toBe(true)
    expect(originMatchesTrusted('https://notexample.com', trusted)).toBe(false)
  })

  it('does not cross scheme or port boundaries', () => {
    expect(originMatchesTrusted('http://api.example.com', trusted)).toBe(false)
    expect(originMatchesTrusted('https://api.example.com:8443', trusted)).toBe(false)
    expect(originMatchesTrusted('https://secure.example.net:8443', trusted)).toBe(true)
  })
})

describe('actionCoveredByTrustedOrigins', () => {
  const trusted = ['https://*.example.com']

  it('covers stable actions and fully known cross-origin navigation', () => {
    expect(actionCoveredByTrustedOrigins(action(), trusted)).toBe(true)
    expect(actionCoveredByTrustedOrigins(action({
      action: 'management.tabs.navigate',
      origins: ['https://app.example.com', 'https://docs.example.com'],
      canTrust: false,
    }), trusted)).toBe(true)
  })

  it('fails closed for history and invalid navigation with unknown destinations', () => {
    expect(actionCoveredByTrustedOrigins(action({
      action: 'management.tabs.back',
      canTrust: false,
    }), trusted)).toBe(false)
    expect(actionCoveredByTrustedOrigins(action({
      action: 'management.tabs.navigate',
      canTrust: false,
    }), trusted)).toBe(false)
  })

  it('requires every known navigation origin to be trusted', () => {
    expect(actionCoveredByTrustedOrigins(action({
      action: 'management.tabs.navigate',
      origins: ['https://app.example.com', 'https://bank.example.net'],
      canTrust: false,
    }), trusted)).toBe(false)
  })
})

describe('actionCoveredByTrustedTiers', () => {
  const permanent = ['https://*.example.com']
  const chatScoped = ['https://chat.example.net']

  it('applies the permanent tier whether or not a side panel is open', () => {
    expect(actionCoveredByTrustedTiers(action({ origins: ['https://app.example.com'] }), true, permanent, chatScoped)).toBe(true)
    expect(actionCoveredByTrustedTiers(action({ origins: ['https://app.example.com'] }), false, permanent, chatScoped)).toBe(true)
  })

  it('honors the chat-scoped tier only while a side panel conversation is open', () => {
    const prompt = action({ origins: ['https://chat.example.net'] })
    expect(actionCoveredByTrustedTiers(prompt, true, permanent, chatScoped)).toBe(true)
    expect(actionCoveredByTrustedTiers(prompt, false, permanent, chatScoped)).toBe(false)
  })

  it('keeps chat-scoped entries stored but inactive when the panel is closed', () => {
    // Closed panel must not fall through to a prompt-free approval from the
    // chat-scoped list, while the same prompt becomes approved once reopened.
    const prompt = action({ origins: ['https://chat.example.net'] })
    expect(actionCoveredByTrustedTiers(prompt, false, [], chatScoped)).toBe(false)
    expect(actionCoveredByTrustedTiers(prompt, true, [], chatScoped)).toBe(true)
  })

  it('still fails closed for unknown-destination history actions', () => {
    const prompt = action({ action: 'management.tabs.back', canTrust: false, origins: [] })
    expect(actionCoveredByTrustedTiers(prompt, true, permanent, chatScoped)).toBe(false)
    expect(actionCoveredByTrustedTiers(prompt, false, permanent, chatScoped)).toBe(false)
  })
})
