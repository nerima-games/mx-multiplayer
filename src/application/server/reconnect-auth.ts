/**
 * Reconnect-token issuance and rotation: the server-side counterpart of
 * `application/browser-transport.ts`'s `PlayerResume` / `PlayerResumeAccepted`
 * handshake.
 *
 * Reconnect tokens expire 24 hours after issuance by default. This gives
 * disconnected players time to return while bounding how long a leaked token
 * remains valid.
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
 * makes, not the pure logic this file owns: who gets issued a token and which
 * of the current/previous hash a rotation may match.
 * `ReconnectAuthCrypto` and `ReconnectAuthStore` are that Port pair; the
 * composing app binds them to `node:crypto` and `node:fs/promises` (including
 * the write-to-temp-file-then-rename durability the original file already
 * had — that contract is documented on `ReconnectAuthStore.save` below, not
 * re-implemented here).
 * Production composition must provide cryptographically random 32-byte tokens
 * and a constant-time digest comparison; this module has no insecure fallback.
 */
import { Clock, Duration, Effect, Exit, Result, Schema, Semaphore } from 'effect'
import { PlayerId } from '../../domain/protocol/identifiers.js'

export const RECONNECT_TOKEN_BYTES = 32
const LEGACY_PERSISTED_FORMAT = 1
const CURRENT_PERSISTED_FORMAT = 2
const PERSISTED_FORMAT = 3
const MUTATION_PERMITS = 1
const DEFAULT_RECONNECT_TOKEN_TTL_HOURS = 24
const MIN_RECONNECT_TOKEN_TTL_MILLIS = 0

const DEFAULT_RECONNECT_TOKEN_TTL = Duration.hours(DEFAULT_RECONNECT_TOKEN_TTL_HOURS)
const RECONNECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const HEX_HASH_PATTERN = /^[a-f0-9]{64}$/u

export const ReconnectTokenDigest: Schema.brand<typeof Schema.String, 'ReconnectTokenDigest'> = Schema.String.pipe(
  Schema.check(Schema.isPattern(HEX_HASH_PATTERN)),
  Schema.brand('ReconnectTokenDigest'),
)
export type ReconnectTokenDigest = typeof ReconnectTokenDigest.Type

export const ReconnectAuthStoreContents: Schema.brand<typeof Schema.String, 'ReconnectAuthStoreContents'> =
  Schema.String.pipe(Schema.brand('ReconnectAuthStoreContents'))
export type ReconnectAuthStoreContents = typeof ReconnectAuthStoreContents.Type

type IssuedHash = {
  readonly hash: ReconnectTokenDigest
  readonly issuedAt: number
}

type ReconnectTokenHashes = {
  readonly current: IssuedHash
  readonly previous?: IssuedHash
}

export type ReconnectAuthOptions = {
  readonly tokenTtl?: Duration.Input
}

/** Raw resume input is branded to distinguish it from unrelated strings, then checked before use. */
export const ReconnectTokenInput: Schema.brand<typeof Schema.String, 'ReconnectTokenInput'> = Schema.String.pipe(
  Schema.brand('ReconnectTokenInput'),
)
export type ReconnectTokenInput = typeof ReconnectTokenInput.Type

/**
 * The cryptographic primitives this module needs, bound to `node:crypto` by
 * the composing app. `hashHex` and `timingSafeEqualHex` operate on tokens as
 * they arrive over the wire (base64url strings) and hex-encoded digests as
 * they are persisted — this file never sees a raw `Buffer`.
 */
export type ReconnectAuthCrypto = {
  readonly hashHex: (token: ReconnectTokenInput) => ReconnectTokenDigest
  readonly randomToken: () => ReconnectToken
  readonly timingSafeEqualHex: (left: ReconnectTokenDigest, right: ReconnectTokenDigest) => boolean
}

