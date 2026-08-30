---
"@nerima-games/mx-multiplayer": minor
---

Repoint the frame-contract mirror (`StageId`, `DeltaTimeSecs`, `FrameServices`, `StageRegistration`, `GameModule`) to `@nerima-games/mc-kernel`, now that it is published. `FrameServices` widens from the mirror's `never` to kernel's `ClockPort`; neither stage this repository registers reads a clock (DN-3), so this is a type-level change only for stage authors, and a new runtime dependency on mc-kernel for stage builders.
