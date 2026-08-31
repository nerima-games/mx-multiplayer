---
"@nerima-games/mx-multiplayer": minor
---

Add wire-protocol messages for brewing-stand interaction and status effects (`BrewingCommand` / `...Accepted` / `...Rejected` / `BrewingStandDelta` / `PlayerStatusEffectsDelta`), enchanting-table selection (`EnchantingCommand` / `...Accepted` / `...Rejected` / `PlayerEnchantmentsDelta`), the Ender Dragon encounter (`DamageEnderDragonCommand` / `...Accepted` / `...Rejected` / `EnderDragonSnapshotDelta`), and wither boss commands plus its runtime snapshot (`SummonWitherCommand` / `DamageWitherCommand` / `WitherCommandAccepted` / `WitherCommandRejected` / `WitherSnapshotDelta`), lowered from the composing app's hand-rolled per-domain codecs.

`BrewingStandState`, `StatusEffectState`, `EnchantedItem`, and the wither runtime shapes are declared independently here rather than imported from `@nerima-games/mx-gameplay` or `@nerima-games/mc-sim` — a wire format and a domain type have a different change budget, the same rule `protocol.ts` already applies to `Vec3` and `BlockPos` against `@nerima-games/mc-kernel`. `wither-runtime.ts`'s actual boss-fight rules are being lowered to `@nerima-games/mx-gameplay` separately; only the wire shape is here. `PROTOCOL_VERSION` is unchanged — adding new message tags does not require a bump (`docs/versioning.md` §7).