/**
 * Durable storage for the hash table, bound to `node:fs/promises` by the
 * composing app. `save` must be atomic — a crash mid-write must never leave a
 * torn file — which the original implementation achieved by writing to a
 * temp file and renaming; that mechanism is the Port implementation's
 * responsibility, not restated here.
 */
export type ReconnectAuthStore = {
  readonly load: () => Effect.Effect<ReconnectAuthStoreContents | undefined, unknown>
  readonly save: (contents: ReconnectAuthStoreContents) => Effect.Effect<void, unknown>
}

export type ReconnectAuth = {
  readonly has: (player: PlayerId) => boolean
  readonly issue: (player: PlayerId) => Effect.Effect<ReconnectToken | undefined, unknown>
  readonly revoke: (player: PlayerId) => Effect.Effect<boolean, unknown>
  readonly rotate: (player: PlayerId, token: ReconnectTokenInput) => Effect.Effect<ReconnectToken | undefined, unknown>
  readonly resume: (token: ReconnectTokenInput) => Effect.Effect<{ readonly player: PlayerId; readonly token: ReconnectToken } | undefined, unknown>
}

const isHash = (value: unknown): value is ReconnectTokenDigest =>
  typeof value === 'string' && HEX_HASH_PATTERN.test(value)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const SINGLE_HASH_KEY_COUNT = 1
const HASH_WITH_PREVIOUS_KEY_COUNT = 2
const ISSUED_HASH_KEY_COUNT = 2

const decodeLegacyTokenHashes = (value: unknown, issuedAt: number): ReconnectTokenHashes | undefined => {
  if (!isRecord(value) || !isHash(value['current'])) {
    return undefined
  }
  const { current, previous } = value
  const keyCount = Object.keys(value).length
  if (previous === undefined && keyCount === SINGLE_HASH_KEY_COUNT) {
    return { current: { hash: current, issuedAt } }
  }
  if (isHash(previous) && keyCount === HASH_WITH_PREVIOUS_KEY_COUNT) {
    return { current: { hash: current, issuedAt }, previous: { hash: previous, issuedAt } }
  }
  return undefined
}

const isIssuedHash = (value: unknown): value is IssuedHash =>
  isRecord(value) &&
  isHash(value['hash']) &&
  Number.isSafeInteger(value['issuedAt']) &&
  Object.keys(value).length === ISSUED_HASH_KEY_COUNT

const decodeTokenHashes = (value: unknown): ReconnectTokenHashes | undefined => {
  if (!isRecord(value) || !isIssuedHash(value['current'])) {
    return undefined
  }
  const { current, previous } = value
  const keyCount = Object.keys(value).length
  if (previous === undefined && keyCount === SINGLE_HASH_KEY_COUNT) {
    return { current }
  }
  if (isIssuedHash(previous) && keyCount === HASH_WITH_PREVIOUS_KEY_COUNT) {
    return { current, previous }
  }
  return undefined
}

const decodeLegacyPlayers = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  issuedAt: number,
): Result.Result<Map<string, ReconnectTokenHashes>, Error> => {
  const decoded = new Map<string, ReconnectTokenHashes>()
  for (const [player, hash] of entries) {
    if (player === '' || !isHash(hash)) {
      return Result.fail(new Error('invalid reconnect auth file: legacy format'))
    }
    decoded.set(player, { current: { hash, issuedAt } })
  }
  return Result.succeed(decoded)
}

const decodeV2Players = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  issuedAt: number,
): Result.Result<Map<string, ReconnectTokenHashes>, Error> => {
  const decoded = new Map<string, ReconnectTokenHashes>()
  for (const [player, hashesValue] of entries) {
    const hashes = decodeLegacyTokenHashes(hashesValue, issuedAt)
    if (player === '' || hashes === undefined) {
      return Result.fail(new Error('invalid reconnect auth file'))
    }
    decoded.set(player, hashes)
  }
  return Result.succeed(decoded)
}

