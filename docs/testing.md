# テスト戦略

plan.md §3.14 検証:
> プロトコルのユニットテスト + ループバック同期テスト

## 1. 何をどこで検証するか

| レイヤ | 検証手段 | 現状 |
| --- | --- | --- |
| プロトコル / コーデック | ラウンドトリップ + 不正入力の拒否 | `test/codec.test.ts` |
| 接続ライフサイクル | 状態機械の遷移表。**不正遷移が拒否されること**を含む | `test/connection.test.ts` |
| トランスポート | **ループバック同期テスト**(2 本の実トランスポート) | `test/transport.test.ts` |
| 公開 API | バレルのピン留め + 越境しそうな名前の検査 | `test/public-api.test.ts` |
| サーバー側 command application | mc-sim service への反映と拒否 | `test/command-application.test.ts` |
| プレビューが見つけたもの | 設計上の finding の測定 + プレビュー由来の新規チェック | `test/preview-findings.test.ts` |
| セッション全体 | **ローカル 2 クライアントのプレビュー**（フォールト注入つき） | `apps/preview-two-clients/`（§8-9） |
| シナリオ catalog / determinism | 同じ seed での scenario 結果を比較 | `test/scenarios/catalog.test.ts`。個別実行は `pnpm exec vitest run test/scenarios/catalog.test.ts` |
| Verification matrix | message tag と angle ごとの status・evidence を検査 | `test/verification-matrix.test.ts`。個別実行は `pnpm exec vitest run test/verification-matrix.test.ts` |
| Protocol property test | schema 由来の message の codec round-trip と拒否条件 | `test/protocol-property.test.ts`。個別実行は `pnpm exec vitest run test/protocol-property.test.ts` |
| Wire fixtures | 現行・旧 wire frame の bytes と decode 結果 | `test/wire-fixtures.test.ts`。個別実行は `pnpm exec vitest run test/wire-fixtures.test.ts` |
| 実 WebSocket | local HTTP server と実 WebSocket client を使う transport harness | `test/websocket-harness.test.ts`。`pnpm test` に含まれる |
| Browser transport | `FakeSocket` による adapter test | `test/browser-transport.test.ts`。`pnpm test` に含まれる |
| Browser UI | Chromium で Debug UI の操作を検査 | `test-browser/`。`pnpm test:browser` |
| 製品画面 | mx-multiplayer の責務外。開発用 Debug UI の browser test は §10 | mx-ui が所有 |
| モジュール間相互作用 | **ここでは検証しない**。mc-compose の E2E が最終ゲート | — |

`test/` 以下の Vitest test は `pnpm test` で実行する。変動するテスト数はこの文書に重複して書かない。

Verification matrix の status は [test/matrix/index.ts](../test/matrix/index.ts) で定義する。`covered` は test reference あり、`excluded` は対象外の理由あり、`pending` は未完了、`blocked-on-mc-sim` は mc-sim 依存で停止中、`gap` は対象だが mx-multiplayer の経路が無い状態で理由と evidence を記録する。test は manifest の構造と evidence を検査する。status の件数は固定して記載しない。

`pnpm verify` は CLI preview と Debug UI を**実行しない**。typecheck は `tsconfig.preview.json`、`tsconfig.scenarios.json`、`tsconfig.debug-ui.json` を含み、lint は `apps/`、`scenarios/`、`test-browser/` も対象にする。Browser specs と coverage は別コマンドである。

## 2. 主 API は `@effect/vitest` の `it.effect`

```typescript
import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'

it.effect('...', () =>
  Effect.gen(function* () {
    const [client, server] = yield* makeLoopbackPair
    ...
  }),
)
```

純粋な検査でも `Effect.sync(() => { ... })` で包む。
Effect ランタイム上で走ることを既定にしておくと、後から Layer や fiber が必要になったときに
テストの書き換えが要らない。

> **例外**(参照実装で確立、plan.md §3.13): DOM イベントフローのテストで
> `Effect.fork` + `Deferred.await` を `it.effect` の中に書くとデッドロックする。
> その場合はプレーンな `it` + `Effect.runPromise` を使う。
> mx-multiplayer は DOM を持たないので現状該当しないが、
> ループバックで fork を使う日が来たら思い出すこと。

## 3. ループバック同期テストの設計

**ペアであってエコーではない。**

```typescript
const [client, server] = yield* makeLoopbackPair
yield* sendMessage(join).pipe(Effect.provide(LoopbackTransportLayer(client)))
const received = yield* receiveMessage.pipe(Effect.provide(LoopbackTransportLayer(server)))
expect(received).toStrictEqual(join)
```

理由:

1. **エンコードとデコードが両方走る。** Port が運ぶのは `WireText` なので、
   ループバックであっても本当に文字列化される。
   Port が `NetworkMessage` を運んでいたら、コーデックのバグは 1 つもここに現れない。
   これを保証するテストが `really serialises: what crosses the queue is protocol text, not the original object` である。
