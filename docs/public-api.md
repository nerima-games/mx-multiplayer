# 公開 API

`@nerima-games/mx-multiplayer` のバレルは `index.ts` である。
下流(mc-compose)が import してよいのはここから出ているものだけで、
`domain/*` を直接指す deep import は互換保証の対象外とする。

`test/public-api.test.ts` がこの一覧をピン留めしている。
再エクスポートを落とすと、このリポジトリの他のどのテストにも映らないまま下流が壊れるため。

## 1. プロトコル(`domain/protocol.ts`)

| 名前 | 種別 | 契約 |
| --- | --- | --- |
| `PROTOCOL_VERSION` | `number` | このビルドが話すプロトコルバージョン。現在 `2` |
| `PlayerId` / `PlayerName` / `WorldId` | branded Schema | 非空文字列。`.make(...)` でコンストラクト |
| `Vec3` | Schema | `{ x, y, z }` すべて `finite()` |
| `BlockPos` | Schema | `{ x, y, z }` すべて `int()` |
| `Orientation` | Schema | `yawRadians` は `finite()`、`pitchRadians` は `[-π/2, π/2]` |
| `PlayerJoin` … `Pong` | Schema(TaggedStruct) | 個々のメッセージ |
| `NetworkMessage` | Schema(Union) | ワイヤを渡りうるすべて |
| `MESSAGE_TAGS` | `ReadonlyArray` | 既知タグの一覧。網羅性テスト用 |
| `Frame` | Schema | `{ protocolVersion, message }` |

### メッセージ一覧（42 タグ）

| タグ群 | 意味 |
| --- | --- |
| `PlayerJoin` から `BlockMutationRejected` | 接続、移動、ブロック操作、チャット、world 情報とブロック操作の拒否 |
| `AuthoritativeSnapshot` / `RealmTransferSnapshot` | 接続・再接続・realm 移動の完全な authoritative state |
| `PlayerInventoryDelta` から `EntityDespawnDelta` | inventory、vitals、container、furnace、villager、entity の差分同期 |
| `PlayerInventoryCommand` から `VehicleCommand` | authoritative server に送る操作要求 |
| `AuthoritativeCommandAccepted` / `AuthoritativeCommandRejected` / `AuthoritativeResyncRequest` | command 結果と再同期要求 |
| `Ping` / `Pong` | 生存確認。**タイムスタンプではない**([design-notes.md](./design-notes.md) DN-3) |

> **「主張している」**の含意: `BlockBreak` はドロップが何であるかを言わない。
> それはルールであり、mx-gameplay と mc-sim のものである。

タグの完全な列挙は `domain/protocol.ts` の `MESSAGE_TAGS` が正本であり、
codec test が集合と union の一致を検証する。

## 2. コーデック(`domain/codec.ts`)

```typescript
type WireText = string

const encodeFrame: (message: NetworkMessage) => Either<WireText, ProtocolError>
const encodeFrameAsVersion: (protocolVersion: number, message: NetworkMessage) => Either<WireText, ProtocolError>
const decodeFrame: (text: WireText) => Either<NetworkMessage, ProtocolError>
```

**契約**: 表現可能なすべての `m` について `decodeFrame(encodeFrame(m)) == m`。

- `encodeFrameAsVersion` はテスト用。「このビルドが話せないバージョンのフレーム」を作る唯一の手段であり、
  バージョンチェックが本当に**拒否**しているか(ベストエフォートで解釈していないか)を証明するために公開している。
- 戻り値が `Either` なのは、Effect 3 では `Either` が `Effect` の部分型であるため。
  `yield* decodeFrame(text)` がそのまま書ける。

## 3. 障害(`domain/errors.ts`)

```typescript
class ProtocolError  // reason: 'malformed-frame' | 'unsupported-protocol-version' | 'unencodable-message'
class TransportError // reason: 'not-connected' | 'send-failed' | 'closed'
```

**両者を統合してはならない。** 正しい対応が真逆である(DN-2):

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
呼び出し側が区別できるようにするため(DN-8)。

**リトライ方針はここに無い。** どの状態へ行けるかだけを言う。
待ち時間と回数は `Schedule` であり、ソケットを所有するアダプタのものである。

## 5. トランスポート(`domain/transport.ts`)

```typescript
type TransportService = {
  readonly send: (frame: WireText) => Effect<void, TransportError>
  readonly inbound: Queue.Dequeue<WireText>
}
class TransportPort extends Context.Tag('@nerima-games/mx-multiplayer/TransportPort')<...>

const connectionGatedTransport: (
  state: Effect<ConnectionState>,
  transport: TransportService,
) => TransportService

const sendMessage: (message: NetworkMessage) => Effect<void, ProtocolError | TransportError, TransportPort>
const receiveMessage: Effect<NetworkMessage, ProtocolError, TransportPort>

const makeLoopbackPair: Effect<readonly [TransportService, TransportService]>
const LoopbackTransportLayer: (service: TransportService) => Layer<TransportPort>
const disconnectedTransport: Effect<TransportService>
```

