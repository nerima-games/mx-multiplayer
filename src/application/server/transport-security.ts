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
import { Schema } from 'effect'

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
export const TransportSecurityErrorReason: Schema.Literal<
  ['empty-origin', 'invalid-origin', 'missing-tls-cert', 'missing-tls-key', 'no-allowed-origins']
> = Schema.Literal('empty-origin', 'invalid-origin', 'missing-tls-cert', 'missing-tls-key', 'no-allowed-origins')
export type TransportSecurityErrorReason = typeof TransportSecurityErrorReason.Type

export class TransportSecurityError extends Error {
  readonly reason: TransportSecurityErrorReason
  readonly detail: string

  constructor(reason: TransportSecurityErrorReason, detail: string) {
    super(`invalid transport security configuration (${reason}): ${detail}`)
    this.reason = reason
    this.detail = detail
  }
}

const isValidOriginUrl = (origin: string, parsed: TransportSecurityUrlLike): boolean =>
  parsed.protocol === 'https:'
  && parsed.username === ''
  && parsed.password === ''
  && parsed.pathname === '/'
  && parsed.search === ''
  && parsed.hash === ''
  && origin === parsed.origin

const parseOriginUrl = (origin: string, UrlConstructor: UrlConstructorLike): TransportSecurityUrlLike => {
  try {
    return new UrlConstructor(origin)
  } catch (cause) {
    throw new TransportSecurityError('invalid-origin', `${origin} (${String(cause)})`)
  }
}

const validateOrigin = (origin: string, UrlConstructor: UrlConstructorLike): void => {
  if (origin === '') {
    throw new TransportSecurityError('empty-origin', 'an allowed origin was blank')
  }
  if (origin === 'null' || origin.includes('*')) {
    throw new TransportSecurityError('invalid-origin', origin)
  }
  const parsed = parseOriginUrl(origin, UrlConstructor)
  if (!isValidOriginUrl(origin, parsed)) {
    throw new TransportSecurityError('invalid-origin', origin)
  }
}

const parseAllowedOrigins = (value: string | undefined, UrlConstructor: UrlConstructorLike): ReadonlySet<string> => {
  if (value === undefined) {
    return new Set()
  }
  const origins = value.split(',').map((origin) => origin.trim())
  for (const origin of origins) {
    validateOrigin(origin, UrlConstructor)
  }
  return new Set(origins)
}

const resolveInsecureTransport = (): TransportSecurity => ({ allowedOrigins: new Set(), secure: false })

const resolveSecureTransport = (
  input: TransportSecurityInput,
  UrlConstructor: UrlConstructorLike,
): TransportSecurity => {
  if (input.tlsCert === undefined || input.tlsCert === '') {
    throw new TransportSecurityError('missing-tls-cert', 'tls-cert is required for secure multiplayer transport')
  }
  if (input.tlsKey === undefined || input.tlsKey === '') {
    throw new TransportSecurityError('missing-tls-key', 'tls-key is required for secure multiplayer transport')
  }
  const allowedOrigins = parseAllowedOrigins(input.allowedOrigins, UrlConstructor)
  if (allowedOrigins.size === EMPTY_SET_SIZE) {
    throw new TransportSecurityError('no-allowed-origins', 'allowed-origins must contain at least one HTTPS origin')
  }
  return { allowedOrigins, secure: true, tlsCert: input.tlsCert, tlsKey: input.tlsKey }
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
): TransportSecurity => {
  if (!requiresSecureTransport(input)) {
    return resolveInsecureTransport()
  }
  return resolveSecureTransport(input, UrlConstructor)
}

export const isAllowedWebSocketOrigin = (origin: string | undefined, security: TransportSecurity): boolean => {
  if (!security.secure) {
    return true
  }
  return origin !== undefined && security.allowedOrigins.has(origin)
}
