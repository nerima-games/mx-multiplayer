import type { MatrixCell, MatrixRow, TestReference } from './index.js'

const reference = (file: `test/${string}`, line: number, testName: string): TestReference => ({ file, line, testName })

const messageRoundTrip = reference(
  'test/codec.test.ts',
  1241,
  'every message decodes back to a value strictly equal to the one encoded',
)
const covered = (...tests: [TestReference, ...TestReference[]]): MatrixCell => ({ status: 'covered', tests })
const excluded = (reason: string): MatrixCell => ({ status: 'excluded', reason })
const gap = (reason: string, ...evidence: string[]): MatrixCell => ({ status: 'gap', reason, evidence })
const a1 = (...malformedTests: TestReference[]): MatrixCell => {
  const tests: [TestReference, ...TestReference[]] = [messageRoundTrip]
  tests.push(...malformedTests)
  return { status: 'covered', tests }
}
const legacyWireCompatibility = covered(reference(
  'test/wire-fixtures.test.ts',
  124,
  'rejects old golden bytes and checks the protocol-11 envelope for each representative family',
))
const noLegacyWireFixture = excluded(
  'X2 freezes representative legacy frames by family, but this tag has no tag-specific v0.11.0 or v0.12.0 frame fixture (test/wire-fixtures.test.ts:124).',
)

const a2NotCommand = excluded('This tag is a state, result, lifecycle, or transport value; it is not a gameplay command to apply or reject with CommandUnsupported.')
const a3NotState = excluded('This tag reports text, metadata, a decision, or transport state; it does not change the shared authoritative world snapshot or post-delta state.')
const a5NotLifecycle = excluded('This tag does not establish a join, reconnect snapshot, or player-leave cleanup state.')
const a6NotSpatial = excluded('This tag has no AOI-scoped world element or recipient-specific world update to filter.')
const a7NotClientOperation = excluded('This is an authoritative state/result or transport value, not a client operation whose claimed identity or command authorization is checked by the server.')

const a3Convergence = reference(
  'test/scenarios/authority.test.ts',
  108,
  'transfers a snapshot and compares both clients after applying the same delta',
)
const a4RevisionGap = reference(
  'test/scenarios/authority.test.ts',
  91,
  'rejects a revision gap and preserves the prior client projection',
)
const a4StageResync = reference(
  'test/stage-registration.test.ts',
  431,
  'a C4 revision gap preserves the last applied view and queues a resync request',
)
const a4ChunkOrder = reference(
  'test/authoritative-sync.test.ts',
  1016,
  'rejects chunks that arrive out of order',
)
const a4TransferOrder = reference(
  'test/authoritative-sync.test.ts',
  694,
  'rejects invalid limits and frames outside an active transfer',
)
const a5WorldSnapshot = reference(
  'test/scenarios/world-sync.test.ts',
  20,
  'requires a decoded WorldSnapshot before applying updates after disconnect',
)
const a5AuthoritativeSnapshot = reference(
  'test/authoritative-session.test.ts',
  264,
  'requires a WCC revision and a restored snapshot after connection and disconnect',
)
const a6Delta = reference(
  'test/scenarios/visibility-load.test.ts',
  75,
  'delivers each owner-aware C4 delta with only the recipient AOI projection',
)

const row = (
  a1Cell: MatrixCell,
  a2Cell: MatrixCell,
  a3Cell: MatrixCell,
  a4Cell: MatrixCell,
  a5Cell: MatrixCell,
  a6Cell: MatrixCell,
  a7Cell: MatrixCell,
  a8Cell: MatrixCell = noLegacyWireFixture,
): MatrixRow => ({
  A1: a1Cell,
  A2: a2Cell,
  A3: a3Cell,
  A4: a4Cell,
  A5: a5Cell,
  A6: a6Cell,
  A7: a7Cell,
  A8: a8Cell,
})