プラットフォームアダプタは raw transport と現在の `ConnectionState` を
`connectionGatedTransport` で合成してから `TransportPort` として提供する。`send` ごとに状態を再評価し、
`Connected` 以外では `TransportError { reason: 'not-connected' }` を返す。raw transport はハンドシェイク用途と
後方互換性のため残る。

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

class SnapshotInterpolator {
  constructor(config: SnapshotInterpolatorConfig)
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
const snapshots = new SnapshotInterpolator({ historyLimit: 32, teleportDistance: 8 })

snapshots.ingest(playerId, authoritativeSnapshot)
const pose = snapshots.sample(playerId, serverTick - 2)
snapshots.disconnect(playerId)
```

sequence/tick は wire protocol v1 のフィールドではない。既存プロトコルとの互換性を保つため、
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

## 8. プラットフォーム境界

| 境界 | 所有者 |
| --- | --- |
| `GameModule` / `StageRegistration` | mx-multiplayer の `stages/`。実装済み |
| decoded message を authoritative state に反映する処理 | host/server。mc-compose の multiplayer server は `mc-sim` とゲーム規則を使って所有する |
| 実 WebSocket server と認証・origin policy | platform host。mc-compose の multiplayer server が所有する |
| network phase の全体配置 | mc-compose の stage skeleton。実装済み |

### 8.1 stage 登録

```ts
const MULTIPLAYER_STAGE_IDS: { inbound: StageId; outbound: StageId }   // multiplayer:inbound / multiplayer:outbound
const UPSTREAM_STAGE_IDS: { simPhysics: StageId }                      // sim:physics — outbound の唯一の after
const multiplayerModule: GameModule<never, never, never, TransportPort>
const makeMultiplayerStages: Effect<ReadonlyArray<StageRegistration>, never, TransportPort>
const makeMultiplayerStagesForPreview: Effect<{ state; stages }, never, TransportPort>
```

`RRegister` が `TransportPort` で `ROut` が `never` である点が、ロスターの中でこのリポジトリだけの
形である。mc-render は自分が**提供する** `InputService` を acquire するが、ここで acquire する
`TransportPort` は自分が**定義するだけ**で提供しないもの（実アダプタはプラットフォーム層）。
つまり `RRegister` は外から満たされねばならない本物の要求であり、
`RRegister` を `RIn` に畳めない理由の最も分かりやすい実例になっている。

全体の stage 順序は [responsibility.md](./responsibility.md) §2.1 を参照。これは
mx-multiplayer の公開 API ではなく、mc-compose が所有するフレーム契約である。

**API ロックファイルはこの表から外れた。** plan.md §9 の未決事項
「API ロックファイルのツール選定（api-extractor 相当の Effect-TS 互換手段）」は決着し、
実装されている。

| 項目 | 内容 |
| --- | --- |
| 生成物 | リポジトリ直下の `api-lock.md`（公開宣言 58 件 + 参照されている非 export 宣言 3 件。コミット対象） |
| 生成器 | `scripts/api-lock.ts`（16 リポジトリに byte-identical で vendor。`scripts/check-dependency-whitelist.ts` と同じ方式で、編集してよいのは `REPOSITORY_POLICY` だけ） |
| 検査 | `pnpm api:check` — `api-lock.md` が実際の公開 API と食い違えば非ゼロ終了 |
| 更新 | `pnpm api:update` |
| 配線 | `pnpm verify` の `check:deps` と `test` の間、および CI の `API lock` ステップ |
| 追加依存 | **なし**（`typescript` は既に devDependency） |

理由と実測の正本は mc-kernel の `docs/versioning.md` §7。
`@microsoft/api-extractor` は「`Context.Tag` のサービスクラスが写らない」ことを決め手に却下されている。

本リポジトリで言えば `TransportPort` がその当のものである。`api-lock.md` には

```ts
const TransportPort_base: Context.TagClass<TransportPort, "@nerima-games/mx-multiplayer/TransportPort", TransportService>;
```

が残っており、§5 で議論した「**Port が運ぶのはテキストであってメッセージ値ではない**」
という決定 —— `send: (frame: WireText) => ...`、`inbound: Queue.Dequeue<WireText>` ——
はこの `TransportService` の中身として写る。`WireText` を `NetworkMessage` に戻す変更は
文章上の約束ではなく `pnpm api:check` の失敗になる。api-extractor を採っていた場合、
ここは `export class TransportPort extends TransportPort_base {}` という空の殻に潰れ、
Tag 識別子文字列も `TransportService` も消えていた。

捕まえないもの: **挙動**（コーデックが何を吐くかはテストの仕事）と、
**interface / 型リテラルのメンバ順**（ソース順を保つので並べ替えは API 変更でなくても diff になる）。
