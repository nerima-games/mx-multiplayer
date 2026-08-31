---
"@nerima-games/mx-multiplayer": minor
---

Add wire-protocol messages for anvil renaming (`AnvilCommand` / `AnvilCommandAccepted` / `AnvilCommandRejected` / `PlayerAnvilNamesDelta`), crafting-grid submission (`CraftingCommand` / `CraftingCommandAccepted` / `CraftingCommandRejected`), and player-damage confirmation (`PlayerDamageCommand` / `PlayerDamageCommandAccepted` / `PlayerDamageCommandRejected`), lowered from the composing app's hand-rolled per-domain codecs. All three now flow through the shared `NetworkMessage` union and `codec.ts`, replacing bespoke JSON parsers with `Schema`-validated decoding. `PROTOCOL_VERSION` is unchanged — adding new message tags does not require a bump (`docs/versioning.md` §7).