const decodeV3Players = (
  entries: ReadonlyArray<readonly [string, unknown]>,
): Result.Result<Map<string, ReconnectTokenHashes>, Error> => {
  const decoded = new Map<string, ReconnectTokenHashes>()
  for (const [player, hashesValue] of entries) {
    const hashes = decodeTokenHashes(hashesValue)
    if (player === '' || hashes === undefined) {
      return Result.fail(new Error('invalid reconnect auth file'))
    }
    decoded.set(player, hashes)
  }
  return Result.succeed(decoded)
}

const PERSISTED_HASHES_JSON_SCHEMA = Schema.fromJsonString(Schema.Unknown)

const decodePersistedPlayers = (
  format: unknown,
  players: Record<string, unknown>,
  loadedAt: number,
): Result.Result<Map<string, ReconnectTokenHashes>, Error> => {
  const entries = Object.entries(players)
  switch (format) {
    case LEGACY_PERSISTED_FORMAT:
      return decodeLegacyPlayers(entries, loadedAt)
    case CURRENT_PERSISTED_FORMAT:
      return decodeV2Players(entries, loadedAt)
    case PERSISTED_FORMAT:
      return decodeV3Players(entries)
    default:
      return Result.fail(new Error('invalid reconnect auth file'))
  }
}

const decodePersisted = (source: string, loadedAt: number): Result.Result<Map<string, ReconnectTokenHashes>, unknown> => {
  const parsed = Schema.decodeUnknownResult(PERSISTED_HASHES_JSON_SCHEMA)(source)
  if (Result.isFailure(parsed)) {
    return Result.fail(parsed.failure)
  }
  const value = parsed.success
  if (!isRecord(value) || !isRecord(value['players'])) {
    return Result.fail(new Error('invalid reconnect auth file'))
  }
  const { format, players } = value
  return decodePersistedPlayers(format, players, loadedAt)
}

const loadHashes = (store: ReconnectAuthStore): Effect.Effect<Map<string, ReconnectTokenHashes>, unknown> =>
  Effect.gen(function* () {
    const source = yield* store.load()
    if (source === undefined) {
      return new Map()
    }
    // Formats 1 and 2 have no issue times, so their TTL starts at load time.
    const loadedAt = yield* Clock.currentTimeMillis
    const decoded = decodePersisted(source, loadedAt)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(decoded.failure)
    }
    return decoded.success
  })

const captureSyncFailure = <Value>(run: () => Value): Effect.Effect<Value, unknown> =>
  Effect.try({ catch: (error) => error, try: run })

const isExpired = (hash: IssuedHash, now: number, tokenTtlMillis: number): boolean =>
  now < hash.issuedAt || hash.issuedAt + tokenTtlMillis <= now

const retainValidHash = (hash: IssuedHash | undefined, now: number, tokenTtlMillis: number): IssuedHash | undefined => {
  if (hash === undefined || isExpired(hash, now, tokenTtlMillis)) {
    return undefined
  }
  return hash
}

const retainValidHashes = (hashes: ReconnectTokenHashes, now: number, tokenTtlMillis: number): ReconnectTokenHashes | undefined => {
  const { current, previous } = hashes
  const validCurrent = retainValidHash(current, now, tokenTtlMillis)
  const validPrevious = retainValidHash(previous, now, tokenTtlMillis)
  if (validCurrent !== undefined && validPrevious !== undefined) {
    return { current: validCurrent, previous: validPrevious }
  }
  if (validCurrent !== undefined) {
    return { current: validCurrent }
  }
  if (validPrevious !== undefined) {
    return { current: validPrevious }
  }
  return undefined
}

type SerializedHashes = {
  readonly hashes: Map<string, ReconnectTokenHashes>
  readonly contents: ReconnectAuthStoreContents
}