export const worldSync: Record<
  | 'PlayerJoin'
  | 'PlayerLeave'
  | 'PlayerMove'
  | 'BlockPlace'
  | 'BlockBreak'
  | 'Chat'
  | 'WorldInfo'
  | 'WorldSnapshot'
  | 'BlockMutationRejected'
  | 'AuthoritativeSnapshot'
  | 'RealmTransferSnapshot'
  | 'AuthoritativeCommandAccepted'
  | 'AuthoritativeCommandRejected'
  | 'AuthoritativeResyncRequest'
  | 'Ping'
  | 'Pong'
  | 'ReplicatedWorldDelta'
  | 'ReplicatedWorldSnapshot'
  | 'ReplicatedWorldSnapshotStart'
  | 'ReplicatedWorldSnapshotChunk'
  | 'ReplicatedWorldSnapshotEnd',
  MatrixRow
> = {
  PlayerJoin: row(
    a1(),
    a2NotCommand,
    gap(
      'Join changes the shared player view, but the inbound host seam has no multi-client projection comparison for this tag.',
      'src/domain/protocol.ts:151-157',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Join ordering and loss can change the visible player set, but no world-sync receiver applies this lifecycle event.',
      'src/domain/protocol.ts:151-157',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'A join establishes player state, but no local client/session route consumes PlayerJoin to initialize that state.',
      'src/domain/protocol.ts:151-157',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'PlayerJoin carries a location that must be scoped to each recipient, but the inbound host seam has no AOI projection for it.',
      'src/domain/protocol.ts:151-157',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'The tag carries a client-claimable player identity and location, but no server path binds them to the authenticated connection.',
      'src/domain/protocol.ts:151-157',
      'src/domain/protocol.ts:1109-1154',
      'src/stages/registration.ts:450-452',
    ),
  ),
  PlayerLeave: row(
    a1(reference(
      'test/codec.test.ts',
      2694,
      'rejects an empty player id, so an unidentified peer cannot be addressed',
    )),
    a2NotCommand,
    gap(
      'Leave changes the shared player view, but no multi-client projection test applies this lifecycle tag.',
      'src/domain/protocol.ts:159-165',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Lost, duplicated, or reordered leave events can retain or remove the wrong player, but the host seam has no lifecycle consumer.',
      'src/domain/protocol.ts:159-165',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Leave must clean up the departing player, but this library has no PlayerLeave consumer that performs that cleanup.',
      'src/domain/protocol.ts:159-165',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'A leave event removes a player from recipient-visible state, but no AOI-aware lifecycle projection handles it.',
      'src/domain/protocol.ts:159-165',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'The message names a player that a client could claim to remove, but no server path binds the ID to the authenticated connection.',
      'src/domain/protocol.ts:159-165',
      'src/domain/protocol.ts:1109-1154',
      'src/stages/registration.ts:450-452',
    ),
  ),
  PlayerMove: row(
    a1(
      reference(
        'test/codec.test.ts',
        2581,
        'rejects a coordinate that arrived as null, which is what a NaN turns into over JSON',
      ),
      reference('test/codec.test.ts', 2679, 'rejects a pitch outside the range a head can actually turn'),
    ),
    gap(
      'Movement carries a client-claimed player and position, but no server path applies it through authoritative command handling or rejects it there.',
      'src/domain/protocol.ts:167-177',
      'src/domain/protocol.ts:1109-1154',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Movement changes shared player state, but no multi-client projection test applies PlayerMove and compares the resulting views.',
      'src/domain/protocol.ts:167-177',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Movement updates can be lost, duplicated, reordered, or delayed, but no receiver applies this tag with ordering rules.',
      'src/domain/protocol.ts:167-177',
      'src/stages/registration.ts:450-452',
    ),
    a5NotLifecycle,
    gap(
      'Movement carries a position that must be filtered per recipient, but only replicated deltas have an AOI projection path.',
      'src/domain/protocol.ts:167-177',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'A client can claim another player ID or tamper with position, but no server route binds PlayerMove to the authenticated identity.',
      'src/domain/protocol.ts:167-177',
      'src/domain/protocol.ts:1109-1154',
      'src/stages/registration.ts:450-452',
    ),
    legacyWireCompatibility,
  ),
  BlockPlace: row(
    a1(),
    covered(reference('test/server-adapter.test.ts', 1468, 'delivers authenticated block edits to the host once and distributes their delta')),
    gap(
      'Placement changes shared block state, but no multi-client projection test applies BlockPlace and compares the resulting views.',
      'src/domain/protocol.ts:179-203',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Placement updates can be lost, duplicated, reordered, or delayed, but no receiver applies this tag with ordering rules.',
      'src/domain/protocol.ts:179-203',
      'src/stages/registration.ts:450-452',
    ),
    a5NotLifecycle,
    gap(
      'Placement has a world position that must be filtered for recipients, but only replicated deltas have an AOI projection path.',
      'src/domain/protocol.ts:179-203',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    covered(reference('test/server-adapter.test.ts', 1577, 'property-checks block edit sender and world authentication before host application')),
  ),
  BlockBreak: row(
    a1(reference('test/codec.test.ts', 2591, 'rejects a non-integral block coordinate')),
    covered(reference('test/server-adapter.test.ts', 1468, 'delivers authenticated block edits to the host once and distributes their delta')),
    gap(
      'Breaking changes shared block state, but no multi-client projection test applies BlockBreak and compares the resulting views.',
      'src/domain/protocol.ts:205-214',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Break updates can be lost, duplicated, reordered, or delayed, but no receiver applies this tag with ordering rules.',
      'src/domain/protocol.ts:205-214',
      'src/stages/registration.ts:450-452',
    ),
    a5NotLifecycle,
    gap(
      'Breaking has a world position that must be filtered for recipients, but only replicated deltas have an AOI projection path.',
      'src/domain/protocol.ts:205-214',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    covered(reference('test/server-adapter.test.ts', 1577, 'property-checks block edit sender and world authentication before host application')),
  ),
  Chat: row(
    a1(),
    excluded('Chat carries text and a sender label; it is not a world-state command whose application yields CommandUnsupported.'),
    a3NotState,
    gap(
      'Chat ordering and loss change the message sequence seen by peers, but this library has no chat delivery consumer or sequence handling.',
      'src/domain/protocol.ts:219-223',
      'src/stages/registration.ts:450-452',
    ),
    a5NotLifecycle,
    a6NotSpatial,
    gap(
      'Chat carries a client-claimable player identity, but no server chat route binds it to the authenticated connection.',
      'src/domain/protocol.ts:219-223',
      'src/domain/protocol.ts:1109-1154',
      'src/stages/registration.ts:450-452',
    ),
  ),
  WorldInfo: row(
    a1(),
    excluded('WorldInfo supplies world metadata and is not a gameplay command to apply or reject with CommandUnsupported.'),
    excluded('WorldInfo contains a world ID and seed, not a shared state snapshot or post-delta mutation to compare across clients.'),
    gap(
      'World metadata can be delayed or reordered relative to initial state, but no client receiver applies WorldInfo in this library.',
      'src/domain/protocol.ts:227-232',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'World ID and seed initialize a joining or reconnecting client, but no client state route consumes WorldInfo.',
      'src/domain/protocol.ts:227-232',
      'src/stages/registration.ts:450-452',
    ),
    a6NotSpatial,
    excluded('WorldInfo is server world metadata and has no client operation or claimed player identity for A7 to validate.'),
  ),
  WorldSnapshot: row(
    a1(reference('test/codec.test.ts', 2621, 'rejects malformed snapshot members and unknown rejection reasons')),
    excluded('A complete world snapshot establishes state; it is not a client gameplay command to apply or reject.'),
    gap(
      'WorldSnapshot supplies shared blocks and players, but no test compares its resulting state across multiple clients.',
      'src/domain/protocol.ts:281-308',
      'src/stages/registration.ts:450-452',
    ),
    covered(
      reference('test/authoritative-sync.test.ts', 314, 'requires a snapshot before applying incremental updates'),
      reference('test/authoritative-sync.test.ts', 332, 'detects missing revisions without advancing past the gap'),
      reference('test/authoritative-sync.test.ts', 351, 'rejects delayed snapshots and duplicate live updates'),
    ),
    covered(a5WorldSnapshot),
    gap(
      'The snapshot contains player, block, lever, and rail positions, but no per-recipient snapshot AOI projection exists.',
      'src/domain/protocol.ts:288-307',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    a7NotClientOperation,
  ),
  BlockMutationRejected: row(
    a1(reference('test/codec.test.ts', 2621, 'rejects malformed snapshot members and unknown rejection reasons')),
    excluded('BlockMutationRejected reports an already rejected mutation; it is not the command being applied.'),
    a3NotState,
    gap(
      'A delayed or reordered rejection can leave the client with the wrong block view, but no receiver applies this result tag.',
      'src/domain/protocol.ts:310-335',
      'src/stages/registration.ts:450-452',
    ),
    a5NotLifecycle,
    gap(
      'The rejection includes a block position that may be outside the recipient AOI, but no AOI-aware result route filters it.',
      'src/domain/protocol.ts:316-335',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    a7NotClientOperation,
  ),
  AuthoritativeSnapshot: row(
    a1(),
    excluded('AuthoritativeSnapshot is server state supplied to a session, not a client gameplay command.'),
    gap(
      'The authoritative state could be compared across clients, but no test asserts convergence for this snapshot type.',
      'src/domain/protocol.ts:602-627',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'Snapshot ordering against live state can change a client projection, but the host seam has no receiver for this snapshot tag.',
      'src/domain/protocol.ts:602-627',
      'src/stages/registration.ts:450-452',
    ),
    covered(a5AuthoritativeSnapshot),
    gap(
      'The snapshot contains entities and player state, but no recipient-specific AOI projection exists for it.',
      'src/domain/protocol.ts:602-627',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    a7NotClientOperation,
  ),
  RealmTransferSnapshot: row(
    a1(),
    excluded('RealmTransferSnapshot contains an authoritative transfer result, not a client gameplay command.'),
    gap(
      'Realm transfer supplies a new shared world and player state, but no test compares recipient state after this tag.',
      'src/domain/protocol.ts:629-651',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'A delayed or reordered realm transfer can apply the wrong world baseline, but no receiver consumes this transfer tag.',
      'src/domain/protocol.ts:629-651',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'The tag embeds both authoritative snapshots for a mid-session world transfer, but no client route applies RealmTransferSnapshot.',
      'src/domain/protocol.ts:629-651',
      'src/stages/registration.ts:450-452',
    ),
    gap(
      'The nested world snapshot has positions and entities, but no per-recipient AOI projection filters this transfer payload.',
      'src/domain/protocol.ts:629-651',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:450-452',
    ),
    a7NotClientOperation,
  ),
  AuthoritativeCommandAccepted: row(
    a1(),
    excluded('This tag reports an accepted command result; the request itself is represented by an AuthoritativeCommand.'),
    a3NotState,
    gap(
      'Loss, duplication, or reordering can change the command result observed by a client, but no receiver handles this reply tag.',
      'src/domain/protocol.ts:1184-1191',
      'src/stages/registration.ts:450-452',
    ),
    a5NotLifecycle,
    a6NotSpatial,
    a7NotClientOperation,
  ),
  AuthoritativeCommandRejected: row(
    a1(),
    excluded('This tag reports a rejected command result; the request itself is represented by an AuthoritativeCommand.'),
    a3NotState,
    gap(
      'Loss, duplication, or reordering can change the rejection result observed by a client, but no receiver handles this reply tag.',
      'src/domain/protocol.ts:1192-1207',
      'src/stages/registration.ts:450-452',
    ),
    a5NotLifecycle,
    a6NotSpatial,
    a7NotClientOperation,
  ),
  AuthoritativeResyncRequest: row(
    a1(),
    excluded('A resync request asks for a snapshot; it is not a gameplay command to apply or reject with CommandUnsupported.'),
    a3NotState,
    covered(a4StageResync),
    a5NotLifecycle,
    a6NotSpatial,
    gap(
      'A client can request an arbitrary world revision, but no server route authenticates or authorizes this resync request.',
      'src/domain/protocol.ts:1307-1314',
      'src/domain/protocol.ts:1109-1154',
      'src/stages/registration.ts:450-452',
    ),
  ),
  Ping: row(
    a1(reference(
      'test/frame-inspection.test.ts',
      133,
      'reports malformed messages, preserves open root fields, and rejects unsupported protocol versions',
    )),
    excluded('Ping is a liveness probe, not a gameplay command.'),
    a3NotState,
    excluded('Ping/Pong nonce matching measures transport liveness and is outside world-sync ordering and recovery.'),
    a5NotLifecycle,
    a6NotSpatial,
    excluded('Ping is a transport liveness probe with no player operation or world state to authorize.'),
  ),
  Pong: row(
    a1(),
    excluded('Pong is a liveness response, not a gameplay command.'),
    a3NotState,
    excluded('Ping/Pong nonce matching measures transport liveness and is outside world-sync ordering and recovery.'),
    a5NotLifecycle,
    a6NotSpatial,
    excluded('Pong is a transport liveness response with no player operation or world state to authorize.'),
  ),
  ReplicatedWorldDelta: row(
    a1(reference(
      'test/codec.test.ts',
      1939,
      'rejects duplicate registrations, unknown owners, duplicate changes, and invalid owner state',
    )),
    excluded('ReplicatedWorldDelta is authoritative state replication, not a client gameplay command.'),
    covered(a3Convergence),
    covered(a4RevisionGap, reference(
      'test/authoritative-sync.test.ts',
      561,
      'rejects a revision gap without advancing or applying group members',
    ), a4StageResync),
    covered(a3Convergence),
    covered(a6Delta),
    a7NotClientOperation,
  ),
  ReplicatedWorldSnapshot: row(
    a1(reference(
      'test/codec.test.ts',
      2064,
      'requires a registry and its block-read allowance for C4 snapshots',
    )),
    excluded('ReplicatedWorldSnapshot is authoritative state replication, not a client gameplay command.'),
    covered(a3Convergence),
    covered(
      reference('test/authoritative-sync.test.ts', 439, 'rejects stale snapshots and a duplicate revision at the safe integer ceiling'),
      reference('test/authoritative-sync.test.ts', 609, 'replaces the current projection with a same-revision resync snapshot'),
    ),
    covered(a3Convergence),
    gap(
      'The snapshot contains world blocks and owner state, but the only AOI projection API handles deltas.',
      'src/domain/protocol.ts:1228-1239',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:315-320',
    ),
    a7NotClientOperation,
  ),
  ReplicatedWorldSnapshotStart: row(
    a1(),
    excluded('ReplicatedWorldSnapshotStart declares an authoritative snapshot transfer; it is not a client command.'),
    covered(a3Convergence),
    covered(a4TransferOrder),
    covered(a3Convergence),
    gap(
      'The start frame declares a world snapshot transfer, but no per-recipient AOI projection filters its payload declaration.',
      'src/domain/protocol.ts:1272-1287',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:319-320',
    ),
    a7NotClientOperation,
  ),
  ReplicatedWorldSnapshotChunk: row(
    a1(),
    excluded('ReplicatedWorldSnapshotChunk carries a fragment of an authoritative snapshot transfer, not a client command.'),
    covered(a3Convergence),
    covered(a4ChunkOrder),
    covered(a3Convergence),
    gap(
      'The chunk carries world snapshot bytes that may contain out-of-AOI state, but no per-recipient snapshot projection exists.',
      'src/domain/protocol.ts:1289-1298',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:321-322',
    ),
    a7NotClientOperation,
  ),
  ReplicatedWorldSnapshotEnd: row(
    a1(),
    excluded('ReplicatedWorldSnapshotEnd terminates an authoritative snapshot transfer; it is not a client command.'),
    covered(a3Convergence),
    covered(a4TransferOrder),
    covered(a3Convergence),
    gap(
      'The end frame completes a world snapshot transfer, but no per-recipient AOI projection path scopes that transfer.',
      'src/domain/protocol.ts:1300-1305',
      'src/domain/chunk-delta.ts:368-388',
      'src/stages/registration.ts:323-324',
    ),
    a7NotClientOperation,
  ),
}
