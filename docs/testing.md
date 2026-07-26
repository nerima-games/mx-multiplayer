# テスト戦略

plan.md §3.14 検証:
> プロトコルのユニットテスト + ループバック同期テスト

## 1. 何をどこで検証するか

| レイヤ | 検証手段 | 現状 |
| --- | --- | --- |
| プロトコル / コーデック | ラウンドトリップ + 不正入力の拒否 | `test/codec.test.ts`(15 tests) |
| 接続ライフサイクル | 状態機械の遷移表。**不正遷移が拒否されること**を含む | `test/connection.test.ts`(11 tests) |
| トランスポート | **ループバック同期テスト**(2 本の実トランスポート) | `test/transport.test.ts`(7 tests) |
| 公開 API | バレルのピン留め + 越境しそうな名前の検査 | `test/public-api.test.ts`(4 tests) |
| 依存境界 | ホワイトリスト・推移閉包・`Date.now()` 禁止 | `test/check-dependency-whitelist.test.ts`(44 tests) |
| プレビューが見つけたもの | 現在の（誤った）挙動の固定 + プレビュー由来の新規チェック | `test/preview-findings.test.ts`(13 tests、§9) |
| セッション全体 | **ローカル 2 クライアントのプレビュー**（フォールト注入つき） | `apps/preview-two-clients/`（§8-9） |
| 実 WebSocket | **ここでは検証しない**。アダプタの責務 | — |
| 画面 | **ここでは検証しない**。mx-ui の責務 | — |
| モジュール間相互作用 | **ここでは検証しない**。mc-compose の E2E が最終ゲート | — |

現在 **120 tests / 7 files**。すべて `pnpm test` で 700ms 前後。

`pnpm verify` はプレビューを**実行しない**。プレビューは完成条件であってゲートではない。
型検査（`tsconfig.preview.json`）と lint（`oxlint … apps`）は掛かる。

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

## 5. ネットワークを実際には使わない

このリポジトリのテストは **1 つもソケットを開かない。**
`pnpm test` は素の Node vitest プール(`environment: 'node'`, `pool: 'forks'`)で走る。

これは Port とアダプタを分けた直接の見返りである。
参照実装は `packages/network` の中にブラウザクライアント・Node サーバ・
`scripts/multiplayer-server.ts` を同居させていたため、
テストが実ソケットとポート番号に依存していた
(`test/node-websocket-server.test.ts` 175 LOC、`test/browser-websocket-client.test.ts` 175 LOC)。

## 6. カバレッジ

計測は常に動いている(`pnpm test:coverage`)が、**閾値は未設定**。

参照実装は 99% を強制しているが、スケルトンに閾値を課しても意味がない
— 型定義だけのモジュール数本で簡単に満たせてしまい、実装について何も言わない。
99% ゲートは完成条件到達時に `vitest.config.ts` と CI の両方で有効化する。

## 7. まだ書いていないテスト

| テスト | 前提 |
| --- | --- |
| ~~`no message schema declares a wall-clock field`~~ | **書いた**（`test/preview-findings.test.ts`）。メッセージ集合の確定を待つ必要は無かった —— 今の `MESSAGE_TAGS` を掃けば今の答えが出るし、集合が増えれば増えたまま答え続ける |
| プロパティテスト(任意の `NetworkMessage` でラウンドトリップ) | `effect/FastCheck` の Arbitrary 生成。`.npmrc` の `fast-check` hoist は既に用意済み |
| mc-sim 反映のシナリオテスト | mc-sim 公開後 |
| プロトコル後方互換テスト(旧バージョンのフレーム fixture) | v2 到達時。fixture は**コミットして凍結**する |
| アダプタの実ソケットテスト | アダプタの所在確定後。**このリポジトリには置かない** |

## 8. ローカル 2 クライアントのプレビュー

plan.md §3.14 が要求する 2 本目の検証手段であり、plan.md §6 Step 2 の完了条件の後半である。
実装は `apps/preview-two-clients/`（[README](../apps/preview-two-clients/README.md)）。

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