const serializePrunedHashes = (hashes: ReadonlyMap<string, ReconnectTokenHashes>, now: number, tokenTtlMillis: number): SerializedHashes => {
  const retained = new Map<string, ReconnectTokenHashes>()
  const players: Record<string, ReconnectTokenHashes> = Object.create(null)
  for (const [player, entry] of hashes) {
    const validHashes = retainValidHashes(entry, now, tokenTtlMillis)
    if (validHashes !== undefined) {
      retained.set(player, validHashes)
      players[player] = validHashes
    }
  }
  return {
    contents: ReconnectAuthStoreContents.make(`${JSON.stringify({ format: PERSISTED_FORMAT, players })}\n`),
    hashes: retained,
  }
}

/** A decoded, format-validated reconnect token, or `undefined` if `token` is not one this module could have issued. */
export const ReconnectToken: Schema.brand<typeof ReconnectTokenInput, 'ReconnectToken'> = ReconnectTokenInput.pipe(
  Schema.check(Schema.isPattern(RECONNECT_TOKEN_PATTERN)),
  Schema.brand('ReconnectToken'),
)
export type ReconnectToken = typeof ReconnectToken.Type

const isWellFormedToken = (token: string): token is ReconnectToken => RECONNECT_TOKEN_PATTERN.test(token)

const issueToken = (crypto: ReconnectAuthCrypto, issuedAt: number): Effect.Effect<{ readonly hashes: ReconnectTokenHashes; readonly token: ReconnectToken }, unknown> =>
  Effect.gen(function* () {
    const token = yield* captureSyncFailure(() => crypto.randomToken())
    const current = yield* captureSyncFailure(() => crypto.hashHex(token))
    return { hashes: { current: { hash: current, issuedAt } }, token }
  })

/** Everything a mutating operation needs, bundled so no function here takes more than three parameters. */
type ReconnectAuthContext = {
  readonly crypto: ReconnectAuthCrypto
  hashes: Map<string, ReconnectTokenHashes>
  readonly store: ReconnectAuthStore
  readonly tokenTtlMillis: number
}

type PlayerMutation = {
  readonly ctx: ReconnectAuthContext
  readonly now: number
  readonly player: string
  readonly previousEntry: ReconnectTokenHashes | undefined
}

const persistOrRevert = ({ ctx, now, player, previousEntry }: PlayerMutation): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const saved = yield* Effect.exit(Effect.gen(function* () {
      const serialized = yield* captureSyncFailure(() => serializePrunedHashes(ctx.hashes, now, ctx.tokenTtlMillis))
      yield* ctx.store.save(serialized.contents)
      return serialized.hashes
    }))
    if (Exit.isSuccess(saved)) {
      yield* Effect.sync(() => {
        ctx.hashes = saved.value
      })
      return
    }
    yield* Effect.sync(() => {
      if (previousEntry === undefined) {
        ctx.hashes.delete(player)
      } else {
        ctx.hashes.set(player, previousEntry)
      }
    })
    return yield* Effect.failCause(saved.cause)
  })

const applyIssue = ({ ctx, now, player, previousEntry }: PlayerMutation): Effect.Effect<ReconnectToken, unknown> =>
  Effect.gen(function* () {
    const { hashes: nextHashes, token } = yield* issueToken(ctx.crypto, now)
    yield* Effect.sync(() => ctx.hashes.set(player, nextHashes))
    yield* persistOrRevert({ ctx, now, player, previousEntry })
    return token
  })

const rotatedHashes = ({
  crypto,
  expected,
  matchesCurrent,
  issuedAt,
}: {
  readonly crypto: ReconnectAuthCrypto
  readonly expected: ReconnectTokenHashes
  readonly matchesCurrent: boolean
  readonly issuedAt: number
}): Effect.Effect<{ readonly hashes: ReconnectTokenHashes; readonly token: ReconnectToken }, unknown> =>
  Effect.gen(function* () {
    const rotated = yield* captureSyncFailure(() => crypto.randomToken())
    const current = yield* captureSyncFailure(() => crypto.hashHex(rotated))
    let hashes: ReconnectTokenHashes = { current: { hash: current, issuedAt } }
    if (matchesCurrent) {
      hashes = { current: { hash: current, issuedAt }, previous: expected.current }
    }
    return { hashes, token: rotated }
  })

