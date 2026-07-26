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
| `GameModule` / `StageRegistration` の実装 | mc-kernel の契約型が確定してから |
| mc-sim サービスへの反映 | mc-sim 公開後 |
| 実 WebSocket アダプタ | プラットフォーム層の所在が決まってから |
| API ロックファイル | plan.md §9「未決」— ツール選定待ち |