2. **2 つの Effect に別々の端を渡せる。** 一方をクライアント、他方をサーバとして振る舞わせられる。
3. **エコーでは片側にしか存在しないメッセージを扱えない。**

## 4. テストは「名前付き回帰」として書く

[design-notes.md](./design-notes.md) の各項目には**回帰テスト名**が付いている。
テストの `it` 名はそのまま参照実装で起きた事象を指すようにする。

```typescript
// REGRESSION: "JSON.stringify(NaN) === 'null'". これが全座標に finite() を付ける理由。
it.effect('rejects a coordinate that arrived as null, which is what a NaN turns into over JSON', ...)
```

コメントの `REGRESSION:` に**なぜそれが問題なのか**を書く。
「どう動くか」はコードが言うので、テストが言うべきは「壊れたときに何が起きるか」である。

## 5. ループバックと実 WebSocket のテスト

ループバック同期テストはソケットを開かず、Port が運ぶ `WireText` の encode/decode を検査する。一方、[test/websocket-harness.test.ts](../test/websocket-harness.test.ts) は local HTTP server の WebSocket upgrade を受け、Node の実 WebSocket client から接続する。frame、heartbeat、timeout、queue / rate limit、fuzz の経路を検査する。[test/browser-transport.test.ts](../test/browser-transport.test.ts) は `FakeSocket` を使い、network socket は開かない。

`pnpm test` は Node Vitest pool (`environment: 'node'`, `pool: 'forks'`) で走るが、WebSocket harness は localhost socket を開く。

Port と loopback を分けたテストでは socket に依存しない。実 WebSocket adapter も別の harness で検査する。
参照実装は `<reference-impl>/packages/network` の中にブラウザクライアント・Node サーバ・
`<reference-impl>/packages/network/scripts/multiplayer-server.ts` を同居させていたため、
テストが実ソケットとポート番号に依存していた
(`<reference-impl>/packages/network/test/node-websocket-server.test.ts` 175 LOC、
`<reference-impl>/packages/network/test/browser-websocket-client.test.ts` 175 LOC)。

## 6. カバレッジ

計測は `pnpm test:coverage` で実行する。coverage 対象は `src/**/*.ts`。**閾値は 4 指標(branches/functions/lines/statements)とも
100% で有効**(`vitest.config.ts` の `coverage.thresholds` と plan.md §2.2/§2.8)。
CI では `Coverage` step が同じコマンドを実行し、非ゼロ終了でゲートになる。

## 7. まだ書いていないテスト

| テスト | 前提 |
| --- | --- |
| ~~`no message schema declares a wall-clock field`~~ | **書いた**（`test/preview-findings.test.ts`）。メッセージ集合の確定を待つ必要は無かった —— 今の `MESSAGE_TAGS` を掃けば今の答えが出るし、集合が増えれば増えたまま答え続ける |
| mc-sim 反映のシナリオテスト | `test/command-application.test.ts` |

schema 由来の property test は [test/protocol-property.test.ts](../test/protocol-property.test.ts)、旧・現行 wire fixture は [test/wire-fixtures.test.ts](../test/wire-fixtures.test.ts)、実 WebSocket harness は [test/websocket-harness.test.ts](../test/websocket-harness.test.ts) にある。各 command は §1 を参照。

## 8. ローカル 2 クライアントのプレビュー

plan.md §3.14 が要求する 2 本目の検証手段であり、plan.md §6 Step 2 の完了条件の後半である。
実装は `apps/preview-two-clients/`（[README](../apps/preview-two-clients/README.md)）。

これは terminal CLI preview であり、ブラウザの Debug UI (`apps/debug-ui/`) とは別アプリである。Debug UI の起動と panel は [README.md](../README.md) を参照。

```console
$ pnpm preview                          # 対話モード。SPACE で 1 ステップ
$ pnpm preview --stats                  # 測定レポート
$ pnpm preview --once --ascii --script  # 正常セッション 1 枚
$ pnpm preview --once --ascii --script --fault kill-transport --fault-at 1 --view machine
```

1 プロセスの中に 2 つのピアがいて `makeLoopbackPair` で配線されており、
15 ステップのハンドシェイクを 1 キーストロークずつ進める。
**フレームは本物**（`encodeFrame` → `WireText` → `decodeFrame`）で、
**状態も本物**（`transition` の戻り値）である。アプリが足しているのは、
このリポジトリが持つべきでない 2 つだけ —— セッションの台本（DN-8 が方針を持たないので誰かが要る）と、
**フォールトインジェクタ**である。

**面白いのはフォールトのほうである。** 正常なハンドシェイクはスクリーンショット 1 枚の価値しかない。
アプリ 1 本の価値があるのは、「テストでは到達しにくく、本物のピア相手には手では到達できない」経路のほうで、
DN-8 自身がそれを「不安定な回線でしか再現しないため、テストに乗らない」と書いている。

