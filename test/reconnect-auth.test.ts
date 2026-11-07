import { describe, expect, it } from '@effect/vitest'
import { Duration, Effect } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { PlayerId } from '../src/domain/protocol/identifiers'
import {
  RECONNECT_TOKEN_BYTES,
  ReconnectToken,
  ReconnectTokenInput,
  createReconnectAuth as createReconnectAuthEffect,
  type ReconnectAuth,
  type ReconnectAuthCrypto,
  type ReconnectAuthStore,
} from '../src/application/server/reconnect-auth'

/**
 * The real Node primitives, wired to the injected Port shape — this is what
 * the composing app's implementation looks like, and using the genuine
 * algorithms (not a fake hash) is what makes the rotation/timing-safe-compare
 * tests below meaningful.
 */
const nodeCrypto: ReconnectAuthCrypto = {
  hashHex: (token) => createHash('sha256').update(token).digest('hex'),
  randomToken: () => ReconnectToken.make(randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')),
  timingSafeEqualHex: (left, right) => {
    if (left.length !== right.length) {
      return false
    }
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  },
}

type ReconnectAuthClient = {
  readonly has: ReconnectAuth['has']
  readonly issue: (player: string) => Promise<string | undefined>
  readonly reissue: (player: string) => Promise<string | undefined>
  readonly rotate: (player: string, token: string) => Promise<string | undefined>
  readonly resume: (token: string) => Promise<{ readonly player: PlayerId; readonly token: string } | undefined>
}

const createReconnectAuth = async (
  crypto: ReconnectAuthCrypto,
  store: ReconnectAuthStore,
): Promise<ReconnectAuthClient> => {
  const auth = await Effect.runPromise(createReconnectAuthEffect(crypto, store))
  return {
    has: auth.has,
    issue: (player) => Effect.runPromise(auth.issue(player)),
    reissue: (player) => Effect.runPromise(auth.reissue(player)),
    rotate: (player, token) => Effect.runPromise(auth.rotate(player, token)),
    resume: (token) => Effect.runPromise(auth.resume(ReconnectTokenInput.make(token))),
  }
}

const definedOrThrow = <Value>(value: Value | undefined): Value => {
  if (value === undefined) {
    throw new Error('expected a defined value')
  }
  return value
}

const inMemoryStore = (): ReconnectAuthStore & { readonly writes: string[] } => {
  let contents: string | undefined = undefined
  const writes: string[] = []
  return {
    load: () => Effect.sync(() => contents),
    save: (next) => {
      contents = next
      writes.push(next)
      return Effect.void
    },
    writes,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readPersistedPlayers = (source: string | undefined): Record<string, unknown> => {
  const saved: unknown = JSON.parse(source ?? '{}')
  if (!isRecord(saved)) {
    throw new Error('expected reconnect auth file object')
  }
  const players = saved['players']
  if (!isRecord(players)) {
    throw new Error('expected reconnect auth players object')
  }
  return players
}

describe('createReconnectAuth', () => {
  it('issues a token for a new player and persists it', async () => {
    const store = inMemoryStore()
    const auth = await createReconnectAuth(nodeCrypto, store)
    const token = await auth.issue('alice')
    expect(token).toBeDefined()
    expect(auth.has('alice')).toBe(true)
    expect(store.writes.length).toBe(1)
  })

  it('propagates a synchronous token-generation failure without changing state', async () => {
    const store = inMemoryStore()
    const crypto: ReconnectAuthCrypto = {
      ...nodeCrypto,
      randomToken: () => {
        throw new Error('entropy unavailable')
      },
    }
    const auth = await createReconnectAuth(crypto, store)

    await expect(auth.issue('alice')).rejects.toThrow('entropy unavailable')
    expect(auth.has('alice')).toBe(false)
    expect(store.writes).toHaveLength(0)
  })

  it('does not reissue a token for a player who already has one via issue()', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const first = await auth.issue('alice')
    const second = await auth.issue('alice')
    expect(first).toBeDefined()
    expect(second).toBeUndefined()
  })

  it('rejects issuing for an empty player id', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    expect(await auth.issue('')).toBeUndefined()
  })

  it('reissue replaces a player with no prior token with nothing', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    expect(await auth.reissue('alice')).toBeUndefined()
  })

  it('reissue mints a new token for a player who already has one', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const first = await auth.issue('alice')
    const second = await auth.reissue('alice')
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    // A reissue does not keep the replaced token as "previous": only rotate() does.
    expect(await auth.rotate('alice', definedOrThrow(first))).toBeUndefined()
    expect(await auth.rotate('alice', definedOrThrow(second))).toBeDefined()
  })

  it('rotate accepts the current token and rejects the token it replaced', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const issued = await auth.issue('alice')
    expect(issued).toBeDefined()
    const first = definedOrThrow(issued)
    const rotated = await auth.rotate('alice', first)
    expect(rotated).toBeDefined()
    expect(rotated).not.toBe(first)
    // The token just replaced is now the "previous" hash and is still accepted once.
    const rotatedAgain = await auth.rotate('alice', first)
    expect(rotatedAgain).toBeDefined()
  })

  it('rotate rejects a token two generations old', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const issued = await auth.issue('alice')
    const first = definedOrThrow(issued)
    const second = await auth.rotate('alice', first)
    await auth.rotate('alice', definedOrThrow(second))
    // `first` is now neither current nor previous.
    expect(await auth.rotate('alice', first)).toBeUndefined()
  })

  it('rotate rejects a malformed token', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    await auth.issue('alice')
    expect(await auth.rotate('alice', 'not-a-valid-token')).toBeUndefined()
  })

  it('rotate rejects a well-formed token for a player with none issued', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const fakeToken = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
    expect(await auth.rotate('nobody', fakeToken)).toBeUndefined()
  })

  it('resumes with the stored player even when a different player claim was rejected', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const token = definedOrThrow(await auth.issue('alice'))

    expect(await auth.rotate('bob', token)).toBeUndefined()
    const resumed = await auth.resume(token)

    expect(resumed?.player).toBe(PlayerId.make('alice'))
    expect(resumed?.token).toBeDefined()
    expect(resumed?.token).not.toBe(token)
  })

  it('resume rejects malformed and unknown tokens without persisting a rotation', async () => {
    const store = inMemoryStore()
    const auth = await createReconnectAuth(nodeCrypto, store)

    expect(await auth.resume('A'.repeat(43))).toBeUndefined()
    await auth.issue('alice')
    expect(await auth.resume('not-a-valid-token')).toBeUndefined()
    expect(await auth.resume('A'.repeat(43))).toBeUndefined()
    expect(store.writes.length).toBe(1)
  })

  it('resume rejects a token that matches more than one stored player', async () => {
    const token = 'A'.repeat(43)
    const hash = nodeCrypto.hashHex(token)
    let writes = 0
    const store: ReconnectAuthStore = {
      load: () => Effect.succeed(JSON.stringify({
        format: 2,
        players: { alice: { current: hash }, bob: { current: hash } },
      })),
      save: () => {
        writes += 1
        return Effect.void
      },
    }
    const auth = await createReconnectAuth(nodeCrypto, store)

    expect(await auth.resume(token)).toBeUndefined()
    expect(writes).toBe(0)
  })

  it('resume accepts the stored previous token and returns its assigned player', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const token = definedOrThrow(await auth.issue('alice'))
    await auth.rotate('alice', token)

    const resumed = await auth.resume(token)

    expect(resumed?.player).toBe(PlayerId.make('alice'))
    expect(resumed?.token).toBeDefined()
    expect(resumed?.token).not.toBe(token)
  })

  it('does not return an identity or rotate the token when resume persistence fails', async () => {
    let allowSave = true
    const contents: { value: string | undefined } = { value: undefined }
    const store: ReconnectAuthStore = {
      load: () => Effect.sync(() => contents.value),
      save: (next) => {
        if (!allowSave) {
          return Effect.fail(new Error('disk full'))
        }
        contents.value = next
        return Effect.void
      },
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    const token = definedOrThrow(await auth.issue('alice'))
    allowSave = false

    await expect(auth.resume(token)).rejects.toThrow('disk full')
    allowSave = true
    const resumed = await auth.resume(token)

    expect(resumed?.player).toBe(PlayerId.make('alice'))
    expect(resumed?.token).toBeDefined()
  })

  it('reverts the in-memory hash on a persistence failure during issue', async () => {
    const store: ReconnectAuthStore = {
      load: () => Effect.succeed(undefined),
      save: () => Effect.fail(new Error('disk full')),
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    await expect(auth.issue('alice')).rejects.toThrow('disk full')
    expect(auth.has('alice')).toBe(false)
  })

  it('restores the previous hash on a persistence failure during rotate', async () => {
    let allowSave = true
    const contents: { value: string | undefined } = { value: undefined }
    const store: ReconnectAuthStore = {
      load: () => Effect.sync(() => contents.value),
      save: (next) => {
        if (!allowSave) {
          return Effect.fail(new Error('disk full'))
        }
        contents.value = next
        return Effect.void
      },
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    const first = await auth.issue('alice')
    allowSave = false
    await expect(auth.rotate('alice', definedOrThrow(first))).rejects.toThrow('disk full')
    allowSave = true
    // The rotation was rolled back, so the ORIGINAL token must still authenticate.
    expect(await auth.rotate('alice', definedOrThrow(first))).toBeDefined()
  })

  it('rejects a legacy-format (v1) persisted file with an invalid hash', async () => {
    const store: ReconnectAuthStore = {
      load: () => Effect.succeed(JSON.stringify({ format: 1, players: { alice: 'not-a-hash' } })),
      save: () => Effect.void,
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('loads a legacy-format (v1) persisted file with a valid hash', async () => {
    const hash = nodeCrypto.hashHex('seed-token')
    const store: ReconnectAuthStore = {
      load: () => Effect.succeed(JSON.stringify({ format: 1, players: { alice: hash } })),
      save: () => Effect.void,
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    expect(auth.has('alice')).toBe(true)
    expect(await auth.rotate('alice', 'seed-token'.padEnd(43, 'A'))).toBeUndefined()
  })

  it('rejects a current-format persisted file with an excess key', async () => {
    const store: ReconnectAuthStore = {
      load: () =>
        Effect.succeed(
          JSON.stringify({ format: 2, players: { alice: { current: nodeCrypto.hashHex('x'), extra: 'y' } } }),
        ),
      save: () => Effect.void,
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('rejects a current-format persisted file whose current hash is malformed', async () => {
    const store: ReconnectAuthStore = {
      load: () => Effect.succeed(JSON.stringify({ format: 2, players: { alice: { current: 'not-a-hash' } } })),
      save: () => Effect.void,
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('loads a current-format persisted file with a single current hash and no previous', async () => {
    const seedToken = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
    const store: ReconnectAuthStore = {
      load: () =>
        Effect.succeed(JSON.stringify({ format: 2, players: { alice: { current: nodeCrypto.hashHex(seedToken) } } })),
      save: () => Effect.void,
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    expect(auth.has('alice')).toBe(true)
    expect(await auth.rotate('alice', seedToken)).toBeDefined()
  })

  it('loads a current-format persisted file with both current and previous hashes', async () => {
    const currentToken = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
    const previousToken = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
    const store: ReconnectAuthStore = {
      load: () =>
        Effect.succeed(
          JSON.stringify({
            format: 2,
            players: {
              alice: { current: nodeCrypto.hashHex(currentToken), previous: nodeCrypto.hashHex(previousToken) },
            },
          }),
        ),
      save: () => Effect.void,
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    // Both the current and the still-valid previous hash authenticate a rotate.
    expect(await auth.rotate('alice', previousToken)).toBeDefined()
  })

  it('rejects a current-format persisted file whose previous hash is malformed', async () => {
    const store: ReconnectAuthStore = {
      load: () =>
        Effect.succeed(
          JSON.stringify({ format: 2, players: { alice: { current: nodeCrypto.hashHex('x'), previous: 'not-a-hash' } } }),
        ),
      save: () => Effect.void,
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('rejects a file that is not valid JSON', async () => {
    const store: ReconnectAuthStore = { load: () => Effect.succeed('not json'), save: () => Effect.void }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('rejects a file with an unknown format number', async () => {
    const store: ReconnectAuthStore = {
      load: () => Effect.succeed(JSON.stringify({ format: 99, players: {} })),
      save: () => Effect.void,
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('starts empty when the store has nothing persisted', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    expect(auth.has('alice')).toBe(false)
  })

  // This catches an omitted-option regression and proves the documented default expires at exactly one day.
  it.effect('uses the 24-hour default when options are omitted', () =>
    Effect.gen(function* () {
      const auth = yield* createReconnectAuthEffect(nodeCrypto, inMemoryStore())
      const token = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.hours(24))

      expect(yield* auth.rotate('alice', token)).toBeUndefined()
    }),
  )

  // This catches an off-by-one expiry comparison and tokens expiring early or late.
  it.effect('accepts just before TTL and rejects at and after TTL', () =>
    Effect.gen(function* () {
      const ttl = Duration.seconds(10)
      const auth = yield* createReconnectAuthEffect(nodeCrypto, inMemoryStore(), { tokenTtl: ttl })
      const before = definedOrThrow(yield* auth.issue('before'))
      const exact = definedOrThrow(yield* auth.issue('exact'))
      const after = definedOrThrow(yield* auth.issue('after'))

      yield* TestClock.adjust(Duration.seconds(9))
      expect(yield* auth.rotate('before', before)).toBeDefined()
      yield* TestClock.adjust(Duration.seconds(1))
      expect(yield* auth.rotate('exact', exact)).toBeUndefined()
      yield* TestClock.adjust(Duration.millis(1))
      expect(yield* auth.rotate('after', after)).toBeUndefined()
    }),
  )

  // This catches resetting the previous token's age during rotation or failing to start the replacement's TTL at rotation.
  it.effect('keeps the previous issue time and gives a rotated token a fresh TTL', () =>
    Effect.gen(function* () {
      const auth = yield* createReconnectAuthEffect(nodeCrypto, inMemoryStore(), { tokenTtl: Duration.seconds(10) })
      const original = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.seconds(9))
      const rotated = definedOrThrow(yield* auth.rotate('alice', original))
      yield* TestClock.adjust(Duration.seconds(1))

      expect(yield* auth.rotate('alice', original)).toBeUndefined()
      expect(yield* auth.rotate('alice', rotated)).toBeDefined()
    }),
  )

  // This catches ignoring TTL in resume() while rotate() enforces it.
  it.effect('rejects an expired token from resume without saving a rotation', () =>
    Effect.gen(function* () {
      const store = inMemoryStore()
      const auth = yield* createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.seconds(10) })
      const token = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.seconds(10))

      expect(yield* auth.resume(ReconnectTokenInput.make(token))).toBeUndefined()
      expect(store.writes).toHaveLength(1)
    }),
  )

  // This catches migration timestamps anchored to an old epoch instead of the time v1 data is loaded.
  it.effect('starts a v1 token TTL when the file is loaded', () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.hours(1))
      const token = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
      const store: ReconnectAuthStore = {
        load: () => Effect.succeed(JSON.stringify({ format: 1, players: { alice: nodeCrypto.hashHex(token) } })),
        save: () => Effect.void,
      }
      const auth = yield* createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.seconds(10) })

      expect(yield* auth.rotate('alice', token)).toBeDefined()
      yield* TestClock.adjust(Duration.seconds(10))
      expect(yield* auth.rotate('alice', token)).toBeUndefined()
    }),
  )

  // This catches v2 current or previous hashes being migrated with different or stale issue times.
  it.effect('starts both v2 hash TTLs when the file is loaded', () =>
    Effect.gen(function* () {
      yield* TestClock.adjust(Duration.hours(1))
      const currentToken = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
      const previousToken = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
      const source = JSON.stringify({
        format: 2,
        players: {
          alice: { current: nodeCrypto.hashHex(currentToken), previous: nodeCrypto.hashHex(previousToken) },
        },
      })
      const makeStore = (): ReconnectAuthStore => ({ load: () => Effect.succeed(source), save: () => Effect.void })
      const options = { tokenTtl: Duration.seconds(10) }
      const currentAuth = yield* createReconnectAuthEffect(nodeCrypto, makeStore(), options)
      const previousAuth = yield* createReconnectAuthEffect(nodeCrypto, makeStore(), options)
      const expiredAuth = yield* createReconnectAuthEffect(nodeCrypto, makeStore(), options)

      expect(yield* currentAuth.rotate('alice', currentToken)).toBeDefined()
      expect(yield* previousAuth.rotate('alice', previousToken)).toBeDefined()
      yield* TestClock.adjust(Duration.seconds(10))
      expect(yield* expiredAuth.resume(ReconnectTokenInput.make(previousToken))).toBeUndefined()
    }),
  )

  // This catches accepting a hash issued in the future after the system clock moves backwards.
  it.effect('rejects a token after the clock moves before its issue time', () =>
    Effect.gen(function* () {
      const auth = yield* createReconnectAuthEffect(nodeCrypto, inMemoryStore(), { tokenTtl: Duration.seconds(10) })
      const token = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.millis(-1))

      expect(yield* auth.rotate('alice', token)).toBeUndefined()
    }),
  )

  // This catches expiring a still-live previous hash when a rollback makes the newer current hash future-dated.
  it.effect('keeps a valid previous hash when pruning a future-dated current hash', () =>
    Effect.gen(function* () {
      const auth = yield* createReconnectAuthEffect(nodeCrypto, inMemoryStore(), { tokenTtl: Duration.seconds(10) })
      const previous = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.seconds(5))
      const futureCurrent = definedOrThrow(yield* auth.rotate('alice', previous))
      yield* TestClock.adjust(Duration.seconds(-4))
      expect(yield* auth.rotate('alice', futureCurrent)).toBeUndefined()

      expect(yield* auth.issue('bob')).toBeDefined()
      expect(yield* auth.rotate('alice', previous)).toBeDefined()
    }),
  )

  // This catches expired records lingering after another player's successful save and verifies has() stays membership-only.
  it.effect('rejects expired hashes and removes them on the next successful save', () =>
    Effect.gen(function* () {
      const store = inMemoryStore()
      const auth = yield* createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.seconds(10) })
      const token = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.seconds(10))

      expect(auth.has('alice')).toBe(true)
      expect(yield* auth.rotate('alice', token)).toBeUndefined()
      expect(yield* auth.resume(ReconnectTokenInput.make(token))).toBeUndefined()
      expect(yield* auth.issue('bob')).toBeDefined()
      expect(auth.has('alice')).toBe(false)
      expect(auth.has('bob')).toBe(true)
      const players = readPersistedPlayers(store.writes.at(-1))
      expect(Object.keys(players)).toEqual(['bob'])
    }),
  )

  // This catches an expired previous hash surviving serialization after another player's successful save.
  it.effect('removes an expired previous hash while retaining the current hash', () =>
    Effect.gen(function* () {
      const store = inMemoryStore()
      const auth = yield* createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.seconds(10) })
      const previous = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.seconds(9))
      const current = definedOrThrow(yield* auth.rotate('alice', previous))
      yield* TestClock.adjust(Duration.seconds(1))
      expect(yield* auth.rotate('alice', previous)).toBeUndefined()

      expect(yield* auth.issue('bob')).toBeDefined()
      const players = readPersistedPlayers(store.writes.at(-1))
      const aliceEntry = players['alice']
      if (!isRecord(aliceEntry)) {
        throw new Error('expected alice reconnect auth entry')
      }
      expect(Object.keys(aliceEntry)).toEqual(['current'])
      const currentHash = aliceEntry['current']
      if (!isRecord(currentHash)) {
        throw new Error('expected current reconnect token hash')
      }
      expect(typeof currentHash['issuedAt']).toBe('number')
      expect(current).toBeDefined()
    }),
  )

  // This catches cleanup changing in-memory state before its serialized save succeeds.
  it.effect('keeps expired records when the cleanup save fails', () =>
    Effect.gen(function* () {
      let allowSave = true
      const contents: { value: string | undefined } = { value: undefined }
      const store: ReconnectAuthStore = {
        load: () => Effect.sync(() => contents.value),
        save: (next) => {
          if (!allowSave) {
            return Effect.fail(new Error('disk full'))
          }
          contents.value = next
          return Effect.void
        },
      }
      const auth = yield* createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.seconds(10) })
      yield* auth.issue('alice')
      yield* TestClock.adjust(Duration.seconds(10))
      allowSave = false

      const failed = yield* Effect.exit(auth.issue('bob'))
      expect(failed._tag).toBe('Failure')
      expect(auth.has('alice')).toBe(true)
      expect(auth.has('bob')).toBe(false)
      expect(Object.keys(JSON.parse(contents.value ?? '{}').players)).toEqual(['alice'])

      allowSave = true
      yield* auth.issue('bob')
      expect(auth.has('alice')).toBe(false)
      expect(auth.has('bob')).toBe(true)
      expect(Object.keys(JSON.parse(contents.value ?? '{}').players)).toEqual(['bob'])
    }),
  )

  // This catches an accidentally short configured TTL by checking a token beyond the default reconnect window.
  it.effect('accepts a token within a configured long TTL', () =>
    Effect.gen(function* () {
      const auth = yield* createReconnectAuthEffect(nodeCrypto, inMemoryStore(), { tokenTtl: Duration.days(30) })
      const token = definedOrThrow(yield* auth.issue('alice'))

      yield* TestClock.adjust(Duration.hours(24))

      expect(yield* auth.rotate('alice', token)).toBeDefined()
    }),
  )

  // This catches a format 3 parser that accepts malformed issue times, hash objects, or file envelopes.
  it('rejects format 3 entries with invalid issue times or extra fields', async () => {
    const hash = nodeCrypto.hashHex('seed-token')
    const malformedFiles = [
      JSON.stringify({ format: 3, players: { alice: { current: { hash, issuedAt: 'yesterday' } } } }),
      JSON.stringify({ format: 3, players: { alice: { current: { hash, issuedAt: 0, extra: true } } } }),
      JSON.stringify({ format: 3, players: { alice: { current: { hash, issuedAt: 0 }, previous: 'not-a-hash' } } }),
      JSON.stringify([]),
      JSON.stringify({ format: 3, players: null }),
    ]

    await Promise.all(malformedFiles.map(async (source) => {
      const store: ReconnectAuthStore = { load: () => Effect.succeed(source), save: () => Effect.void }
      await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
    }))
  })

  // This catches changes that write format 3 but cannot read the new current-only or current-plus-previous shape.
  it('reloads format 3 files with current-only and current-plus-previous entries', async () => {
    const currentOnlyStore = inMemoryStore()
    const currentOnlyAuth = await createReconnectAuth(nodeCrypto, currentOnlyStore)
    const currentOnlyToken = definedOrThrow(await currentOnlyAuth.issue('alice'))
    const currentOnlyRestart = await createReconnectAuth(nodeCrypto, currentOnlyStore)
    expect(await currentOnlyRestart.rotate('alice', currentOnlyToken)).toBeDefined()

    const previousStore = inMemoryStore()
    const previousAuth = await createReconnectAuth(nodeCrypto, previousStore)
    const previousToken = definedOrThrow(await previousAuth.issue('alice'))
    await previousAuth.rotate('alice', previousToken)
    const previousRestart = await createReconnectAuth(nodeCrypto, previousStore)
    expect(await previousRestart.rotate('alice', previousToken)).toBeDefined()
  })

  // This catches TTL values that would make tokens immortal or immediately unusable without an explicit failure.
  it('rejects non-finite and non-positive token TTL values', async () => {
    const store = inMemoryStore()
    await expect(Effect.runPromise(createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.infinity }))).rejects.toThrow()
    await expect(Effect.runPromise(createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.millis(0) }))).rejects.toThrow()
    await expect(Effect.runPromise(createReconnectAuthEffect(nodeCrypto, store, { tokenTtl: Duration.millis(-1) }))).rejects.toThrow()
  })

  // SECOND VERIFICATION ANGLE (ordering/conflict, per the dispatch instruction):
  // two concurrent mutating calls for the SAME player must not interleave their
  // read-modify-write of the shared hash table. `mutate`'s queue is what this
  // proves — without it, both `issue` calls would race past the `has(player)`
  // guard and each mint a token that immediately overwrites the other's,
  // leaving the caller who got the first response holding a token the store no
  // longer accepts.
  it('two concurrent issue() calls for the same player serialize: exactly one succeeds', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const [first, second] = await Promise.all([auth.issue('alice'), auth.issue('alice')])
    const succeeded = [first, second].filter((token) => token !== undefined)
    expect(succeeded.length).toBe(1)
  })

  it('a rotate() concurrent with an issue() for a different player does not corrupt either player\'s entry', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    const aliceToken = await auth.issue('alice')
    const [rotated, bobIssued] = await Promise.all([
      auth.rotate('alice', definedOrThrow(aliceToken)),
      auth.issue('bob'),
    ])
    expect(rotated).toBeDefined()
    expect(bobIssued).toBeDefined()
    expect(await auth.rotate('alice', definedOrThrow(rotated))).toBeDefined()
    expect(await auth.rotate('bob', definedOrThrow(bobIssued))).toBeDefined()
  })
})
