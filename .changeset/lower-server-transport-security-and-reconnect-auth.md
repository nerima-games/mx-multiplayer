---
"@nerima-games/mx-multiplayer": minor
---

Add server-side transport security resolution (`resolveTransportSecurity`, `isAllowedWebSocketOrigin`, `isLoopbackHost`, `TransportSecurityError`), reconnect-token issuance and rotation (`createReconnectAuth`, injected against `ReconnectAuthCrypto` / `ReconnectAuthStore` Ports), and a frame-tag peek utility (`frameTag`, `unknownRecord`), lowered from the composing app's `multiplayer-server/{transport-security,reconnect-auth,wire-frame-validation}.ts`. None of these three files touch `AuthoritativeCommand` or `SurvivalCommand` — they authenticate and gate a connection before either command union is ever consulted. `multiplayer-server/core.ts`'s per-tag wire-length map is not ported: it depended on the now-removed hand-rolled per-domain codecs, which the `NetworkMessage` Schema union has already superseded.
