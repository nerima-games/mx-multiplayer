/**
 * Reconnect-token issuance and rotation: the server-side counterpart of
 * `application/browser-transport.ts`'s `PlayerResume` / `PlayerResumeAccepted`
 * handshake.
 *
 * Lowered from the composing app's `multiplayer-server/reconnect-auth.ts`,
 * restructured for this repository's platform-free build. Neither
 * `AuthoritativeCommand` nor `SurvivalCommand` appears anywhere in this file
 * — it authenticates a connection before any command on either union could
 * be accepted, so it sits outside the two-authority-systems question
 * entirely, the same as `transport-security.ts`.
 *
 * ---------------------------------------------------------------------------
 * No `node:crypto` / `node:fs` here, on purpose
 * ---------------------------------------------------------------------------
 *
 * `tsconfig.build.json` compiles `src/application/` with `types: []`; a bare
 * `import { createHash } from 'node:crypto'` fails to compile here (verified:
 * `Cannot find name 'node:crypto'`), the same wall `browser-transport.ts` hit
 * for `WebSocket`. The original file's actual cryptographic and persistence
 * decisions — which hash, how tokens are generated, how the token file is
 * written atomically — are exactly the platform judgment a Port implementation
 * makes, not the pure logic this file owns: who gets issued a token, when a
 * reissue is legal, which of the current/previous hash a rotation may match.
 * `ReconnectAuthCrypto` and `ReconnectAuthStore` are that Port pair; the
 * composing app binds them to `node:crypto` and `node:fs/promises` (including
 * the write-to-temp-file-then-rename durability the original file already
 * had — that contract is documented on `ReconnectAuthStore.save` below, not
 * re-implemented here).
 */
import { Schema } from 'effect'

export const RECONNECT_TOKEN_BYTES = 32
const LEGACY_PERSISTED_FORMAT = 1
const PERSISTED_FORMAT = 2

type ReconnectTokenHashes = {
  readonly current: string
  readonly previous?: string
}

/**
 * The cryptographic primitives this module needs, bound to `node:crypto` by
 * the composing app. `hashHex` and `timingSafeEqualHex` operate on tokens as
 * they arrive over the wire (base64url strings) and hex-encoded digests as
 * they are persisted — this file never sees a raw `Buffer`.
 */
export type ReconnectAuthCrypto = {
  readonly hashHex: (token: string) => string
  readonly randomToken: () => string
  readonly timingSafeEqualHex: (left: string, right: string) => boolean
}

/**
 * Durable storage for the hash table, bound to `node:fs/promises` by the
 * composing app. `save` must be atomic — a crash mid-write must never leave a
 * torn file — which the original implementation achieved by writing to a
 * temp file and renaming; that mechanism is the Port implementation's
 * responsibility, not restated here.
 */
export type ReconnectAuthStore = {
  readonly load: () => Promise<string | undefined>
  readonly save: (contents: string) => Promise<void>
}

export type ReconnectAuth = {
  readonly has: (player: string) => boolean
  readonly issue: (player: string) => Promise<string | undefined>
  readonly reissue: (player: string) => Promise<string | undefined>
  readonly rotate: (player: string, token: string) => Promise<string | undefined>
}

const RECONNECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const HEX_HASH_PATTERN = /^[a-f0-9]{64}$/u

const isHash = (value: unknown): value is string => typeof value === 'string' && HEX_HASH_PATTERN.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const SINGLE_HASH_KEY_COUNT = 1
const HASH_WITH_PREVIOUS_KEY_COUNT = 2

const decodeHashesWithoutPrevious = (current: string, keyCount: number): ReconnectTokenHashes | undefined => {
  if (keyCount !== SINGLE_HASH_KEY_COUNT) {
    return undefined
  }
  return { current }
}

