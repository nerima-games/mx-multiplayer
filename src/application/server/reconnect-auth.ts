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
import { Effect, Exit, Result, Schema, Semaphore } from 'effect'
import { PlayerId } from '../../domain/protocol/identifiers.js'

export const RECONNECT_TOKEN_BYTES = 32
const LEGACY_PERSISTED_FORMAT = 1
const PERSISTED_FORMAT = 2
const MUTATION_PERMITS = 1

type ReconnectTokenHashes = {
  readonly current: string
  readonly previous?: string
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
  readonly hashHex: (token: string) => string
  readonly randomToken: () => ReconnectToken
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
  readonly load: () => Effect.Effect<string | undefined, unknown>
  readonly save: (contents: string) => Effect.Effect<void, unknown>
}

export type ReconnectAuth = {
  readonly has: (player: string) => boolean
  readonly issue: (player: string) => Effect.Effect<string | undefined, unknown>
  readonly reissue: (player: string) => Effect.Effect<string | undefined, unknown>
  readonly rotate: (player: string, token: string) => Effect.Effect<string | undefined, unknown>
  readonly resume: (token: ReconnectTokenInput) => Effect.Effect<{ readonly player: PlayerId; readonly token: ReconnectToken } | undefined, unknown>
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

const decodeLegacyPlayers = (
  entries: ReadonlyArray<readonly [string, unknown]>,
): Result.Result<Map<string, ReconnectTokenHashes>, Error> => {
  const decoded = new Map<string, ReconnectTokenHashes>()
  for (const [player, hash] of entries) {
    if (player === '' || !isHash(hash)) {
      return Result.fail(new Error('invalid reconnect auth file: legacy format'))
    }
    decoded.set(player, { current: hash })
  }
  return Result.succeed(decoded)
}

const decodeCurrentPlayers = (
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

const decodePersisted = (source: string): Result.Result<Map<string, ReconnectTokenHashes>, unknown> => {
  const parsed = Schema.decodeUnknownResult(PERSISTED_HASHES_JSON_SCHEMA)(source)
  if (Result.isFailure(parsed)) {
    return Result.fail(parsed.failure)
  }
  const value = parsed.success
  if (!isRecord(value) || (value['format'] !== LEGACY_PERSISTED_FORMAT && value['format'] !== PERSISTED_FORMAT) || !isRecord(value['players'])) {
    return Result.fail(new Error('invalid reconnect auth file'))
  }
  const entries = Object.entries(value['players'])
  if (value['format'] === LEGACY_PERSISTED_FORMAT) {
    return decodeLegacyPlayers(entries)
  }
  return decodeCurrentPlayers(entries)
}

const loadHashes = (store: ReconnectAuthStore): Effect.Effect<Map<string, ReconnectTokenHashes>, unknown> =>
  Effect.gen(function* () {
    const source = yield* store.load()
    if (source === undefined) {
      return new Map()
    }
    const decoded = decodePersisted(source)
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(decoded.failure)
    }
    return decoded.success
  })

const captureSyncFailure = <Value>(run: () => Value): Effect.Effect<Value, unknown> =>
  Effect.try({ catch: (error) => error, try: run })

const serializeHashes = (hashes: ReadonlyMap<string, ReconnectTokenHashes>): string =>
  `${JSON.stringify({ format: PERSISTED_FORMAT, players: Object.fromEntries(hashes) })}\n`

/** A decoded, format-validated reconnect token, or `undefined` if `token` is not one this module could have issued. */
export const ReconnectToken: Schema.brand<typeof ReconnectTokenInput, 'ReconnectToken'> = ReconnectTokenInput.pipe(
  Schema.check(Schema.isPattern(RECONNECT_TOKEN_PATTERN)),
  Schema.brand('ReconnectToken'),
)
export type ReconnectToken = typeof ReconnectToken.Type

const isWellFormedToken = (token: string): token is ReconnectToken => RECONNECT_TOKEN_PATTERN.test(token)

const issueToken = (crypto: ReconnectAuthCrypto): Effect.Effect<{ readonly hashes: ReconnectTokenHashes; readonly token: ReconnectToken }, unknown> =>
  Effect.gen(function* () {
    const token = yield* captureSyncFailure(() => crypto.randomToken())
    const current = yield* captureSyncFailure(() => crypto.hashHex(token))
    return { hashes: { current }, token }
  })

/** Everything a mutating operation needs, bundled so no function here takes more than three parameters. */
type ReconnectAuthContext = {
  readonly crypto: ReconnectAuthCrypto
  readonly hashes: Map<string, ReconnectTokenHashes>
  readonly store: ReconnectAuthStore
}

const persistOrRevert = (
  ctx: ReconnectAuthContext,
  player: string,
  previousEntry: ReconnectTokenHashes | undefined,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const saved = yield* Effect.exit(ctx.store.save(serializeHashes(ctx.hashes)))
    if (Exit.isSuccess(saved)) {
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

const applyIssue = (
  ctx: ReconnectAuthContext,
  player: string,
  previousEntry: ReconnectTokenHashes | undefined,
): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    const { hashes: nextHashes, token } = yield* issueToken(ctx.crypto)
    yield* Effect.sync(() => ctx.hashes.set(player, nextHashes))
    yield* persistOrRevert(ctx, player, previousEntry)
    return token
  })

const rotatedHashes = (
  crypto: ReconnectAuthCrypto,
  expected: ReconnectTokenHashes,
  matchesCurrent: boolean,
): Effect.Effect<{ readonly hashes: ReconnectTokenHashes; readonly token: ReconnectToken }, unknown> =>
  Effect.gen(function* () {
    const rotated = yield* captureSyncFailure(() => crypto.randomToken())
    const current = yield* captureSyncFailure(() => crypto.hashHex(rotated))
    let hashes: ReconnectTokenHashes = { current }
    if (matchesCurrent) {
      hashes = { current, previous: expected.current }
    }
    return { hashes, token: rotated }
  })

const matchesToken = (
  crypto: ReconnectAuthCrypto,
  actual: string,
  expected: ReconnectTokenHashes,
): Effect.Effect<{ readonly matchesCurrent: boolean; readonly matchesPrevious: boolean }, unknown> =>
  Effect.gen(function* () {
    const matchesCurrent = yield* captureSyncFailure(() => crypto.timingSafeEqualHex(actual, expected.current))
    const { previous } = expected
    let matchesPrevious = false
    if (previous !== undefined) {
      matchesPrevious = yield* captureSyncFailure(() => crypto.timingSafeEqualHex(actual, previous))
    }
    return { matchesCurrent, matchesPrevious }
  })

type RotationRequest = {
  readonly actual: string
  readonly expected: ReconnectTokenHashes
  readonly player: string
}

type RotationTarget = {
  readonly expected: ReconnectTokenHashes
  readonly matchesCurrent: boolean
  readonly player: string
}

const matchingOwner = (
  ctx: ReconnectAuthContext,
  actual: string,
  candidate: { readonly player: string; readonly expected: ReconnectTokenHashes },
): Effect.Effect<RotationTarget | undefined, unknown> =>
  Effect.gen(function* () {
    const { matchesCurrent, matchesPrevious } = yield* matchesToken(ctx.crypto, actual, candidate.expected)
    if (!matchesCurrent && !matchesPrevious) {
      return undefined
    }
    return { expected: candidate.expected, matchesCurrent, player: candidate.player }
  })

const findUniqueTokenOwner = (ctx: ReconnectAuthContext, actual: string): Effect.Effect<RotationTarget | undefined, unknown> =>
  Effect.gen(function* () {
    let owner: RotationTarget | undefined = undefined
    for (const [player, expected] of ctx.hashes) {
      const match = yield* matchingOwner(ctx, actual, { expected, player })
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
): Effect.Effect<ReconnectToken, unknown> =>
  Effect.gen(function* () {
    const { hashes: nextHashes, token } = yield* rotatedHashes(ctx.crypto, target.expected, target.matchesCurrent)
    yield* Effect.sync(() => ctx.hashes.set(target.player, nextHashes))
    yield* persistOrRevert(ctx, target.player, target.expected)
    return token
  })

const applyRotation = (
  ctx: ReconnectAuthContext,
  request: RotationRequest,
): Effect.Effect<string | undefined, unknown> =>
  Effect.gen(function* () {
    const { matchesCurrent, matchesPrevious } = yield* matchesToken(ctx.crypto, request.actual, request.expected)
    if (!matchesCurrent && !matchesPrevious) {
      return undefined
    }
    return yield* applyMatchedRotation(ctx, { expected: request.expected, matchesCurrent, player: request.player })
  })

/**
 * Loads (or starts) the persisted reconnect-token table and returns the
 * issue/reissue/rotate/resume/has interface the transport layer authenticates
 * `PlayerResume` requests against. Mutating operations serialize through one
 * queue per instance, so concurrent requests cannot interleave their
 * read-modify-write of the hash table.
 */
export const createReconnectAuth = (crypto: ReconnectAuthCrypto, store: ReconnectAuthStore): Effect.Effect<ReconnectAuth, unknown> =>
  Effect.gen(function* () {
    const hashes = yield* loadHashes(store)
    const ctx: ReconnectAuthContext = { crypto, hashes, store }
    const queue = yield* Semaphore.make(MUTATION_PERMITS)

    const has = (player: string): boolean => hashes.has(player)

    const issue = (player: string): Effect.Effect<string | undefined, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        if (player === '' || hashes.has(player)) {
          return undefined
        }
        return yield* applyIssue(ctx, player, undefined)
      }))

    const reissue = (player: string): Effect.Effect<string | undefined, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        const previousEntry = hashes.get(player)
        if (player === '' || previousEntry === undefined) {
          return undefined
        }
        return yield* applyIssue(ctx, player, previousEntry)
      }))

    const rotate = (player: string, token: string): Effect.Effect<string | undefined, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        const expected = hashes.get(player)
        if (!isWellFormedToken(token) || expected === undefined) {
          return undefined
        }
        const actual = yield* captureSyncFailure(() => crypto.hashHex(token))
        return yield* applyRotation(ctx, { actual, expected, player })
      }))

    const resume = (token: ReconnectTokenInput): Effect.Effect<{ readonly player: PlayerId; readonly token: ReconnectToken } | undefined, unknown> =>
      queue.withPermit(Effect.gen(function* () {
        if (!isWellFormedToken(token)) {
          return undefined
        }
        const actual = yield* captureSyncFailure(() => crypto.hashHex(token))
        const target = yield* findUniqueTokenOwner(ctx, actual)
        if (target === undefined) {
          return undefined
        }
        const rotated = yield* applyMatchedRotation(ctx, target)
        return { player: PlayerId.make(target.player), token: rotated }
      }))

    return { has, issue, reissue, resume, rotate }
  })
