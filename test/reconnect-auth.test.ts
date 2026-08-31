import { describe, expect, it } from '@effect/vitest'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  RECONNECT_TOKEN_BYTES,
  createReconnectAuth,
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
  randomToken: () => randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url'),
  timingSafeEqualHex: (left, right) => {
    if (left.length !== right.length) {
      return false
    }
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
  },
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
    load: () => Promise.resolve(contents),
    save: (next) => {
      contents = next
      writes.push(next)
      return Promise.resolve()
    },
    writes,
  }
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

  it('reverts the in-memory hash on a persistence failure during issue', async () => {
    const store: ReconnectAuthStore = {
      load: () => Promise.resolve(undefined),
      save: () => Promise.reject(new Error('disk full')),
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    await expect(auth.issue('alice')).rejects.toThrow('disk full')
    expect(auth.has('alice')).toBe(false)
  })

  it('restores the previous hash on a persistence failure during rotate', async () => {
    let allowSave = true
    const contents: { value: string | undefined } = { value: undefined }
    const store: ReconnectAuthStore = {
      load: () => Promise.resolve(contents.value),
      save: (next) => {
        if (!allowSave) {
          return Promise.reject(new Error('disk full'))
        }
        contents.value = next
        return Promise.resolve()
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
      load: () => Promise.resolve(JSON.stringify({ format: 1, players: { alice: 'not-a-hash' } })),
      save: () => Promise.resolve(),
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('loads a legacy-format (v1) persisted file with a valid hash', async () => {
    const hash = nodeCrypto.hashHex('seed-token')
    const store: ReconnectAuthStore = {
      load: () => Promise.resolve(JSON.stringify({ format: 1, players: { alice: hash } })),
      save: () => Promise.resolve(),
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    expect(auth.has('alice')).toBe(true)
    expect(await auth.rotate('alice', 'seed-token'.padEnd(43, 'A'))).toBeUndefined()
  })

  it('rejects a current-format persisted file with an excess key', async () => {
    const store: ReconnectAuthStore = {
      load: () =>
        Promise.resolve(
          JSON.stringify({ format: 2, players: { alice: { current: nodeCrypto.hashHex('x'), extra: 'y' } } }),
        ),
      save: () => Promise.resolve(),
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('rejects a current-format persisted file whose current hash is malformed', async () => {
    const store: ReconnectAuthStore = {
      load: () => Promise.resolve(JSON.stringify({ format: 2, players: { alice: { current: 'not-a-hash' } } })),
      save: () => Promise.resolve(),
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('loads a current-format persisted file with a single current hash and no previous', async () => {
    const seedToken = randomBytes(RECONNECT_TOKEN_BYTES).toString('base64url')
    const store: ReconnectAuthStore = {
      load: () =>
        Promise.resolve(JSON.stringify({ format: 2, players: { alice: { current: nodeCrypto.hashHex(seedToken) } } })),
      save: () => Promise.resolve(),
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
        Promise.resolve(
          JSON.stringify({
            format: 2,
            players: {
              alice: { current: nodeCrypto.hashHex(currentToken), previous: nodeCrypto.hashHex(previousToken) },
            },
          }),
        ),
      save: () => Promise.resolve(),
    }
    const auth = await createReconnectAuth(nodeCrypto, store)
    // Both the current and the still-valid previous hash authenticate a rotate.
    expect(await auth.rotate('alice', previousToken)).toBeDefined()
  })

  it('rejects a current-format persisted file whose previous hash is malformed', async () => {
    const store: ReconnectAuthStore = {
      load: () =>
        Promise.resolve(
          JSON.stringify({ format: 2, players: { alice: { current: nodeCrypto.hashHex('x'), previous: 'not-a-hash' } } }),
        ),
      save: () => Promise.resolve(),
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('rejects a file that is not valid JSON', async () => {
    const store: ReconnectAuthStore = { load: () => Promise.resolve('not json'), save: () => Promise.resolve() }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('rejects a file with an unknown format number', async () => {
    const store: ReconnectAuthStore = {
      load: () => Promise.resolve(JSON.stringify({ format: 99, players: {} })),
      save: () => Promise.resolve(),
    }
    await expect(createReconnectAuth(nodeCrypto, store)).rejects.toThrow()
  })

  it('starts empty when the store has nothing persisted', async () => {
    const auth = await createReconnectAuth(nodeCrypto, inMemoryStore())
    expect(auth.has('alice')).toBe(false)
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
