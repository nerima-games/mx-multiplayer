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
| 実 WebSocket | **ここでは検証しない**。アダプタの責務 | — |
| 画面 | **ここでは検証しない**。mx-ui の責務 | — |
| モジュール間相互作用 | **ここでは検証しない**。mc-compose の E2E が最終ゲート | — |

現在 **81 tests / 5 files**。すべて `pnpm test` で 500ms 前後。

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
| `no message schema declares a wall-clock field` | メッセージ集合の確定 |
| プロパティテスト(任意の `NetworkMessage` でラウンドトリップ) | `effect/FastCheck` の Arbitrary 生成。`.npmrc` の `fast-check` hoist は既に用意済み |
| mc-sim 反映のシナリオテスト | mc-sim 公開後 |
| プロトコル後方互換テスト(旧バージョンのフレーム fixture) | v2 到達時。fixture は**コミットして凍結**する |
| アダプタの実ソケットテスト | アダプタの所在確定後。**このリポジトリには置かない** |