type TokenMatchRequest = {
  readonly crypto: ReconnectAuthCrypto
  readonly actual: ReconnectTokenDigest
  readonly expected: ReconnectTokenHashes
  readonly now: number
  readonly tokenTtlMillis: number
}

const matchesToken = ({ crypto, actual, expected, now, tokenTtlMillis }: TokenMatchRequest): Effect.Effect<{
  readonly matchesCurrent: boolean
  readonly matchesPrevious: boolean
}, unknown> =>
  Effect.gen(function* () {
    const equalsCurrent = yield* captureSyncFailure(() => crypto.timingSafeEqualHex(actual, expected.current.hash))
    const matchesCurrent = equalsCurrent && !isExpired(expected.current, now, tokenTtlMillis)
    const { previous } = expected
    let matchesPrevious = false
    if (previous !== undefined) {
      const equalsPrevious = yield* captureSyncFailure(() => crypto.timingSafeEqualHex(actual, previous.hash))
      matchesPrevious = equalsPrevious && !isExpired(previous, now, tokenTtlMillis)
    }
    return { matchesCurrent, matchesPrevious }
  })

type RotationRequest = {
  readonly actual: ReconnectTokenDigest
  readonly expected: ReconnectTokenHashes
  readonly player: string
}

type RotationTarget = {
  readonly expected: ReconnectTokenHashes
  readonly matchesCurrent: boolean
  readonly player: string
}

type MatchingOwnerRequest = {
  readonly ctx: ReconnectAuthContext
  readonly actual: ReconnectTokenDigest
  readonly candidate: { readonly player: string; readonly expected: ReconnectTokenHashes }
  readonly now: number
}

const matchingOwner = ({ ctx, actual, candidate, now }: MatchingOwnerRequest): Effect.Effect<RotationTarget | undefined, unknown> =>
  Effect.gen(function* () {
    const { matchesCurrent, matchesPrevious } = yield* matchesToken({
      actual,
      crypto: ctx.crypto,
      expected: candidate.expected,
      now,
      tokenTtlMillis: ctx.tokenTtlMillis,
    })
    if (!matchesCurrent && !matchesPrevious) {
      return undefined
    }
    return { expected: candidate.expected, matchesCurrent, player: candidate.player }
  })

const findUniqueTokenOwner = (
  ctx: ReconnectAuthContext,
  actual: ReconnectTokenDigest,
  now: number,
): Effect.Effect<RotationTarget | undefined, unknown> =>
  Effect.gen(function* () {
    let owner: RotationTarget | undefined = undefined
    for (const [player, expected] of ctx.hashes) {
      const match = yield* matchingOwner({ actual, candidate: { expected, player }, ctx, now })
      if (match !== undefined) {
        if (owner !== undefined) {
          return undefined
        }
        owner = match
      }
    }
    return owner
  })

const applyMatchedRotation = (
  ctx: ReconnectAuthContext,
  target: RotationTarget,
  now: number,
): Effect.Effect<ReconnectToken, unknown> =>
  Effect.gen(function* () {
    const { hashes: nextHashes, token } = yield* rotatedHashes({
      crypto: ctx.crypto,
      expected: target.expected,
      issuedAt: now,
      matchesCurrent: target.matchesCurrent,
    })
    yield* Effect.sync(() => ctx.hashes.set(target.player, nextHashes))
    yield* persistOrRevert({ ctx, now, player: target.player, previousEntry: target.expected })
    return token
  })

const applyRotation = (
  ctx: ReconnectAuthContext,
  request: RotationRequest,
  now: number,
): Effect.Effect<ReconnectToken | undefined, unknown> =>
  Effect.gen(function* () {
    const { matchesCurrent, matchesPrevious } = yield* matchesToken({
      actual: request.actual,
      crypto: ctx.crypto,
      expected: request.expected,
      now,
      tokenTtlMillis: ctx.tokenTtlMillis,
    })
    if (!matchesCurrent && !matchesPrevious) {
      return undefined
    }
    return yield* applyMatchedRotation(ctx, { expected: request.expected, matchesCurrent, player: request.player }, now)
  })

