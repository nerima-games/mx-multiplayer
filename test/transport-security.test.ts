import { describe, expect, it } from '@effect/vitest'
import {
  TransportSecurityError,
  isAllowedWebSocketOrigin,
  isLoopbackHost,
  resolveTransportSecurity,
  type TransportSecurityErrorReason,
  type TransportSecurityUrlLike,
} from '../src/application/server/transport-security'

const rejectionReason = (attempt: () => void): TransportSecurityErrorReason => {
  try {
    attempt()
  } catch (error) {
    if (error instanceof TransportSecurityError) {
      return error.reason
    }
    throw error
  }
  throw new Error('expected resolveTransportSecurity to throw')
}

/** A minimal, real `TransportSecurityUrlLike`. Throws on anything that is not `scheme://host[/]`. */
class FakeUrl implements TransportSecurityUrlLike {
  readonly hash = ''
  readonly origin: string
  readonly password = ''
  readonly protocol: string
  readonly search = ''
  readonly username = ''
  readonly pathname: string

  constructor(input: string) {
    const match = /^(?<protocol>[a-z]+:)\/\/(?<host>[^/]+)(?<pathname>\/.*)?$/u.exec(input)
    const protocol = match?.groups?.['protocol']
    const host = match?.groups?.['host']
    if (protocol === undefined || host === undefined) {
      throw new Error(`invalid url: ${input}`)
    }
    this.protocol = protocol
    this.origin = `${protocol}//${host}`
    const pathname = match?.groups?.['pathname']
    if (pathname === undefined || pathname === '') {
      this.pathname = '/'
    } else {
      this.pathname = pathname
    }
  }
}

/**
 * A URL-like whose `.origin` naively echoes the raw input rather than
 * stripping userinfo/path/search/hash the way a spec-compliant `URL` does —
 * standing in for a `UrlConstructorLike` implementation that gets origin
 * normalization wrong. `resolveTransportSecurity` takes its URL constructor
 * as an injected parameter (`FakeUrl` above is one such stand-in), so
 * `isValidOriginUrl`'s explicit per-field checks are the only defense
 * against exactly this: with `.origin` always matching the input verbatim,
 * the `origin === parsed.origin` check alone would let every one of these
 * through. Delegates parsing to the real global `URL` so each field is
 * genuinely populated, unlike `FakeUrl`, which never sets username/
 * password/search/hash from its input at all.
 */
class NonConformingUrl implements TransportSecurityUrlLike {
  readonly hash: string
  readonly origin: string
  readonly password: string
  readonly pathname: string
  readonly protocol: string
  readonly search: string
  readonly username: string

  constructor(input: string) {
    const real = new URL(input)
    this.hash = real.hash
    this.origin = input
    this.password = real.password
    this.pathname = real.pathname
    this.protocol = real.protocol
    this.search = real.search
    this.username = real.username
  }
}

describe('isLoopbackHost', () => {
  it('accepts localhost, IPv4 loopback, and bracketed IPv6 loopback', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
  })

  it('rejects a non-loopback host', () => {
    expect(isLoopbackHost('example.com')).toBe(false)
  })
})

