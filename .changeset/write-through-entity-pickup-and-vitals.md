---
"@nerima-games/mx-multiplayer": minor
---

Add `applyAuthoritativeCommand`, the first code in this package that writes an accepted `AuthoritativeCommand` through to `@nerima-games/mc-sim`. Before this change, `AuthoritativeSession` admitted commands to its ordering/idempotency ledger but nothing in this package ever touched mc-sim — a declared runtime dependency this package had never imported.

Two of the twenty `AuthoritativeCommand` tags are wired: `EntityPickupCommand` writes through `EntityManagerApi.find`/`despawn` (the atomic `Ref.modify` on `despawn` is the arbitration primitive for two peers racing the same pickup — this package calls it rather than deciding who wins), and `PlayerVitalsCommand`'s `respawn`/`activity` actions write through a host-supplied per-player `VitalsServiceApi` lookup. Every other tag, including `PlayerVitalsCommand`'s `eat` action, returns `CommandNotWritable` with a documented reason rather than reaching into a rules module — most have no mc-sim application service at all, `PlayerInventoryCommand` and `VehicleCommand`/`VehicleUseCommand` have one shaped for a single instance where multiplayer needs a per-player/per-vehicle registry this change does not build, and `EntityAttackCommand` needs a host-supplied entity-behaviour step function `EntityManagerApi.sweep` requires and this package does not have.

A world write only happens on a freshly accepted decision, never on a cached replay of an already-seen `commandId` — `AuthoritativeSession#execute` skips its `decide` callback on replay, and gating the mc-sim write on that same signal (rather than on the result tag) is what keeps `VitalsService.addExhaustion`, which adds rather than sets, from double-charging a retransmitted frame.

`SurvivalAuthority`/`SurvivalCommand` (`domain/survival-authority.ts`) is a separate, complete, in-memory authority system that is not reachable from `stages/registration.ts`'s inbound/outbound pipeline and does not write through mc-sim either. This change does not touch it — reconciling the two authority systems is a pre-existing, parked architectural question, not something closing this seam required.
