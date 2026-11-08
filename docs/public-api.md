# 公開 API

`@nerima-games/mx-multiplayer` のバレルは `index.ts` である。
下流(mc-compose)が import してよいのはここから出ているものだけで、
`domain/*` を直接指す deep import は互換保証の対象外とする。

`test/public-api.test.ts` がこの一覧をピン留めしている。
再エクスポートを落とすと、このリポジトリの他のどのテストにも映らないまま下流が壊れるため。

The source barrel is `src/index.ts`; the package root resolves to `dist/index.js` and `dist/index.d.ts`.
Source paths in section headings are relative to the repository root; `domain/*` refers to `src/domain/*`.

## 1. プロトコル(`domain/protocol.ts`)

| 名前 | 種別 | 契約 |
| --- | --- | --- |
| `PROTOCOL_VERSION` | `number` | `src/domain/protocol.ts` が export する wire protocol 版数。現在は 11。値の正本は実装と互換性テスト |
| `PlayerId` / `PlayerName` / `WorldId` | branded Schema | 非空文字列。`.make(...)` でコンストラクト |
| `Vec3` | Schema | `{ x, y, z }` すべて `finite()` |
| `BlockPos` | Schema | `{ x, y, z }` すべて `int()` |
| `Orientation` | Schema | `yawRadians` は `finite()`、`pitchRadians` は `[-π/2, π/2]` |
| `PlayerJoin` … `Pong` | Schema(TaggedStruct) | 個々のメッセージ |
| `NetworkMessage` | Schema(Union) | ワイヤを渡りうるすべて |
| `MESSAGE_TAGS` | `ReadonlyArray` | 既知タグの一覧。網羅性テスト用 |
| `Frame` | Schema | `{ protocolVersion, message }` |
| `ReplicatedWorldDeltaMessage` / `ReplicatedWorldSnapshot` | Schema | C4 group carrying owner state and sparse block changes for one world revision |
| `ReplicatedWorldSnapshotStart` / `ReplicatedWorldSnapshotChunk` / `ReplicatedWorldSnapshotEnd` | Schema | Control frames for bounded transfer of large C4 snapshots |
| `TransferIdSchema` / `Base64Schema` / `LowercaseHexSha256Schema` | branded Schema | Branded schemas for transfer IDs, chunks, and digests |

### メッセージタグ

| タグ群 | 意味 |
| --- | --- |
| `PlayerJoin` から `BlockMutationRejected` | 接続、移動、ブロック操作、チャット、world 情報とブロック操作の拒否 |
| `AuthoritativeSnapshot` / `RealmTransferSnapshot` | 接続・再接続・realm 移動の完全な authoritative state |
| `PlayerInventoryDelta` から `EntityDespawnDelta` | inventory、vitals、container、furnace、villager、entity の差分同期 |
| `PlayerInventoryCommand` から `VehicleCommand` | authoritative server に送る操作要求 |
| `AuthoritativeCommandAccepted` / `AuthoritativeCommandRejected` / `AuthoritativeResyncRequest` | command 結果と再同期要求 |
| `Ping` / `Pong` | 生存確認。**タイムスタンプではない**([design-notes.md](./design-notes.md) DN-3) |
| subsystem command/result and delta tags (`Anvil*`、`Crafting*`、`PlayerDamage*`、`Brewing*`、`Enchanting*`、`Wither*`、`EnderDragon*`) | 各サブシステムの同期 |
| `ReplicatedWorldDelta` / `ReplicatedWorldSnapshot` | C4 owner changes and sparse block changes grouped by revision |
| `ReplicatedWorldSnapshotStart` / `ReplicatedWorldSnapshotChunk` / `ReplicatedWorldSnapshotEnd` | Bounded transfer for large snapshots |

> **「主張している」**の含意: `BlockBreak` はドロップが何であるかを言わない。
> それはルールであり、mx-gameplay と mc-sim のものである。

タグの完全な列挙は `domain/protocol.ts` の `MESSAGE_TAGS` が正本であり、
codec test が集合と union の一致を検証する。