const decodeHashesWithPrevious = (
  current: string,
  previous: unknown,
  keyCount: number,
): ReconnectTokenHashes | undefined => {
  if (!isHash(previous) || keyCount !== HASH_WITH_PREVIOUS_KEY_COUNT) {
    return undefined
  }
  return { current, previous }
}

const decodeTokenHashes = (value: unknown): ReconnectTokenHashes | undefined => {
  if (!isRecord(value) || !isHash(value['current'])) {
    return undefined
  }
  const { current, previous } = value
  const keyCount = Object.keys(value).length
  if (previous === undefined) {
    return decodeHashesWithoutPrevious(current, keyCount)
  }
  return decodeHashesWithPrevious(current, previous, keyCount)
}

const decodeLegacyPlayers = (entries: ReadonlyArray<readonly [string, unknown]>): Map<string, ReconnectTokenHashes> => {
  const decoded = new Map<string, ReconnectTokenHashes>()
  for (const [player, hash] of entries) {
    if (player === '' || !isHash(hash)) {
      throw new Error('invalid reconnect auth file: legacy format')
    }
    decoded.set(player, { current: hash })
  }
  return decoded
}

const decodeCurrentPlayers = (entries: ReadonlyArray<readonly [string, unknown]>): Map<string, ReconnectTokenHashes> => {
  const decoded = new Map<string, ReconnectTokenHashes>()
  for (const [player, hashesValue] of entries) {
    const hashes = decodeTokenHashes(hashesValue)
    if (player === '' || hashes === undefined) {
      throw new Error('invalid reconnect auth file')
    }
    decoded.set(player, hashes)
  }
  return decoded
}

const decodePersisted = (source: string): Map<string, ReconnectTokenHashes> => {
  const value: unknown = JSON.parse(source)
  if (!isRecord(value) || (value['format'] !== LEGACY_PERSISTED_FORMAT && value['format'] !== PERSISTED_FORMAT) || !isRecord(value['players'])) {
    throw new Error('invalid reconnect auth file')
  }
  const entries = Object.entries(value['players'])
  if (value['format'] === LEGACY_PERSISTED_FORMAT) {
    return decodeLegacyPlayers(entries)
  }
  return decodeCurrentPlayers(entries)
}

const loadHashes = async (store: ReconnectAuthStore): Promise<Map<string, ReconnectTokenHashes>> => {
  const source = await store.load()
  if (source === undefined) {
    return new Map()
  }
  return decodePersisted(source)
}

const serializeHashes = (hashes: ReadonlyMap<string, ReconnectTokenHashes>): string =>
  `${JSON.stringify({ format: PERSISTED_FORMAT, players: Object.fromEntries(hashes) })}\n`

/** A decoded, format-validated reconnect token, or `undefined` if `token` is not one this module could have issued. */
export const ReconnectToken: Schema.filter<typeof Schema.String> = Schema.String.pipe(Schema.pattern(RECONNECT_TOKEN_PATTERN))
export type ReconnectToken = typeof ReconnectToken.Type

const isWellFormedToken = (token: string): token is ReconnectToken => RECONNECT_TOKEN_PATTERN.test(token)

type MutateQueue = { current: Promise<unknown> }