| wire フォールト | 突くもの |
| --- | --- |
| `drop` | 送り手はロストを知り得ない（ack メッセージが `MESSAGE_TAGS` に無い） |
| `corrupt` | DN-2 の `malformed-frame` 経路 |
| `wrong-version` | DN-1 の `unsupported-protocol-version` 経路 |
| `future-message` | **DN-1 の本題。** 新しいビルドが実際に送るであろうフレーム（このビルドの union に無いタグ） |
| `kill-transport` | ハンドシェイク中にソケットが死ぬ。DN-8 の `TransportFailed` 経路 |

machine フォールトは `a`〜`z` で、DN-8 が名指しする 3 本
（ハンドシェイク中の 2 度目の `ConnectRequested` / `RetryRequested` 経由でしか Connecting に戻れないこと /
タイマーを持たないこと）をその場で撃てる。

## 9. プレビューが見つけたもの

`pnpm preview --stats` は 10 個のチェックを**実行時に測定**する。期待値は 1 つも記録していないので、
**直すと finding は「固定される」のではなく静かに消える**。だから確認できたものは
`test/preview-findings.test.ts` に assertion として落としてある —— レポートは読まれなければ効かないが、
テストは落ちる。チェック自体は合格後も残してある。合格したら消すチェックは、コードを 1 回しか検査しない。

現在の実行では M2 / M3 / M-clock の 3 件を finding として報告し、M1 / M4 は解消済みである。

| # | 症状 | 場所 |
| --- | --- | --- |
| **M1 (解消済み)** | opaque envelope を先に decode し、message shape より前に protocol version を検査する | `src/domain/codec.ts` / `test/codec.test.ts` |
| **M2** | `ConnectionState.Connecting.attempt` は共有された初期値から常に 1 になる | `src/domain/connection.ts` |
| **M3** | 決着した接続が、実際のソケットが次に届けるイベント（書き込み失敗の後の close、Disconnect の 2 度押し）を「不正」として拒否する | `src/domain/connection.ts:113-121` |
| **M4 (解決済み)** | `connectionGatedTransport` が各 send 時に現在状態を読み、`Connected` 以外を typed `TransportError` で拒否する | `src/domain/transport.ts` / `test/transport.test.ts` |

### M1 —— opaque envelope による version 先行検査

DN-1 の設計は「バージョンはメッセージの**外側**に置く。内側に置くと、未知バージョンのフレームを
弾くためにまず『もう存在しないかもしれないメッセージ形状』をパースする必要が生じるため」である。
`Frame = { protocolVersion, message }` は外側に置かれている。`decodeFrame` はまず
`message` を `Schema.Unknown` とした opaque envelope を decode し、protocol version を検査する。
対応する version のときだけ `message` を `NetworkMessage` として decode するため、
未知の message shape が version mismatch を隠さない。

2 つの判定は交換可能ではない。DN-1 は前者に「フレームを捨てる」、後者に
「**ピア**を切ってユーザにそう伝える」を割り当てている。既知・未知の message shape の
両方で version mismatch を先に返すことを `test/codec.test.ts` で検証している。

### M3・M4 —— なぜ単体テストからは見えないのか

- **M3**: `test/connection.test.ts` は遷移表を単体で網羅するが、
  **アダプタが実際に生む列**（`TransportFailed` → `PeerClosed`）を 1 つも通していない。
  2 クライアントを回してトランスポートを殺すと 1 回で出る。
  `--fault kill-transport --fault-at 1 --view machine` は、1 本の死んだソケットに対して
  `REJECTED` を 5 行連続で出す。
- **M4 (解決済み)**: `test/transport.test.ts` が可変な `ConnectionState` と transport を組み合わせ、
  `Connecting` / `Closed` では未配送、`Connected` では配送されることを同じテストで検査する。

### 合格したまま残しているチェック

DN-2 / DN-3 / DN-5 / DN-6 / DN-7 とラウンドトリップの 6 つ。うち 3 つはテストにも落としてあり、
**2 つはこれまで assertion が無かった**:

- 「**不正値は送信側で落ちる**」—— DN-5 の主張（「失敗するのは送信側の `encodeFrame` であり、
  原因が手元にある」）が成り立つのは `Schema.encodeUnknownResult` が encode 方向でも refinement を
  検査するからで、それは**スキーマの性質ではなくコーデックの性質**である。
  ラウンドトリップテストからは見えない。
- 「**知らないフィールドは無視される**」—— DN-6 の前方互換の半分。
  今は `Schema` の既定（`onExcessProperty: 'ignore'`）であって決定ではないので、
  将来 `'error'` に変えると前方互換フレームが全部パースエラーになり、何も検知しない。

## 10. ブラウザ仕様テスト

`pnpm test:browser` は [test-browser/](../test-browser/) の `*.spec.ts` を Playwright の Chromium project で実行する。設定は [playwright.config.ts](../playwright.config.ts) にあり、`pnpm preview:browser` で Vite Debug UI を loopback 上に起動する。`HARNESS_PORT` の既定値は `5182`。既存 server は再利用しない。これは開発用 Debug UI の browser test であり、`pnpm verify` には含まれない。