C4 names the grouped owner-state and block replication stream. WCC means `WorldCommitCoordinator` from
`mc-sim`. C4 deltas carry `changes` and `blockChanges` with the same `world` and `revision`. Each block change includes
the before and after block IDs and encoded states; each snapshot block read includes its encoded state. The
receiver validates and applies owner and block changes as one group; revisions with no visible changes still
advance as empty groups. A C4 snapshot represents a consistent view of owners and blocks. Oversized snapshots
use start/chunk/end frames. The protocol transports the WCC owner-state projection and sparse block changes
from `mc-sim`; `mx-multiplayer` does not duplicate owner state.

## 2. コーデック(`domain/codec.ts`)

```typescript
type WireText = string
type NonNegativeSafeInteger = typeof NonNegativeSafeIntegerSchema.Type
type PositiveSafeInteger = typeof PositiveSafeIntegerSchema.Type

const encodeFrame: (message: unknown, owners?: ReplicatedOwnerRegistry) => Result.Result<WireText, ProtocolError>
const encodeFrameAsVersion: (protocolVersion: number, message: unknown, owners?: ReplicatedOwnerRegistry) => Result.Result<WireText, ProtocolError>
const decodeFrame: (text: WireText, owners?: ReplicatedOwnerRegistry) => Result.Result<NetworkMessage, ProtocolError>
const wireFrameByteLength: (text: WireText) => NonNegativeSafeInteger
const encodeTransferredSnapshotFrame: (message: unknown, owners: ReplicatedOwnerRegistry, maxTotalBytes: unknown) => Result.Result<WireText, ProtocolError>
const decodeTransferredSnapshotFrame: (text: WireText, owners: ReplicatedOwnerRegistry, maxTotalBytes: unknown) => Result.Result<NetworkMessage, ProtocolError>
const NonNegativeSafeIntegerSchema: branded Schema
const PositiveSafeIntegerSchema: branded Schema
const ReplicatedOwnerStateBoundsSchema: Schema
const ReplicatedOwnerRegistryLimitsSchema: Schema
```

**Contract**: `encodeFrame` validates runtime input. For each message it successfully encodes,
`decodeFrame` returns an equivalent `NetworkMessage`. Invalid input returns `unencodable-message`.
`effect`'s `Result.Result` is a value containing either success or failure, so codec calls need no Effect context.

- `encodeFrameAsVersion` はテスト用。「このビルドが話せないバージョンのフレーム」を作る唯一の手段であり、
  バージョンチェックが本当に**拒否**しているか(ベストエフォートで解釈していないか)を証明するために公開している。
- `ReplicatedOwnerRegistryLimitsSchema` defines owner count, delta/snapshot counts, JSON shape, frame bytes, and
  per-owner state bounds. `SnapshotTransferLimitsSchema` defines total bytes, chunk, and queued-delta limits.
  Callers may pass unknown configuration to the factories; each factory decodes it before use. Neither has
  production defaults; host composition supplies values based on schema and traffic measurements.
- Use the transfer-specific encode/decode functions when a snapshot exceeds the regular frame cap. Callers
  also configure receiver limits. The server adapter enforces inbound frame, byte, delta-size, and message-kind
  limits per connection; the WebSocket host remains responsible for applying returned disconnect actions.

## 3. 障害(`domain/errors.ts`)

```typescript
type ProtocolErrorReason // 'malformed-frame' | 'frame-too-large' | 'unsupported-protocol-version' | 'unencodable-message'
class ProtocolError  // reason: ProtocolErrorReason
class TransportError // reason: 'not-connected' | 'send-failed' | 'closed'
```

**両者を統合してはならない。** 正しい対応が真逆である([design-notes.md](./design-notes.md), DN-2):

- `ProtocolError` → フレームまたはピアを捨てる。**再送は無意味**
- `TransportError` → **再送・再接続が正解**。メッセージ自体は有効

## 4. 接続ライフサイクル(`domain/connection.ts`)

```typescript
type ConnectionState = Disconnected | Connecting | Connected | Closed
type ConnectionEvent =
  | ConnectRequested | HandshakeSucceeded | HandshakeFailed
  | PeerClosed | TransportFailed | CloseRequested | RetryRequested

const initialConnectionState: ConnectionState
const transition: (state, event) => ConnectionState | undefined
const runTransitions: (from, events) => { state, rejectedAt: number | undefined }
const canSend: (state) => boolean
const isSettled: (state) => boolean
```

