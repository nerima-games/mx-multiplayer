---
"@nerima-games/mx-multiplayer": minor
---

Add `makeBrowserWebSocketTransport`, a `TransportPort` implementation over a real WebSocket, and `validateMultiplayerUrl` for checking a candidate multiplayer server URL against the loopback/secure-context rule. Both are lowered from the composing app, which previously carried this logic itself.
