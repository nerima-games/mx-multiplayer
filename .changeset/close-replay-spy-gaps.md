---
"@nerima-games/mx-multiplayer": patch
---

Close two replay-guard gaps in `command-application.ts`'s test suite: neither `EntityPickupCommand`'s despawn nor `PlayerVitalsCommand`'s `respawn` action had a test proving the write-through happens exactly once when the same command id is replayed.

Both appliers already gate their mc-sim write on the `decided` flag set inside the `decide` closure, not on the result tag alone, matching every other applier in this file. But the existing tests for these two paths asserted post-state (`entities.count`, or vitals after two *different* command ids) rather than a call count — and both operations are naturally idempotent from the state's perspective (despawning an already-gone entity is a no-op `Ref.modify`; a second respawn leaves health at the same maximum). That made the state-based assertions blind to whether the write actually ran twice on a replay. Hand mutation-testing confirmed the gap directly: removing the `decided` gate from either applier left the full suite green.

Both paths now have a call-count spy test — wrapping `despawn`/`respawn` to record invocations — asserting exactly one call across two executions of the same command id, the same pattern the `swap-items`/`equip-item`/`unequip-item`/`select-slot`/`mount`/`dismount` replay tests already use. No production code changed.
