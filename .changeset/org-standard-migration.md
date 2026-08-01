---
"@nerima-games/mx-multiplayer": patch
---

Migrate onto the nerima-games org standard: restructure shipped source under
`src/`, drop the `api-lock`/`check-dependency-whitelist` tooling in favour of
`oxlint`'s `no-restricted-imports`, declare `@nerima-games/mc-sim` as an actual
`dependency` (previously undeclared drift versus `docs/architecture.md`), pin
GitHub Actions to commit SHAs, add Dependabot, and enable the 4-metric 99%
coverage gate.