const mutate = <Result>(queue: MutateQueue, operation: () => Promise<Result>): Promise<Result> => {
  const result = queue.current.then(operation, operation)
  queue.current = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

const issueToken = (crypto: ReconnectAuthCrypto): { readonly hashes: ReconnectTokenHashes; readonly token: string } => {
  const token = crypto.randomToken()
  return { hashes: { current: crypto.hashHex(token) }, token }
}

/** Everything a mutating operation needs, bundled so no function here takes more than three parameters. */
type ReconnectAuthContext = {
  readonly crypto: ReconnectAuthCrypto
  readonly hashes: Map<string, ReconnectTokenHashes>
  readonly store: ReconnectAuthStore
}

const persistOrRevert = async (
  ctx: ReconnectAuthContext,
  player: string,
  previousEntry: ReconnectTokenHashes | undefined,
): Promise<void> => {
  try {
    await ctx.store.save(serializeHashes(ctx.hashes))
  } catch (error) {
    if (previousEntry === undefined) {
      ctx.hashes.delete(player)
    } else {
      ctx.hashes.set(player, previousEntry)
    }
    throw error
  }
}

const applyIssue = async (
  ctx: ReconnectAuthContext,
  player: string,
  previousEntry: ReconnectTokenHashes | undefined,
): Promise<string> => {
  const { hashes: nextHashes, token } = issueToken(ctx.crypto)
  ctx.hashes.set(player, nextHashes)
  await persistOrRevert(ctx, player, previousEntry)
  return token
}

const rotatedHashes = (
  crypto: ReconnectAuthCrypto,
  expected: ReconnectTokenHashes,
  matchesCurrent: boolean,
): { readonly hashes: ReconnectTokenHashes; readonly token: string } => {
  const rotated = crypto.randomToken()
  if (matchesCurrent) {
    return { hashes: { current: crypto.hashHex(rotated), previous: expected.current }, token: rotated }
  }
  return { hashes: { current: crypto.hashHex(rotated) }, token: rotated }
}

const matchesToken = (
  crypto: ReconnectAuthCrypto,
  actual: string,
  expected: ReconnectTokenHashes,
): { readonly matchesCurrent: boolean; readonly matchesPrevious: boolean } => {
  const matchesCurrent = crypto.timingSafeEqualHex(actual, expected.current)
  const matchesPrevious = expected.previous !== undefined && crypto.timingSafeEqualHex(actual, expected.previous)
  return { matchesCurrent, matchesPrevious }
}

type RotationRequest = {
  readonly actual: string
  readonly expected: ReconnectTokenHashes
  readonly player: string
}

const applyRotation = async (ctx: ReconnectAuthContext, request: RotationRequest): Promise<string | undefined> => {
  const { matchesCurrent, matchesPrevious } = matchesToken(ctx.crypto, request.actual, request.expected)
  if (!matchesCurrent && !matchesPrevious) {
    return undefined
  }
  const { hashes: nextHashes, token } = rotatedHashes(ctx.crypto, request.expected, matchesCurrent)
  ctx.hashes.set(request.player, nextHashes)
  await persistOrRevert(ctx, request.player, request.expected)
  return token
}

/**
 * Loads (or starts) the persisted reconnect-token table and returns the
 * issue/reissue/rotate/has interface the transport layer authenticates
 * `PlayerResume` requests against. Mutating operations serialize through one
 * queue per instance, so two concurrent requests for the same player cannot
 * interleave their read-modify-write of the hash table.
 */
export const createReconnectAuth = async (crypto: ReconnectAuthCrypto, store: ReconnectAuthStore): Promise<ReconnectAuth> => {
  const hashes = await loadHashes(store)
  const ctx: ReconnectAuthContext = { crypto, hashes, store }
  const queue: MutateQueue = { current: Promise.resolve() }

  const has = (player: string): boolean => hashes.has(player)

  const issue = (player: string): Promise<string | undefined> =>
    mutate(queue, async () => {
      if (player === '' || hashes.has(player)) {
        return undefined
      }
      return applyIssue(ctx, player, undefined)
    })

  const reissue = (player: string): Promise<string | undefined> =>
    mutate(queue, async () => {
      const previousEntry = hashes.get(player)
      if (player === '' || previousEntry === undefined) {
        return undefined
      }
      return applyIssue(ctx, player, previousEntry)
    })

  const rotate = (player: string, token: string): Promise<string | undefined> =>
    mutate(queue, async () => {
      const expected = hashes.get(player)
      if (!isWellFormedToken(token) || expected === undefined) {
        return undefined
      }
      const actual = crypto.hashHex(token)
      return applyRotation(ctx, { actual, expected, player })
    })

  return { has, issue, reissue, rotate }
}
