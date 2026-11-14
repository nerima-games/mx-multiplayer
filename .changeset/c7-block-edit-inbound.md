---
'@nerima-games/mx-multiplayer': minor
---

Route `BlockPlace` and `BlockBreak` through the server adapter to `applyAcceptedInbound` after checking the sender and world. These messages previously returned `unsupported-message`. A missing world is rejected rather than inferred from the connection.

Add `BlockPlaceReceived` and `BlockBreakReceived` to `ServerInboundOutcome` and `ServerAcceptedInboundOutcome`. Hosts with exhaustive switches must handle the new variants. Export the `MultiplayerWorldWriter` type alias for `WorldWritePort['Service']`. The wire schema and `PROTOCOL_VERSION` remain at version 11.

Pin `@nerima-games/mc-sim` to `0.11.1`, which includes mc-worldgen `0.9.1`. This also records the dependency alignment omitted from the `0.16.0` changelog: mc-kernel `0.17.0` and mc-sim `0.11.0`.
