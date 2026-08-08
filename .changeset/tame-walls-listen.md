---
"@nerima-games/mx-multiplayer": patch
---

Fix CI: scope oxlint's pedantic/style rules to match this repository's Effect-TS idiom and the org's test/scripts/apps relaxation policy (`new-cap`, `func-names` and `no-undefined` no longer fight `Schema.Struct`/`Effect.gen`/`Map#get` patterns; `no-underscore-dangle` and `id-length` gained targeted exceptions for `_tag` and 3D coordinate fields), apply the remaining real fixes in `src/` (named constants, sorted keys/imports, `if`/`else` in place of ternaries, extracted helpers to clear `max-statements`), and close the coverage gate's gap in `connection.ts`, `snapshot-interpolation.ts`, `transport.ts`, `authoritative-session.ts`, `hunger-authority.ts` and `survival-authority.ts` with behavioral tests (plus documented `v8 ignore` on the small number of branches proven unreachable). No public API changes.
