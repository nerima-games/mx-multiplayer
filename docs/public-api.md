# 公開 API

`@nerima-games/mx-multiplayer` のバレルは `index.ts` である。
下流(mc-compose)が import してよいのはここから出ているものだけで、
`domain/*` を直接指す deep import は互換保証の対象外とする。

`test/public-api.test.ts` がこの一覧をピン留めしている。
再エクスポートを落とすと、このリポジトリの他のどのテストにも映らないまま下流が壊れるため。

## 1. プロトコル(`domain/protocol.ts`)

| 名前 | 種別 | 契約 |
| --- | --- | --- |
| `PROTOCOL_VERSION` | `number` | このビルドが話すプロトコルバージョン。現在 `1` |
| `PlayerId` / `PlayerName` / `WorldId` | branded Schema | 非空文字列。`.make(...)` でコンストラクト |
| `Vec3` | Schema | `{ x, y, z }` すべて `finite()` |
| `BlockPos` | Schema | `{ x, y, z }` すべて `int()` |
| `Orientation` | Schema | `yawRadians` は `finite()`、`pitchRadians` は `[-π/2, π/2]` |
| `PlayerJoin` … `Pong` | Schema(TaggedStruct) | 個々のメッセージ |
| `NetworkMessage` | Schema(Union) | ワイヤを渡りうるすべて |
| `MESSAGE_TAGS` | `ReadonlyArray` | 既知タグの一覧。網羅性テスト用 |
| `Frame` | Schema | `{ protocolVersion, message }` |

### メッセージ一覧(叩き台 9 種)

| タグ | ペイロード | 意味 |
| --- | --- | --- |
| `PlayerJoin` | `player`, `name`, `at` | ピアが参加した |
| `PlayerLeave` | `player` | ピアが離脱した |
| `PlayerMove` | `player`, `at`, `facing` | ピアの位置と姿勢 |
| `BlockPlace` | `player`, `at`, `block` | ピアがブロックを置いたと**主張している** |
| `BlockBreak` | `player`, `at` | ピアがブロックを壊したと**主張している** |
| `Chat` | `player`, `text`(1〜256 文字) | チャット |
| `WorldInfo` | `world`, `seed`(int) | ワールド識別とシード |
| `Ping` / `Pong` | `nonce`(int) | 生存確認。**タイムスタンプではない**([design-notes.md](./design-notes.md) DN-3) |

> **「主張している」**の含意: `BlockBreak` はドロップが何であるかを言わない。
> それはルールであり、mx-gameplay と mc-sim のものである。

参照実装は 18 種(`EntitySnapshot` / `EntityDamage` / `ContainerUpdate` /
`DroppedItemSpawn` / `DroppedItemRemove` / `ParkedVehicleUpdate` /
`ParkedVehicleRemove` / `ClaimDenied` / `Error` を含む)。
残りは [porting.md](./porting.md) の順序で追加する。

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

const sendMessage: (message: NetworkMessage) => Effect<void, ProtocolError | TransportError, TransportPort>
const receiveMessage: Effect<NetworkMessage, ProtocolError, TransportPort>

const makeLoopbackPair: Effect<readonly [TransportService, TransportService]>
const LoopbackTransportLayer: (service: TransportService) => Layer<TransportPort>
const disconnectedTransport: Effect<TransportService>
```

**Port が運ぶのはテキストであってメッセージ値ではない。**
`send` が `NetworkMessage` を取ると、ループバックはオブジェクトを参照渡しするだけになり、
コーデックのバグがすべてのループバックテストを生き延びる。

`inbound` がコールバックでなく `Dequeue` なのはバックプレッシャを表現するため。
追いつけない consumer は producer をブロックし、裏で無制限にキューが伸びない。

## 6. まだ無いもの

| 未実装 | 追加時期 |
| --- | --- |
| ~~`GameModule` / `StageRegistration` の実装~~ | **実装済み**（`stages/`)。下記参照 |
| mc-sim サービスへの反映 | mc-sim 公開後。接ぎ目は `MultiplayerFrameState.inbound` にある |
| 実 WebSocket アダプタ | プラットフォーム層の所在が決まってから |
| **mc-compose 側の `multiplayer:` フェーズ** | **mc-compose の作業**。無いあいだ 2 stage は HUD の後ろで走る |

### 6.1 stage 登録

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

**骨格の欠落については [responsibility.md](./responsibility.md) §2.1 と
`stages/stage-ids.ts` 冒頭を読むこと。** ここに書いていないのは、これが
mc-compose に対する要求であって本リポジトリの公開 API ではないからである。

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
