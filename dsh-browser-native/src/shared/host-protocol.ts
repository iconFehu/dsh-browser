import type { CapabilityId, CapabilityDescriptor } from './capabilities.js'

export const HOST_PROTOCOL_VERSION = 1

export type HostRequest =
  | { type: 'hello'; protocolVersion: number; extensionId: string }
  | { type: 'capability.call'; id: string; sessionId: string; capability: CapabilityId; method: string; args: unknown; deadline: number }
  | { type: 'capability.cancel'; id: string }
  | { type: 'capability.result'; id: string; ok: true; result: unknown }
  | { type: 'capability.result'; id: string; ok: false; error: { code: string; message: string } }
  | { type: 'session.close'; sessionId: string }

export type HostResponse =
  | { type: 'hello.ok'; protocolVersion: number; capabilities: readonly CapabilityDescriptor[] }
  | { type: 'result'; id: string; ok: true; value: unknown }
  | { type: 'result'; id: string; ok: false; error: HostError }
  | { type: 'event'; sessionId: string; name: string; payload: unknown }

export interface HostError {
  code: 'bad-request' | 'unauthorized' | 'not-found' | 'timeout' | 'cancelled' | 'unsupported' | 'internal'
    | 'unsupported_protocol_version' | 'unknown_capability' | 'unknown_method' | 'invalid_args' | 'deadline_exceeded'
  message: string
}

export function isHostRequest(value: unknown): value is HostRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  if (frame.type === 'hello') return typeof frame.protocolVersion === 'number' && typeof frame.extensionId === 'string'
  if (frame.type === 'capability.cancel') return typeof frame.id === 'string'
  if (frame.type === 'capability.result') return typeof frame.id === 'string' && (frame.ok === true || (frame.ok === false && typeof frame.error === 'object' && frame.error !== null))
  if (frame.type === 'session.close') return typeof frame.sessionId === 'string'
  return frame.type === 'capability.call'
    && typeof frame.id === 'string'
    && typeof frame.sessionId === 'string'
    && typeof frame.capability === 'string'
    && typeof frame.method === 'string'
    && typeof frame.args === 'object' && frame.args !== null && !Array.isArray(frame.args)
    && typeof frame.deadline === 'number' && Number.isFinite(frame.deadline)
}
