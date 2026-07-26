# 設計注意(参照実装の実測知見)

参照実装 `takeokunn/ts-minecraft` を**仕様書兼テストオラクル**として読み、
再発させてはならない事象を抽出したもの。

**各項目は「名前付き回帰テスト」として書いてある。**
文章として読んで納得するためではなく、テストファイルにそのまま落とせる形にするためである。
すでにテストがあるものは実ファイルを、まだのものは `未実装` を記す。

参照実装のパスは `<reference-impl>` 起点。
行番号は本ドキュメント作成時点(2026-07-26)のもの。

---

## DN-1: フレームはバージョン付きエンベロープを持つ

**回帰テスト名**: `rejects a frame from a version this build does not speak, and says so specifically`
**実装**: `test/codec.test.ts`(実装済み)

**根拠**: 参照実装のプロトコルには**バージョンフィールドが存在しない**。

```console
$ grep -rn 'protocolVersion\|version' packages/network --include='*.ts' | grep -v test
(出力なし)
```

`packages/network/domain/schemas.ts:88-91` の `BaseNetworkMessageSchema` は
`type` と `timestamp` の 2 フィールドだけで、バージョンを持たない。

**何が問題か**: ローリングアップグレード(サーバだけ先に新しくなった、片方のブラウザがキャッシュで古い)が
**破損フレームと区別できない**。`deserializeNetworkMessage`
(`packages/network/domain/schemas.ts:357-380`)は両方を
`NetworkError { operation: 'deserialize' }` にまとめてしまうため、
「相手が古い」と「パケットが壊れた」がログ上で同じに見える。

**本実装での対処**: `Frame = { protocolVersion, message }` を必ず通す。
バージョンはメッセージの**外側**に置く。内側に置くと、未知バージョンのフレームを弾くために
まず「もう存在しないかもしれないメッセージ形状」をパースする必要が生じるため。
デコードは 2 種類の失敗を最後まで分ける:

- `malformed-frame` — フレームを捨てる
- `unsupported-protocol-version` — **ピア**を切り、ユーザにそう伝える

---

## DN-2: `ProtocolError` と `TransportError` を統合しない

**回帰テスト名**: `keeps the two failure channels distinguishable at the call site`
**実装**: `test/transport.test.ts`(実装済み)

**根拠**: 参照実装は単一の `NetworkError` に両方を詰めている。

`packages/network/domain/errors.ts:11-19`:

```typescript
export class NetworkError extends Data.TaggedError('NetworkError')<{
  readonly operation: 'serialize' | 'deserialize' | 'start' | 'stop' | 'send' | 'connect' | 'disconnect' | 'receive' | 'capacity' | 'dispatch'
  readonly reason: string
  readonly cause?: unknown
}> { ... }
```

`operation` に `serialize`/`deserialize`(= 意味の問題)と
`send`/`connect`/`disconnect`(= 到達の問題)が同居している。

**何が問題か**: 正しい対応が真逆であるものが同じ型になる。

| 種別 | 正しい対応 | 間違えた場合 |
| --- | --- | --- |
| プロトコル(意味) | フレームまたはピアを捨てる。**再送は無意味** | 壊れたパケットで再接続ループに入る |
| トランスポート(到達) | **再送・再接続が正解**。メッセージ自体は有効 | 有効なメッセージを捨てる |

呼び出し側が `operation` 文字列からこの区別を毎回導出する構造では、
どこか 1 箇所で必ず間違える。

**本実装での対処**: `ProtocolError` と `TransportError` を別クラスにし、
`sendMessage` のエラーチャネルを `ProtocolError | TransportError` にする。
どちらを握り潰したかが型に出る。

---

## DN-3: プロトコルスキーマに壁時計を入れない

**回帰テスト名**: `Ping/Pong carry a nonce, not a timestamp` (`test/codec.test.ts` のラウンドトリップで担保)
**追加すべきテスト**: `no message schema declares a wall-clock field`(未実装 — メッセージ集合が確定してから)

**根拠**: 参照実装は**全メッセージ**に `timestamp` を必須で持たせている。

`packages/network/domain/schemas.ts:85-91`:

```typescript
export const TimestampSchema = Schema.Number.pipe(Schema.finite(), Schema.nonNegative())
export const BaseNetworkMessageSchema = Schema.Struct({
  type: MessageTypeSchema,
  timestamp: TimestampSchema,
})
```

そしてそれを埋めるのは `Date.now()` である。実測:

```console
$ grep -rn 'Date\.now()' packages/network --include='*.ts' | grep -v '/test/' | wc -l
17
```