describe('resolveTransportSecurity', () => {
  it('stays plaintext for an unconfigured loopback host', () => {
    const result = resolveTransportSecurity({ host: 'localhost' }, FakeUrl)
    expect(result).toStrictEqual({ allowedOrigins: new Set(), secure: false })
  })

  it('requires TLS for a non-loopback host even with nothing else configured', () => {
    expect(() => resolveTransportSecurity({ host: 'example.com' }, FakeUrl)).toThrow(TransportSecurityError)
  })

  it('requires TLS for a loopback host once any secure option is set', () => {
    expect(() =>
      resolveTransportSecurity({ allowedOrigins: 'https://example.com', host: 'localhost' }, FakeUrl),
    ).toThrow(TransportSecurityError)
  })

  it('rejects a missing tls-cert', () => {
    const exit = (): void => {
      resolveTransportSecurity(
        { allowedOrigins: 'https://example.com', host: 'example.com', tlsKey: 'key' },
        FakeUrl,
      )
    }
    expect(exit).toThrow(TransportSecurityError)
    expect(rejectionReason(exit)).toBe('missing-tls-cert')
  })

  it('rejects a missing tls-key', () => {
    const exit = (): void => {
      resolveTransportSecurity(
        { allowedOrigins: 'https://example.com', host: 'example.com', tlsCert: 'cert' },
        FakeUrl,
      )
    }
    expect(exit).toThrow(TransportSecurityError)
    expect(rejectionReason(exit)).toBe('missing-tls-key')
  })

  it('rejects a config with TLS material but no allowed origins', () => {
    const exit = (): void => {
      resolveTransportSecurity({ host: 'example.com', tlsCert: 'cert', tlsKey: 'key' }, FakeUrl)
    }
    expect(exit).toThrow(TransportSecurityError)
    expect(rejectionReason(exit)).toBe('no-allowed-origins')
  })

  it('rejects a blank origin in the allowed-origins list', () => {
    const exit = (): void => {
      resolveTransportSecurity(
        { allowedOrigins: 'https://example.com,', host: 'example.com', tlsCert: 'cert', tlsKey: 'key' },
        FakeUrl,
      )
    }
    expect(exit).toThrow(TransportSecurityError)
    expect(rejectionReason(exit)).toBe('empty-origin')
  })

  it('rejects the literal origin "null" and a wildcard origin', () => {
    for (const origin of ['null', 'https://*.example.com']) {
      expect(() =>
        resolveTransportSecurity({ allowedOrigins: origin, host: 'example.com', tlsCert: 'cert', tlsKey: 'key' }, FakeUrl),
      ).toThrow(TransportSecurityError)
    }
  })

  it('rejects a non-HTTPS scheme in the allowed-origins list', () => {
    for (const origin of ['http://example.com', 'ws://example.com']) {
      const exit = (): void => {
        resolveTransportSecurity({ allowedOrigins: origin, host: 'example.com', tlsCert: 'cert', tlsKey: 'key' }, FakeUrl)
      }
      expect(exit, origin).toThrow(TransportSecurityError)
      expect(rejectionReason(exit), origin).toBe('invalid-origin')
    }
  })

  it('rejects an origin the URL constructor cannot parse', () => {
    expect(() =>
      resolveTransportSecurity(
        { allowedOrigins: 'not a url', host: 'example.com', tlsCert: 'cert', tlsKey: 'key' },
        FakeUrl,
      ),
    ).toThrow(TransportSecurityError)
  })

  it('rejects an origin with a non-root pathname', () => {
    expect(() =>
      resolveTransportSecurity(
        { allowedOrigins: 'https://example.com/path', host: 'example.com', tlsCert: 'cert', tlsKey: 'key' },
        FakeUrl,
      ),
    ).toThrow(TransportSecurityError)
  })

  it('rejects userinfo, a non-root path, a query string, and a fragment even when the URL-like implementation echoes the raw input as its origin', () => {
    // FakeUrl can never populate username/password/search/hash from its input — every
    // field defaults to '' regardless — so it cannot exercise these four checks at all.
    // NonConformingUrl parses them for real, but reports an unnormalized `.origin`, so
    // only the explicit per-field checks (not origin-equality) can catch these.
    for (const origin of [
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com?q=1',
      'https://example.com#frag',
    ]) {
      const exit = (): void => {
        resolveTransportSecurity({ allowedOrigins: origin, host: 'example.com', tlsCert: 'cert', tlsKey: 'key' }, NonConformingUrl)
      }
      expect(exit, origin).toThrow(TransportSecurityError)
      expect(rejectionReason(exit), origin).toBe('invalid-origin')
    }
  })

  it('accepts a fully configured secure transport with multiple allowed origins', () => {
    const result = resolveTransportSecurity(
      {
        allowedOrigins: 'https://example.com, https://other.example.com',
        host: 'example.com',
        tlsCert: 'cert',
        tlsKey: 'key',
      },
      FakeUrl,
    )
    expect(result).toStrictEqual({
      allowedOrigins: new Set(['https://example.com', 'https://other.example.com']),
      secure: true,
      tlsCert: 'cert',
      tlsKey: 'key',
    })
  })
})

describe('isAllowedWebSocketOrigin', () => {
  it('allows any origin, including undefined, when the transport is not secure', () => {
    const insecure = resolveTransportSecurity({ host: 'localhost' }, FakeUrl)
    expect(isAllowedWebSocketOrigin(undefined, insecure)).toBe(true)
    expect(isAllowedWebSocketOrigin('https://anything.example.com', insecure)).toBe(true)
  })

  it('rejects an unlisted or missing origin when the transport is secure', () => {
    const secure = resolveTransportSecurity(
      { allowedOrigins: 'https://example.com', host: 'example.com', tlsCert: 'cert', tlsKey: 'key' },
      FakeUrl,
    )
    expect(isAllowedWebSocketOrigin(undefined, secure)).toBe(false)
    expect(isAllowedWebSocketOrigin('https://not-listed.example.com', secure)).toBe(false)
    expect(isAllowedWebSocketOrigin('https://example.com', secure)).toBe(true)
  })
})
