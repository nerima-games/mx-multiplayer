/**
 * Peeking at a frame's message tag without paying for a full `Schema` decode.
 *
 * Lowered from the composing app's `multiplayer-server/wire-frame-validation.ts`
 * — partially. That file also exported `specializedFrameWireLengths`, a map
 * from message tag to a maximum wire length, sourced from each
 * `multiplayer-shared/*-network.ts` file's own `*_MAX_WIRE_LENGTH` constant.
 * Those files and their hand-rolled codecs are gone: the messages they carried
 * (anvil, brewing, crafting, ...) now decode through the single `Schema`-based
 * `NetworkMessage` union in `domain/protocol.ts` via `domain/codec.ts`, which
 * has no per-tag length ceiling of its own. Porting the map forward would
 * mean inventing new numbers with no source to mirror, so it is dropped
 * rather than guessed at — a uniform frame-size limit, if one is wanted, is a
 * transport-level concern (`application/browser-transport.ts` and its
 * server-side counterpart), not a per-message one.
 *
 * `frameTag` and `unknownRecord` carry no such assumption and are unchanged
 * in behaviour: this file's only judgment is "read the `_tag` string off an
 * otherwise-unvalidated frame," useful for routing or diagnostics before a
 * full decode is worth attempting. It does not appear in either
 * `AuthoritativeCommand` or `SurvivalCommand`.
 */
import type { WireText } from '../../domain/codec.js'

export type UnknownRecord = Readonly<Record<string, unknown>>

const isUnknownRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null

export const unknownRecord = (value: unknown): UnknownRecord | undefined => {
  if (isUnknownRecord(value)) {
    return value
  }
  return undefined
}

const JSON_PARSE_FAILED: unique symbol = Symbol('frame-inspection/json-parse-failed')

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return JSON_PARSE_FAILED
  }
}

/** The frame's `_tag`, or `undefined` if the frame is not JSON, not an object, or has no string `_tag`. */
export const frameTag = (frame: WireText): string | undefined => {
  const tag = unknownRecord(tryParseJson(frame))?.['_tag']
  if (typeof tag === 'string') {
    return tag
  }
  return undefined
}