**`transition` が `undefined` を返すのは「そのイベントはここでは不正」の意味である。**
現状態をそのまま返さないのは、「何もすることが無い」と「筋の通らない要求」を
呼び出し側が区別できるようにするため([design-notes.md](./design-notes.md), DN-8)。

**リトライ方針はここに無い。** どの状態へ行けるかだけを言う。
待ち時間と回数は `Schedule` であり、ソケットを所有するアダプタのものである。

## 5. トランスポート(`domain/transport.ts`)

```typescript
type TransportService = {
  readonly send: (frame: WireText) => Effect.Effect<void, TransportError>
  readonly inbound: Queue.Dequeue<WireText>
}
const TransportPortBase: Context.ServiceClass<
  TransportPort,
  '@nerima-games/mx-multiplayer/TransportPort',
  TransportService
> = Context.Service<TransportPort, TransportService>()('@nerima-games/mx-multiplayer/TransportPort')
class TransportPort extends TransportPortBase {}

const connectionGatedTransport: (
  state: Effect.Effect<ConnectionState>,
  transport: TransportService,
) => TransportService

const sendMessage: (message: NetworkMessage) => Effect.Effect<void, ProtocolError | TransportError, TransportPort>
const receiveMessage: Effect.Effect<NetworkMessage, ProtocolError, TransportPort>

const makeLoopbackPair: Effect.Effect<readonly [TransportService, TransportService]>
const LoopbackTransportLayer: (service: TransportService) => Layer.Layer<TransportPort>
const disconnectedTransport: Effect.Effect<TransportService>
```

プラットフォームアダプタは raw transport と現在の `ConnectionState` を
`connectionGatedTransport` で合成してから `TransportPort` として提供する。`send` ごとに状態を再評価し、
`Connected` 以外では `TransportError { reason: 'not-connected' }` を返す。raw transport はハンドシェイク用途と
後方互換性のため残る。

Here, a raw transport is a `TransportService` before the connection-state gate is applied. It remains public
for handshake traffic and existing callers that provide `TransportService` directly. The host provides the
decorated service as `TransportPort`; `connectionGatedTransport` checks the current state on every send.

**Port が運ぶのはテキストであってメッセージ値ではない。**
`send` が `NetworkMessage` を取ると、ループバックはオブジェクトを参照渡しするだけになり、
コーデックのバグがすべてのループバックテストを生き延びる。

`inbound` がコールバックでなく `Dequeue` なのはバックプレッシャを表現するため。
追いつけない consumer は producer をブロックし、裏で無制限にキューが伸びない。

## 6. スナップショット補間(`domain/snapshot-interpolation.ts`)

```typescript
interface PlayerTransformSnapshot {
  readonly sequence: number
  readonly tick: number
  readonly at: Vec3
  readonly facing: Orientation
}

interface SnapshotInterpolatorConfig {
  readonly historyLimit: number
  readonly teleportDistance: number
}

type SnapshotIngestResult =
  | { readonly accepted: true; readonly historySize: number }
  | { readonly accepted: false; readonly reason: 'invalid' | 'duplicate-or-stale' }

class SnapshotInterpolator {
  static make(config: SnapshotInterpolatorConfig): Result.Result<SnapshotInterpolator, SnapshotInterpolationConfigError>
  ingest(player: PlayerId, snapshot: PlayerTransformSnapshot): SnapshotIngestResult
  sample(player: PlayerId, renderTick: number): PlayerTransformSnapshot | undefined
  historySize(player: PlayerId): number
  disconnect(player?: PlayerId): void
}
```

`ingest` はプレイヤーごとに sequence と tick がともに単調増加するスナップショットだけを受理する。
重複・遅延・逆順パケットは `duplicate-or-stale` として破棄し、履歴は `historyLimit` を超えない。
`sample` は外部クロックを読まず、同じ履歴と描画 tick に常に同じ結果を返す。範囲内では位置・pitchを
線形補間し、yaw は最短角を通る。位置差が `teleportDistance` 以上なら中間位置を生成せず、右側の
authoritative tick でスナップする。切断時は `disconnect(player)`、全切断時は `disconnect()` を呼ぶ。