内訳: `application/client-service.ts`(1)、`application/server-service.ts`(1)、
`application/server-handlers.ts`(15)。
`server-handlers.ts:91` と `:187` では時刻差から時間帯を計算している:

```typescript
? (sessionTimeOfDay + (Date.now() - capturedAtMs) / (dayLenSecs * 1000)) % 1
```

**何が問題か**: plan.md §4.3 は「クロック Port — 決定論・fast-forward の要。`Date.now()` 直接参照禁止」
と定めている。ところが**スキーマが必須フィールドとして壁時計を要求している限り、この禁止は守れない**。
禁止を守るには、そのフィールドを埋める全 17 箇所に Port を注入する必要があり、
「1 箇所の違反」ではなく「スキーマ設計に起因する構造的な違反」になる。

さらに実害として、壁時計は NTP・DST・ユーザの時刻変更で**逆行しうる**。
それをメッセージ順序や経過時間の根拠に使うと、リプレイは再現せず、
時刻を巻き戻したクライアントは未来のメッセージを送りつけることになる。

**本実装での対処**:

1. **タイムスタンプをプロトコルから外す。** `Ping`/`Pong` は `nonce: int` で対応付ける。
   往復時間を測るのは呼び出し側であり、注入された `ClockPort` の `monotonicSecs` を
   待ちの前後で読んで差を取る。
2. 永続化や人間向け表示のために時刻が本当に必要になったら、
   `ClockPort.wallClockEpochMillis` を読んだ値を**明示的なフィールドとして**乗せる。
   暗黙のベースフィールドにはしない。
3. `pnpm check:deps` が `Date.now()` / `new Date()` / `performance.now()` を
   このリポジトリ全体で禁止する(oxlint 0.12 は表現できないためスクリプト側で実装)。

---

## DN-4: コーデックはテキストで止め、バイト列にしない

**回帰テスト名**: `produces text — the codec stops at a string, so no platform global is needed`
**実装**: `test/codec.test.ts`(実装済み)

**根拠**: 参照実装の `packages/network/application/codec.ts`(全 34 LOC)は
`ArrayBuffer` を返すため `TextEncoder` / `TextDecoder` に手を伸ばしている。

```typescript
const encoder = new TextEncoder()
const decoder = new TextDecoder()
```

**何が問題か**: `TextEncoder` は言語の機能ではなくプラットフォームのグローバルである。
これによりコーデックのテストがプラットフォーム付き環境を要求し、
プロトコル層がランタイムに固定される。

**本実装での対処**: ドメインのコーデックは**テキストまで**。
バイト列化(UTF-8・圧縮・長さプレフィックス)はアダプタの仕事とする。
効果は具体的で、`tsconfig.build.json` は `lib: ["ES2024"]` / `types: []` でコンパイルされる
— DOM も Node も無い。プロトコル変更が黙ってプラットフォーム依存を獲得することが型レベルで不可能になる。

---

## DN-5: 数値スキーマに `finite()` / `int()` を必ず付ける

**回帰テスト名**: `rejects a coordinate that arrived as null, which is what a NaN turns into over JSON`
**実装**: `test/codec.test.ts`(実装済み)

**根拠**: 参照実装は正しくやっている。`packages/network/domain/schemas.ts:23-27`:

```typescript
export const Vec3Schema = Schema.Struct({
  x: Schema.Number.pipe(Schema.finite()),
  ...
})
```

**なぜ明文化するか**: `JSON.stringify(NaN)` は文字列 `"null"` である。
制約の無い `Schema.Number` を使うと、送信側のゼロ除算で生まれた `NaN` は
**受信側のデコード失敗**として現れる。そこにはもう発生源のコードが無い。
`finite()` があれば、失敗するのは送信側の `encodeFrame` であり、原因が手元にある。

同じ理屈で、ブロック座標には `int()` を付ける。

---

## DN-6: ブロック種別はワイヤ上で不透明文字列にする

**回帰テスト名**: `accepts a block name this build does not know, because content skew is not frame corruption`
**実装**: `test/codec.test.ts`(実装済み)

**根拠**: 参照実装の `packages/network/domain/schemas.ts:1` は
`BlockTypeSchema` を `@ts-minecraft/core` から import してワイヤスキーマに直接使っている。

**何が問題か**: 自分より新しいビルドのピアが、こちらの知らないブロックを置いたとき、
**フレーム全体がパースエラーになる**。「相手のクライアントが新しい」が「パケットが壊れている」になる。

