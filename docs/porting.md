# 移植計画

参照実装 `takeokunn/ts-minecraft`(以下「参照実装」)は**凍結された仕様書兼テストオラクル**である
(plan.md 冒頭)。ゼロから仕様を再発明せず、対応するテスト・fixture を**先に**移植する。

## 0. LOC はすべて実測値

plan.md §3.14 は移植元を「`packages/network`(1.7k)」と記している。
**この見積りは正確である**(実測 1,718 LOC)。ただし plan.md の他の見積りは当てにならないため
(例: §3.15 の QA API「~1.4k」は実測 2,648 LOC)、本ドキュメントの数値はすべて
`wc -l` による実測に置き換えてある。

測定日: 2026-07-26。測定コマンド:

```console
$ cd /Users/take/ghq/github.com/takeokunn/ts-minecraft
$ find packages/network -name '*.ts' -not -name '*.test.ts' -not -path '*/test/*' | xargs wc -l
```

## 1. 移植元(実測)

### 1.1 プロダクションコード — 合計 **1,718 LOC**

| ファイル | LOC | 移植先 | 備考 |
| --- | ---: | --- | --- |
| `packages/network/domain/schemas.ts` | 383 | `domain/protocol.ts` | メッセージ 18 種 + Vec3/BlockPos/Rotation。`timestamp` は落とす([design-notes.md](./design-notes.md) DN-3) |
| `packages/network/domain/errors.ts` | 19 | `domain/errors.ts` | 単一 `NetworkError` を 2 型に分割(DN-2) |
| `packages/network/domain/ports.ts` | 24 | `domain/transport.ts` | |
| `packages/network/domain/websocket-ports.ts` | 30 | `domain/transport.ts` | WebSocket 固有の型は Port から外す |
| `packages/network/application/codec.ts` | 34 | `domain/codec.ts` | `ArrayBuffer` → テキストへ(DN-4) |
| `packages/network/application/client-service.ts` | 173 | `domain/connection.ts` + アダプタ | 接続状態を明示的な状態機械へ(DN-8) |
| `packages/network/application/server-service.ts` | 186 | アダプタ(リポジトリ外) | |
| `packages/network/application/server-handlers.ts` | **471** | **分割**: プロトコルはここ、claim 調停は mc-sim / mx-gameplay | 最大の要注意ファイル(DN-9) |
| `packages/network/infrastructure/browser-websocket-client.ts` | 109 | プラットフォームアダプタ | Port の実装 |
| `packages/network/infrastructure/websocket-client.ts` | 21 | 同上 | |
| `packages/network/infrastructure/websocket-server.ts` | 117 | 同上 | |
| `packages/network/infrastructure/node-websocket-server.ts` | 102 | 同上 | |
| `packages/network/infrastructure/node-websocket-data.ts` | 18 | 同上 | |
| `packages/network/scripts/multiplayer-server.ts` | 31 | 同上(dev サーバ) | |

### 1.2 テストコード — 合計 **1,978 LOC**

**テスト資産のほうが本体より大きい。** これは移植の負債ではなく資産であり、
plan.md §6 Step 2 のとおり**先に**移す。

| ファイル | LOC | 扱い |
| --- | ---: | --- |
| `packages/network/test/server-handlers.test.ts` | 706 | 大半は claim 調停・ワールド同期のルール検証 → **mc-sim / mx-gameplay へ移送** |
| `packages/network/test/client-service.test.ts` | 252 | 接続ライフサイクル → `test/connection.test.ts` + アダプタテストへ分割 |
| `packages/network/test/server-service.test.ts` | 235 | アダプタ側 |
| `packages/network/domain/schemas.test.ts` | 187 | → `test/codec.test.ts`(ラウンドトリップ)。**最優先で移植** |
| `packages/network/test/browser-websocket-client.test.ts` | 175 | アダプタ側 |
| `packages/network/test/node-websocket-server.test.ts` | 175 | アダプタ側 |
| `packages/network/test/codec.test.ts` | 117 | → `test/codec.test.ts` |
| `packages/network/test/claim-arbitration.test.ts` | 99 | → **mx-gameplay**。ここには残さない(DN-9) |
| `packages/network/test/node-websocket-data.test.ts` | 32 | アダプタ側 |

### 1.3 ここに来ないもの — `packages/presentation/multiplayer` 合計 **592 LOC**

plan.md §3.13 の「multiplayer 画面 0.6k」に対応。実測も 592 LOC で一致。
**全量が mx-ui へ行く。**

| ファイル | LOC |
| --- | ---: |
| `packages/presentation/multiplayer/chat-panel.ts` | 254 |
| `packages/presentation/multiplayer/connection-panel.ts` | 181 |
| `packages/presentation/multiplayer/player-list-panel.ts` | 154 |
| `packages/presentation/multiplayer/index.ts` | 3 |

## 2. 差し引きした移植規模

| 区分 | LOC | 行き先 |
| --- | ---: | --- |
| プロトコル + コーデック + Port | 約 490 | **mx-multiplayer(ドメイン)** |
| 接続ライフサイクル | 約 173 | **mx-multiplayer**(状態機械へ再構成) |
| WebSocket アダプタ + dev サーバ | 約 398 | プラットフォームアダプタ(本リポジトリ外) |
| claim 調停等のルール | 約 200(`server-handlers.ts` の一部) | **mc-sim / mx-gameplay** |
| サーバ配線 | 約 460 | アダプタ |
| 画面 | 592 | **mx-ui** |

**mx-multiplayer が最終的に持つのは 700 LOC 前後**と見込む。
参照実装の 1,718 LOC からアダプタ・ルール・画面を差し引いた残りである。

## 3. 移植順序

plan.md §6 Step 2 の構築順で mx-multiplayer は mc-sim の後、mc-compose の前に来る。
リポジトリ内部の順序:

1. **プロトコル**(`domain/protocol.ts`)— `schemas.ts` の 18 メッセージ。`timestamp` を落とす
2. **コーデック**(`domain/codec.ts`)— `schemas.test.ts` + `codec.test.ts` を先に移植し、
   ラウンドトリップを green にしてから本体を書く
3. **接続状態機械**(`domain/connection.ts`)— `client-service.test.ts` の遷移期待値から表を起こす
4. **トランスポート Port とループバック**(`domain/transport.ts`)
5. **mc-sim への反映**(受信 → `EntityManager` / `InventoryService` への書き込み)
   — mc-sim 公開後。ここで初めて `@nerima-games/mc-sim` を `dependencies` に足す
6. **stage 登録**(`GameModule` / `StageRegistration`)— mc-kernel の契約型が確定してから

現在は 1〜4 の叩き台までが存在する。

## 4. 移植時の注意

- **`server-handlers.ts`(471 LOC)を丸ごと持ってこない。** このファイルには
  プロトコルディスパッチとゲームルールが混在している。
  `claim-arbitration.test.ts`(99 LOC)が緑になる先は **mx-gameplay** であり、ここではない。
- **`timestamp` フィールドを持ってこない。** 17 箇所の `Date.now()` がそれに紐づいている(DN-3)。
- **`BlockTypeSchema` を import しない。** ワイヤ上は不透明文字列(DN-6)。
- **`ArrayBuffer` を返さない。** コーデックはテキストで止める(DN-4)。