```typescript
const snapshots = Result.getOrThrow(SnapshotInterpolator.make({ historyLimit: 32, teleportDistance: 8 }))

const renderPlayer = (
  playerId: PlayerId,
  authoritativeSnapshot: PlayerTransformSnapshot,
  serverTick: number,
): PlayerTransformSnapshot | undefined => {
  const accepted = snapshots.ingest(playerId, authoritativeSnapshot)
  if (!accepted.accepted) return undefined
  return snapshots.sample(playerId, serverTick - 2)
}

snapshots.disconnect()
```

sequence/tick は `src/domain/protocol.ts` の `PROTOCOL_VERSION` が定義する wire protocol のフィールドではない。既存プロトコルとの互換性を保つため、
サーバまたは上位の同期処理が `PlayerTransformSnapshot` を構築する際に付与する。

## 7. authoritative revision 管理(`domain/authoritative-sync.ts`)

```typescript
class AuthoritativeRevisionTracker {
  ingestSnapshot(snapshot: WorldSnapshot): RevisionAdmission
  ingestRevision(world: WorldId, revision: number): RevisionAdmission
  revision(world: WorldId): number | undefined
  disconnect(world?: WorldId): void
}
```

接続直後と再接続後は incremental update を `snapshot-required` として拒否し、完全な
`WorldSnapshot` が同期基準を確立してから連番 revision だけを受理する。欠番は
`revision-gap` として検出し、その revision へ進まないため、呼び出し側は新しい snapshot を
取得して安全に復旧できる。snapshot と live update の遅延・重複は `duplicate-or-stale` になる。

tracker はゲーム状態を保持・変更せず、再接続や snapshot 要求の transport 方針も決めない。
それらを所有する platform adapter が admission 結果を使って再取得を開始する。

### 7.1 C4 client apply and bounded snapshot transfer

```typescript
type ReplicatedWorldDeltaMessage = {
  readonly _tag: 'ReplicatedWorldDelta'
  readonly world: WorldId
  readonly revision: WorldRevision
  readonly changes: ReadonlyArray<ReplicatedOwnerChange>
  readonly blockChanges: ReadonlyArray<ReplicatedBlockChange>
}

type SnapshotTransferLimits = {
  readonly maxTotalBytes: PositiveSafeInteger
  readonly maxChunkCount: PositiveSafeInteger
  readonly maxChunkBytes: PositiveSafeInteger
  readonly maxQueuedDeltaCount: NonNegativeSafeInteger
  readonly maxQueuedDeltaBytes: NonNegativeSafeInteger
}
const SnapshotTransferLimitsSchema: Schema

class SnapshotTransferReceiver {
  static make(limits: unknown): Result.Result<SnapshotTransferReceiver, SnapshotTransferConfigError>
  begin(start: ReplicatedWorldSnapshotStart, lastKnownRevision?: WorldRevision): SnapshotTransferReceipt
  append(chunk: ReplicatedWorldSnapshotChunk): SnapshotTransferReceipt
  queueDelta(delta: ReplicatedWorldDeltaMessage, frameBytes: unknown): SnapshotTransferReceipt & Readonly<{ queued?: boolean }>
  finish(end: ReplicatedWorldSnapshotEnd): SnapshotTransferCompletion
  discard(): void
}

const ReplicatedBlockKeySchema: branded Schema
const decodeUtf8Frame: (bytes: Uint8Array) => WireText | undefined
const sha256Hex: (bytes: Uint8Array) => Result.Result<LowercaseHexSha256, Schema.SchemaError>
const applyReplicatedWorldSnapshot: (state: AuthoritativeClientSnapshot, snapshot: ReplicatedWorldSnapshot) => ClientSyncTransition
const applyReplicatedWorldDelta: (state: AuthoritativeClientSnapshot, delta: ReplicatedWorldDeltaMessage) => ClientSyncTransition

class AuthoritativeClientState {
  get snapshot(): AuthoritativeClientSnapshot
  world(world: WorldId): AuthoritativeWorldState | undefined
  applySnapshot(snapshot: ReplicatedWorldSnapshot): ClientSyncTransition
  applyDelta(delta: ReplicatedWorldDeltaMessage): ClientSyncTransition
  applyTransfer(completion: CompletedSnapshotTransfer, owners: ReplicatedOwnerRegistry): ClientSyncTransition
  disconnect(world?: WorldId): void
}
```