初回実行（2026-07-27）は 4 件。**全部 pin 済み。**

| # | 症状 | 場所 |
| --- | --- | --- |
| **M1** | **バージョンがメッセージ形状より後に検査されている。** 新しいビルドから来たフレームは、このビルドのスキーマが受け付けない形を含んだ瞬間に `malformed-frame` になる（実測 3/4） | `domain/codec.ts:89-100` |
| **M2** | `ConnectionState.Connecting.attempt` は常に 1。生成箇所は 2 つだけで、どちらもリテラルを書く。export されており `api-lock.md` にも載っている | `domain/connection.ts:80`, `:116` |
| **M3** | 決着した接続が、実際のソケットが次に届けるイベント（書き込み失敗の後の close、Disconnect の 2 度押し）を「不正」として拒否する | `domain/connection.ts:113-121` |
| **M4** | 「Connected からしか送れない」を強制するものが無い。`canSend` は export されていてリポジトリ内のどこからも呼ばれていない | `domain/connection.ts:59` / `domain/transport.ts:53-60` |

### M1 —— なぜ既存の 2 本が通ってしまうのか

DN-1 の設計は「バージョンはメッセージの**外側**に置く。内側に置くと、未知バージョンのフレームを
弾くためにまず『もう存在しないかもしれないメッセージ形状』をパースする必要が生じるため」である。
`Frame = { protocolVersion, message }` は確かに外側に置いている。しかし `decodeFrame` は
`Frame` を**まるごと**（`message: NetworkMessage` を含めて）構造デコードし、
バージョン比較はその**後**である。つまり「メッセージ形状を先にパースする」を回避できていない。

2 つの判定は交換可能ではない。DN-1 は前者に「フレームを捨てる」、後者に
「**ピア**を切ってユーザにそう伝える」を割り当てている。
**ローリングアップグレード —— DN-1 が存在する唯一の理由 —— が「パケットが壊れています」として出る。**

既存の 2 本が通るのは、どちらも **v+1 のエンベロープに「このビルドが知っているメッセージ」を包む**からである
（`SAMPLES.Ping` と `SAMPLES.PlayerLeave`）。
**メッセージを 1 つも変えないバージョン上げ**が唯一うまくいくケースであり、
それは最も起こりそうにないケースである。

### M3・M4 —— なぜ単体テストからは見えないのか

- **M3**: `test/connection.test.ts` は遷移表を単体で網羅するが、
  **アダプタが実際に生む列**（`TransportFailed` → `PeerClosed`）を 1 つも通していない。
  2 クライアントを回してトランスポートを殺すと 1 回で出る。
  `--fault kill-transport --fault-at 1 --view machine` は、1 本の死んだソケットに対して
  `REJECTED` を 5 行連続で出す。
- **M4**: `test/transport.test.ts` は `ConnectionState` を import していない。
  トランスポートのテストと状態機械のテストが別ファイルにあるので、
  **その 2 つをまたぐ主張**（`domain/connection.ts:59` のコメント）を検査する場所が
  どこにも無かった。

### 合格したまま残しているチェック

DN-2 / DN-3 / DN-5 / DN-6 / DN-7 とラウンドトリップの 6 つ。うち 3 つはテストにも落としてあり、
**2 つはこれまで assertion が無かった**:

- 「**不正値は送信側で落ちる**」—— DN-5 の主張（「失敗するのは送信側の `encodeFrame` であり、
  原因が手元にある」）が成り立つのは `Schema.encodeEither` が encode 方向でも refinement を
  検査するからで、それは**スキーマの性質ではなくコーデックの性質**である。
  ラウンドトリップテストからは見えない。
- 「**知らないフィールドは無視される**」—— DN-6 の前方互換の半分。
  今は `Schema` の既定（`onExcessProperty: 'ignore'`）であって決定ではないので、
  将来 `'error'` に変えると前方互換フレームが全部パースエラーになり、何も検知しない。