**本実装での対処**: ワイヤ上は `Schema.String.pipe(Schema.minLength(1))`。
未知のブロック名は**デコードには成功**し、その後「未知のコンテンツ」として mc-sim 側で扱う。
フレーム構造の問題とコンテンツ差分の問題を分ける。

---

## DN-7: 姿勢の pitch は ±π/2 に制約する

**回帰テスト名**: `rejects a pitch outside the range a head can actually turn`
**実装**: `test/codec.test.ts`(実装済み)

**根拠**: 参照実装 `packages/network/domain/schemas.ts:37-41` の
`NetworkRotationSchema` は `yaw` / `pitch` ともに `finite()` のみ。

**何が問題か**: 範囲外の pitch は「プレイヤーが取りうる姿勢」ではない。
通してしまうと、ピアのアバターが逆さまに表示されるという**誰もプロトコルのバグとして報告しない不具合**になる。
plan.md §3.8 の「物が浮くバグ類は例外なく足元原点 vs AABB 中心の Y 規約不一致が原因」と同じ構造で、
**表現できてしまう不正な値**が症状として現れる。

---

## DN-8: 接続の再試行は状態機械の外に置く

**回帰テスト名**:
- `rejects a second ConnectRequested while a handshake is in flight`
- `re-enters Connecting only through RetryRequested, never through ConnectRequested`
- `holds no timer, no schedule and no attempt budget — retry policy lives in the adapter`

**実装**: `test/connection.test.ts`(実装済み)

**根拠**: 参照実装には接続ライフサイクルを表す型が無く、
`packages/network/application/client-service.ts` が接続状態を暗黙に扱っている。

**何が問題か**: 「接続管理」は、合法遷移を書き下ろさない限り
`isConnected` + `isConnecting` + リトライカウンタに退化する。そうなると
`connecting && connected` や「ハンドシェイク進行中に disconnected」といった
**あってはならない状態が表現可能**になり、その帰結は再接続ストームである
— 不安定な回線でしか再現しないため、テストに乗らない。

**本実装での対処**:

1. `transition(state, event)` が不正イベントに対して `undefined` を返す。
   現状態をそのまま返すと「何もすることが無い」と「筋の通らない要求」が区別できず、
   状態機械が助言的なものになる。
2. 再試行は `RetryRequested` という**別イベント**。`ConnectRequested` を使い回すと、
   ユーザが Join を押したのかスケジュールが発火したのかを機械が区別できない。
3. **タイマーもスケジュールも試行回数上限も持たない。** どの状態へ行けるかだけを言う。
   待ち時間と回数は `Schedule` であり、ソケットを所有するアダプタのものである。

---

## DN-9: ゲームルールをネットワーク層に置かない

**回帰テスト名**: `exports nothing that sounds like a screen, a view or a renderer`(弱い代替)
**本来必要なテスト**: レビュー規範。機械化は困難

**根拠**: `packages/network/application/server-handlers.ts:288-330` に
**先着優先の claim 調停**が実装されている。コメント(`:304`)がそのまま設計判断を述べている:

> 最初の claim が勝ち、後続の claimer には `ClaimDenied` を返してローカルの pickup を巻き戻させる

**何が問題か**: 「競合した pickup で誰が勝つか」はネットワークの都合ではなくインベントリの都合である。
これが `server-handlers.ts`(全 470 行超)に居ることで、
**ルールを変えるためにネットワーク層を触る**という依存が生まれる。
これは plan.md §3.15 が mc-compose について警告している「合成層へのロジック堆積」と同型の問題が
体験モジュールで起きている状態である。

**本実装での対処**: `ClaimDenied` に相当するメッセージは**プロトコルとして持ってよい**が、
**誰を deny するかを決めてはならない**。決定は mc-sim(状態の正)と mx-gameplay(ルール)が行い、
mx-multiplayer はその決定を運ぶ。

---

## 未検証・要調査

| 項目 | 状態 |
| --- | --- |
| メッセージ集合の完全版(参照実装 18 種)をそのまま採るか | 未決。`EntitySnapshot` の粒度は性能実測が要る |
| スナップショット vs デルタ同期 | 未決。参照実装は `EntitySnapshot` の全量送信 |
| 権威モデル(サーバ権威 / ロックステップ) | 未決。参照実装はサーバ権威寄りだが明文化されていない |
| フレーム分割・バッチング | 未決。現在は 1 フレーム 1 メッセージ |
| プロトコルの後方互換ポリシー | [versioning.md](./versioning.md) に暫定案。API ロック開始まで確定しない |