`AuthoritativeClientState` holds the client projection. It validates owner changes and block changes in a delta
as one revision and applies neither if either side is invalid. Snapshot transfer validates declared values,
chunk order and size, total bytes, digest, snapshot schema, and deltas queued during the transfer before it
publishes a candidate state. On failure, it keeps the previous projection and returns a resync request.

## 8. プラットフォーム境界

| 境界 | 所有者 |
| --- | --- |
| `GameModule` / `StageRegistration` | mx-multiplayer の `src/stages/`。実装済み |
| Inbound frame validation, per-connection limits, supported command application, and recipient-specific snapshot/delta projection | mx-multiplayer's `createServerAdapter`; the host supplies gameplay rules and authoritative world services |
| 実 WebSocket server、origin policy、暗号・永続化 port の実装 | platform host。mc-compose の multiplayer server が所有する |
| network phase の全体配置 | mc-compose の stage skeleton。実装済み |

### 8.1 stage 登録

```ts
const MULTIPLAYER_STAGE_IDS: { inbound: StageId; outbound: StageId } // multiplayer:inbound / multiplayer:outbound
const UPSTREAM_STAGE_IDS: { simPhysics: StageId }                    // sim:physics — outbound の唯一の after
const EXPERIENCE_MODULE_STAGE_PREFIXES: readonly string[]
const OWN_STAGE_PREFIX: string
const multiplayerModule: GameModule<never, never, never, TransportPort>
const multiplayerStages: (...args: unknown[]) => ReadonlyArray<StageRegistration>
const makeMultiplayerStages: Effect.Effect<ReadonlyArray<StageRegistration>, never, TransportPort>
const makeMultiplayerStagesForPreview: Effect.Effect<{ state; stages }, never, TransportPort>
const makeMultiplayerStagesForClientPreview: (sync: MultiplayerClientSync) => Effect.Effect<{ state; stages }, never, TransportPort>
const makeMultiplayerHostWithClientSync: (sync: MultiplayerClientSync) => Effect.Effect<MultiplayerHost, never, TransportPort>
const makeMultiplayerFrameState: Effect.Effect<MultiplayerFrameState>
const NO_NETWORK_FRAMES
```

上記は `test/public-api.test.ts` が固定する stage 公開値の代表一覧である。
stage 実装の詳細と追加の host adapter は `src/stages/registration.ts` を正本とし、
全公開値を列挙する一覧ではない。

The host supplies the `TransportPort` required by `multiplayerModule`. This package declares the port and stage
registration but does not provide a concrete WebSocket implementation.

全体の stage 順序は [responsibility.md](./responsibility.md) §2.1 を参照。これは
mx-multiplayer の公開 API ではなく、mc-compose が所有するフレーム契約である。

### 8.2 Reconnect token expiration

`createReconnectAuth` is exported from the package root and accepts an optional options object:

```ts
createReconnectAuth(
  crypto: ReconnectAuthCrypto,
  store: ReconnectAuthStore,
  options?: { readonly tokenTtl?: Duration.Input },
): Effect.Effect<ReconnectAuth, unknown>
```

Each reconnect token expires 24 hours after issuance by default. This gives a player time to reconnect after a disconnect while bounding how long a leaked token remains valid. Pass a finite positive Effect `Duration.Input` as `options.tokenTtl` to configure the lifetime, for example `Duration.hours(12)`.

`has(player)` reports whether an auth record exists; `resume` and `rotate` check whether a matching token is still valid. The current and previous token hashes keep separate issuance times, so rotating a token starts a new lifetime for the new token while preserving the previous token's original expiry.

Persisted formats 1 and 2 are earlier reconnect-auth file layouts. When the implementation loads either format, it treats each existing hash as issued at load time. This preserves those tokens during migration and starts their configured TTL when the file is read.

