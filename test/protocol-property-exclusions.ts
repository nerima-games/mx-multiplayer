import type { NetworkMessage } from '../src/domain/protocol.js'

export type MessagePropertyExclusion = Readonly<{
  schema: string
  reason: string
  source: `src/${string}.ts:${number}`
}>

/** Schemas whose Effect arbitrary cannot generate a value, with a source-backed reason. */
export const MESSAGE_PROPERTY_EXCLUSIONS: Partial<Record<NetworkMessage['_tag'], MessagePropertyExclusion>> = {}