const resolveReconnectTokenTtl = (options: ReconnectAuthOptions | undefined): Effect.Effect<number, unknown> =>
  Effect.gen(function* () {
    const tokenTtlMillis = yield* captureSyncFailure(() => Duration.toMillis(options?.tokenTtl ?? DEFAULT_RECONNECT_TOKEN_TTL))
    if (!Number.isFinite(tokenTtlMillis) || tokenTtlMillis <= MIN_RECONNECT_TOKEN_TTL_MILLIS) {
      return yield* Effect.fail(new Error('reconnect token TTL must be a finite positive duration'))
    }
    return tokenTtlMillis
  })

const makeReconnectAuthOperations = (ctx: ReconnectAuthContext): Effect.Effect<ReconnectAuth, unknown> =>
  Effect.gen(function* () {
    const queue = yield* Semaphore.make(MUTATION_PERMITS)

    // `has` reports a stored player entry; resume/rotate check whether its hashes are still valid.
    const has = (player: PlayerId): boolean => ctx.hashes.has(player)

    const issue = (player: PlayerId): Effect.Effect<ReconnectToken | undefined, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        if (player === '' || ctx.hashes.has(player)) {
          return undefined
        }
        const now = yield* Clock.currentTimeMillis
        return yield* applyIssue({ ctx, now, player, previousEntry: undefined })
      }))

    const revoke = (player: PlayerId): Effect.Effect<boolean, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        const previousEntry = ctx.hashes.get(player)
        if (player === '' || previousEntry === undefined) {
          return false
        }
        const now = yield* Clock.currentTimeMillis
        yield* Effect.sync(() => ctx.hashes.delete(player))
        yield* persistOrRevert({ ctx, now, player, previousEntry })
        return true
      }))

    const rotate = (player: PlayerId, token: ReconnectTokenInput): Effect.Effect<ReconnectToken | undefined, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        const expected = ctx.hashes.get(player)
        if (!isWellFormedToken(token) || expected === undefined) {
          return undefined
        }
        const now = yield* Clock.currentTimeMillis
        const actual = yield* captureSyncFailure(() => ctx.crypto.hashHex(token))
        return yield* applyRotation(ctx, { actual, expected, player }, now)
      }))

    const resume = (token: ReconnectTokenInput): Effect.Effect<{ readonly player: PlayerId; readonly token: ReconnectToken } | undefined, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        if (!isWellFormedToken(token)) {
          return undefined
        }
        const now = yield* Clock.currentTimeMillis
        const actual = yield* captureSyncFailure(() => ctx.crypto.hashHex(token))
        const target = yield* findUniqueTokenOwner(ctx, actual, now)
        if (target === undefined) {
          return undefined
        }
        const rotated = yield* applyMatchedRotation(ctx, target, now)
        return { player: PlayerId.make(target.player), token: rotated }
      }))

    return { has, issue, resume, revoke, rotate }
  })

/**
 * Loads (or starts) the persisted reconnect-token table and returns the
 * issue/revoke/rotate/resume/has interface the transport layer authenticates
 * `PlayerResume` requests against. Mutating operations serialize through one
 * queue per instance, so concurrent requests cannot interleave their
 * read-modify-write of the hash table.
 */
export const createReconnectAuth = (
  crypto: ReconnectAuthCrypto,
  store: ReconnectAuthStore,
  options?: ReconnectAuthOptions,
): Effect.Effect<ReconnectAuth, unknown> =>
  Effect.gen(function* () {
    const tokenTtlMillis = yield* resolveReconnectTokenTtl(options)
    const hashes = yield* loadHashes(store)
    return yield* makeReconnectAuthOperations({ crypto, hashes, store, tokenTtlMillis })
  })