### 8.3 Server integration adapter

`createServerAdapter` is exported from the package root. It composes frame inspection, reconnect-token resume,
connection and message-kind limits, supported command application, and recipient-specific world projection.
The host supplies command services, owner locations, chunk interest, block-state lookups, a reconnect-auth
resume operation, and an `AuthoritativeSession`:

```ts
const MAX_SERVER_CONNECTIONS: number // 20 concurrent connections per adapter
const createServerAdapter: <Behaviour>(config: ServerAdapterConfiguration<Behaviour>) => ServerAdapter

import { EncodedBlockStateSchema } from '@nerima-games/mc-kernel'

type ServerAdapterConfiguration<Behaviour> = {
  commandContextFor: (identity: ServerConnectionIdentity, player: PlayerId, world: WorldId) => CommandIntentContext
  commandServices: WorldWriteServices<Behaviour>
  blockStatesForChange: (lookup: ServerBlockStateLookup) => Result.Result<ServerBlockStatePair, unknown>
  blockStateForRead: (lookup: ServerBlockReadStateLookup) => Result.Result<typeof EncodedBlockStateSchema.Type, unknown>
  interestInputFor: (identity: ServerConnectionIdentity, player: PlayerId, world: WorldId) => unknown
  ownerRegistry: ReplicatedOwnerRegistry
  reconnectAuth: Pick<ReconnectAuth, 'resume'>
  session: AuthoritativeSession
}

type ServerAdapter = {
  connect(player: PlayerId, world: WorldId): ServerConnectOutcome
  disconnect(connection: ServerConnectionHandle): boolean
  receiveFrame(connection: ServerConnectionHandle, frame: unknown): Effect.Effect<ServerInboundOutcome>
  resume(token: unknown): Effect.Effect<ServerResumeOutcome>
  projectSnapshot(connection: ServerConnectionHandle, authoritative: unknown, inputs: ServerSnapshotProjectionInputs): Result.Result<TargetedSnapshotDelivery, ServerProjectionFailure>
  projectDelta(delta: unknown): Result.Result<ReadonlyArray<TargetedDeltaDelivery>, ServerProjectionFailure>
}
```

`receiveFrame` checks the protocol version and frame bounds before decoding JSON, then returns typed rejection,
rate-limit, chat, movement, resync, or command outcomes. Global limits use 25 frames/second, 1,089,775 bytes/second,
an 80-frame burst, and a 54,489-byte maximum delta. Message-kind limits allow 3 chat messages per 10 seconds;
commands use a burst of 20 and refill at 10/second, movement a burst of 40 and refill at 20/second, and other
messages a burst of 80 and refill at 25/second. Chat overages return `warn`, command/movement/other overages
return `drop`, and global overages return `disconnect`; the transport host applies the requested action.

`interestInputFor` returns `{ chunks, ownerIds }`. Each chunk has `{ dimension, x, z }` fields, with integer
chunk coordinates; the adapter validates this value before using it. `commandContextFor` and `commandServices`
connect accepted commands to host-owned gameplay rules and world writes. `blockStatesForChange` resolves the
before/after state pair for a delta, and `blockStateForRead` supplies state for each loaded snapshot block.

`projectSnapshot` filters owner-scoped authoritative fields and C4 owners/blocks to the connection's area of
interest. `projectDelta` returns only changed owners and blocks visible to each connection. The adapter's
snapshot input is `AuthoritativeSnapshot` plus a C4 replicated-world snapshot; it does not filter legacy
`RealmTransferSnapshot.worldSnapshot.players` values built outside this API. `resume` validates and rotates a
token, returning the resumed player and replacement token; the host still creates the new connection.

## 9. 公開パッケージの境界

公開範囲の正本は `package.json` である。

- `exports["."]` が公開するのは `./dist/index.js` と `./dist/index.d.ts` だけである。
- `files` に含むのは `dist`、`LICENSE`、`README.md` だけである。
- 公開するサブパス export はなく、`src/` や `dist/` の deep import は保証しない。

`src/index.ts` の root barrel と `pnpm build` が生成する declaration は、この境界と一致させる。
