/**
 * Server-side transport security: whether this process must run TLS, and
 * which browser origins its WebSocket endpoint accepts.
 *
 * Lowered from the composing app's `multiplayer-server/transport-security.ts`
 * verbatim in judgment, restructured for this repository's platform-free
 * build. Neither `AuthoritativeCommand` (`domain/protocol.ts`) nor
 * `SurvivalCommand` (`domain/survival-authority.ts`) appears anywhere in this
 * file — it decides nothing about which peer may do what to the world, only
 * whether a connection is allowed to exist at all. That keeps it outside the
 * two-authority-systems question entirely.
 *
 * ---------------------------------------------------------------------------
 * No `"DOM"` / Node lib here either
 * ---------------------------------------------------------------------------
 *
 * Same reasoning as `application/browser-transport.ts`'s file header: this
 * file needs a real `URL` for origin validation, but `src/application/`
 * compiles with `lib: ["ES2024"]` and `types: []`, so nothing here reads a
 * platform global. `UrlConstructor` is a required parameter — a server host
 * passes Node's real `URL` (which happens to satisfy this structural type
 * without a cast), a test passes a stand-in.
 */
import { Data, Result, Schema } from 'effect'

/** The `URL` members this file reads. A real `URL` instance satisfies this without a cast. */
export type TransportSecurityUrlLike = {
  readonly hash: string
  readonly origin: string
  readonly password: string
  readonly pathname: string
  readonly protocol: string
  readonly search: string
  readonly username: string
}
type UrlConstructorLike = new (input: string) => TransportSecurityUrlLike

export type TransportSecurityInput = {
  readonly allowedOrigins?: string
  readonly host: string
  readonly tlsCert?: string
  readonly tlsKey?: string
}

export type TransportSecurity =
  | { readonly allowedOrigins: ReadonlySet<string>; readonly secure: false }
  | { readonly allowedOrigins: ReadonlySet<string>; readonly secure: true; readonly tlsCert: string; readonly tlsKey: string }

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1'])
const BRACKET_LENGTH = 1
const EMPTY_SET_SIZE = 0

const unbracketed = (host: string): string => {
  if (host.startsWith('[') && host.endsWith(']')) {
    return host.slice(BRACKET_LENGTH, -BRACKET_LENGTH)
  }
  return host
}

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTNAMES.has(unbracketed(host))

/** A TransportSecurityError reason: which invariant an allowed-origins entry, or the set as a whole, violated. */
export const TransportSecurityErrorReason: Schema.Literals<
  readonly ['empty-origin', 'invalid-origin', 'missing-tls-cert', 'missing-tls-key', 'no-allowed-origins']
> = Schema.Literals(['empty-origin', 'invalid-origin', 'missing-tls-cert', 'missing-tls-key', 'no-allowed-origins'])
export type TransportSecurityErrorReason = typeof TransportSecurityErrorReason.Type

const TransportSecurityError_base: ReturnType<typeof Data.TaggedError<'TransportSecurityError'>> =
  Data.TaggedError('TransportSecurityError')

export class TransportSecurityError extends TransportSecurityError_base<{
  readonly reason: TransportSecurityErrorReason
  readonly detail: string
}> {}

const securityFailure = (
  reason: TransportSecurityErrorReason,
  detail: string,
): Result.Result<never, TransportSecurityError> => Result.fail(new TransportSecurityError({ detail, reason }))

const isValidOriginUrl = (origin: string, parsed: TransportSecurityUrlLike): boolean =>
  parsed.protocol === 'https:'
  && parsed.username === ''
  && parsed.password === ''
  && parsed.pathname === '/'
  && parsed.search === ''
  && parsed.hash === ''
  && origin === parsed.origin

const parseOriginUrl = (origin: string, UrlConstructor: UrlConstructorLike): Result.Result<TransportSecurityUrlLike, TransportSecurityError> =>
  Result.try({
    catch: (cause) => new TransportSecurityError({ detail: `${origin} (${String(cause)})`, reason: 'invalid-origin' }),
    try: () => new UrlConstructor(origin),
  })

const validateOrigin = (origin: string, UrlConstructor: UrlConstructorLike): Result.Result<void, TransportSecurityError> => {
  if (origin === '') {
    return securityFailure('empty-origin', 'an allowed origin was blank')
  }
  if (origin === 'null' || origin.includes('*')) {
    return securityFailure('invalid-origin', origin)
  }
  const parsed = parseOriginUrl(origin, UrlConstructor)
  if (Result.isFailure(parsed)) {
    return Result.fail(parsed.failure)
  }
  if (!isValidOriginUrl(origin, parsed.success)) {
    return securityFailure('invalid-origin', origin)
  }
  return Result.succeed(undefined)
}

const parseAllowedOrigins = (
  value: string | undefined,
  UrlConstructor: UrlConstructorLike,
): Result.Result<ReadonlySet<string>, TransportSecurityError> => {
  if (value === undefined) {
    return Result.succeed(new Set())
  }
  const origins = value.split(',').map((origin) => origin.trim())
  for (const origin of origins) {
    const validated = validateOrigin(origin, UrlConstructor)
    if (Result.isFailure(validated)) {
      return Result.fail(validated.failure)
    }
  }
  return Result.succeed(new Set(origins))
}

const resolveInsecureTransport = (): TransportSecurity => ({ allowedOrigins: new Set(), secure: false })

const resolveSecureTransport = (
  input: TransportSecurityInput,
  UrlConstructor: UrlConstructorLike,
): Result.Result<TransportSecurity, TransportSecurityError> => {
  if (input.tlsCert === undefined || input.tlsCert === '') {
    return securityFailure('missing-tls-cert', 'tls-cert is required for secure multiplayer transport')
  }
  if (input.tlsKey === undefined || input.tlsKey === '') {
    return securityFailure('missing-tls-key', 'tls-key is required for secure multiplayer transport')
  }
  const allowedOrigins = parseAllowedOrigins(input.allowedOrigins, UrlConstructor)
  if (Result.isFailure(allowedOrigins)) {
    return Result.fail(allowedOrigins.failure)
  }
  if (allowedOrigins.success.size === EMPTY_SET_SIZE) {
    return securityFailure('no-allowed-origins', 'allowed-origins must contain at least one HTTPS origin')
  }
  return Result.succeed({
    allowedOrigins: allowedOrigins.success,
    secure: true,
    tlsCert: input.tlsCert,
    tlsKey: input.tlsKey,
  })
}

const requiresSecureTransport = (input: TransportSecurityInput): boolean => {
  const explicitlyConfigured = input.tlsCert !== undefined || input.tlsKey !== undefined || input.allowedOrigins !== undefined
  return !isLoopbackHost(input.host) || explicitlyConfigured
}

/**
 * Whether this server must speak TLS, and if so, its certificate material and
 * the browser origins it accepts. A loopback host with no TLS/origin option
 * set at all stays plaintext (`secure: false`) — anything else is treated as
 * a real deployment and validated strictly, so a config typo fails at
 * startup rather than silently serving an unencrypted socket to the network.
 */
export const resolveTransportSecurity = (
  input: TransportSecurityInput,
  UrlConstructor: UrlConstructorLike,
): Result.Result<TransportSecurity, TransportSecurityError> => {
  if (!requiresSecureTransport(input)) {
    return Result.succeed(resolveInsecureTransport())
  }
  return resolveSecureTransport(input, UrlConstructor)
}

export const isAllowedWebSocketOrigin = (origin: string | undefined, security: TransportSecurity): boolean => {
  if (!security.secure) {
    return true
  }
  return origin !== undefined && security.allowedOrigins.has(origin)
}
