---
"@nerima-games/mx-multiplayer": patch
---

Pin `@nerima-games/mc-kernel` 0.7.0 and `@nerima-games/mc-sim` 0.4.1. This repository imports only `StageId`, `GameModule`, and `StageRegistration` from kernel — none of which changed between 0.5.1 and 0.7.0 (`frame.ts`, `identifiers.ts`, `clock.ts` diff empty) — and never imports mc-sim at all: `protocol/wither.ts`'s and `protocol/enchanting.ts`'s mc-sim-shaped mirrors (`WitherPhase`, `WitherDamageKind`, `WitherSkullVariant`, `WITHER_MAX_HEALTH`, `WitherState`, `WitherSkullProjectileDescriptor`, `Durability`) are declared independently on purpose, so the wire format does not track the domain type. Checked mc-sim's actual `src/domain/wither.ts` and `src/domain/equipment.ts` at 0.4.1 against every mirrored shape here; nothing diverged, so no mirror changed and `PROTOCOL_VERSION` stays at 8. No source changes were required beyond the two pins.
