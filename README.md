# @nerima-games/mx-multiplayer

## 責務

ネットワーク同期の **トランスポートとプロトコルだけ** を持つ(plan.md §3.14)。

サーバ一覧・接続ダイアログ・ロスター表示といったマルチプレイヤー**画面**は mx-ui の所有物であり、
ここには無い。詳細は [docs/responsibility.md](./docs/responsibility.md)。

## 依存

実行時依存は `@nerima-games/mc-sim` **ただ 1 つ**(加えて `@nerima-games/mc-kernel` は
どこからでも import 可)。mx-gameplay / mx-redstone / mx-ui へのエッジはゼロである
— 体験モジュールは互いを知らない(plan.md §2.3-1)。

**mc-sim を経由して到達できる mc-physics / mc-worldgen / mc-save の import は禁止**である。
`pnpm check:deps` が `transitive-import` として非ゼロ終了する。

> **現状**: `package.json` の `dependencies` は `effect` のみ。
> ロスター全体が未公開のため(ボトムアップの publish-then-pin、plan.md §6 Step 3)、
> 依存契約は `scripts/check-dependency-whitelist.ts` の `REPOSITORY_POLICY` 側にだけ宣言してある。
> 詳細は [docs/versioning.md](./docs/versioning.md) §3。

## ドキュメント

**[docs/](./docs/) に実装情報がある。実装前に読むこと。**

| ドキュメント | 内容 |
| --- | --- |
| [docs/README.md](./docs/README.md) | 索引と読む順番 |
| [docs/architecture.md](./docs/architecture.md) | 4 階層、16 リポジトリ依存グラフ、本リポジトリの位置 |
| [docs/responsibility.md](./docs/responsibility.md) | 持つもの / 持たないもの。mx-ui との境界 |
| [docs/public-api.md](./docs/public-api.md) | 公開 API と契約 |
| [docs/design-notes.md](./docs/design-notes.md) | 参照実装の実測知見(回帰テスト名付き)。**必読** |
| [docs/porting.md](./docs/porting.md) | 移植計画。LOC はすべて実測値 |
| [docs/testing.md](./docs/testing.md) | テスト戦略 |
| [docs/versioning.md](./docs/versioning.md) | 0.x → 1.0.0、GitHub Packages、プロトコルバージョン |

## 依存ルール(16 リポジトリ共通)

| ルール | 内容 |
| --- | --- |
| ハード失敗 | 違反があれば CI は必ず非ゼロ終了する。警告で済ませない |
| 循環禁止 | 循環依存は一切許可しない。「co-evolution ペア」のような例外リストは設けない |
| 推移閉包の禁止 | A→B、B→C のとき A は C を import できない。依存は直接依存のみが import 許可を意味する |
| kernel は例外 | mc-kernel はどこからでも import 可 |
| 宣言と実体の一致 | import する `@nerima-games/*` は `package.json` に記載されていなければならない |
| mc-playground-kit は devDependency 専用 | `dependencies` に入れてはならない。実行時依存になると、出荷ビルドから入力処理が消える |
| `Date.now()` 禁止 | 時刻はすべて注入された Clock Port から取得する |

`scripts/check-dependency-whitelist.ts` は 16 リポジトリ共通のテンプレートである。
姉妹リポジトリへ移植する際は、ファイル冒頭で囲ってある `REPOSITORY_POLICY` 定数だけを書き換えればよい。
それ以外の部分はそのままコピーする。

### `Date.now()` 禁止の実装方法

oxlint 0.12 は `no-restricted-syntax` も `no-restricted-properties` も実装しておらず、
`no-restricted-globals` は `oxlint --rules` の一覧に出るものの実装されていない
(0.12.0 で実測確認済み)。

そのため禁止は **`scripts/check-dependency-whitelist.ts` 側で実装**している。
対象は `Date.now()` / `new Date()` / `performance.now()` の 3 つ。
コメント・文字列リテラル・正規表現リテラルの中身はマスクされるので誤検知しない。

Clock Port の実装アダプタ自身だけは実クロックを読む必要があるため、
その行に `mc-kernel-allow-time-source` コメントを付けると除外される。

参照実装の `packages/network` はこの禁止を**構造的に破っていた**
— 全メッセージが必須 `timestamp` を持ち、それを 17 箇所の `Date.now()` が埋めていた。
[docs/design-notes.md](./docs/design-notes.md) DN-3 を参照。

## 開発

### セットアップ

```console
$ direnv allow          # flake.nix の devShell で nodejs_22 + corepack が入る
$ pnpm install
```

Nix を使わない場合は Node.js 22 以上と pnpm 9.15.0(`corepack` 推奨)を用意する。

> **注意**: ツールチェーンは `devenv.nix` から `flake.nix` + `flake.lock` に移行済みである。
> `flake.lock` はコミットされているので、`nix develop`（`.envrc` は `use flake`）は
> 誰の手元でも同じ nixpkgs に解決される。`devenv.nix` / `devenv.lock` はもう存在しない。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json` と `tsconfig.test.json` の両方を型検査 |
| `pnpm lint` | oxlint(このリポジトリ唯一の lint / format 設定。prettier も biome も .editorconfig も置かない)。**`--deny-warnings` 付きで走る**ため、`warn` のルールもビルドを落とす（`oxlint.json` は 5 カテゴリすべてと個別 67 ルールが `warn`、`error` は 4 つだけ。このフラグが無かった頃は実質その 4 つしかゲートになっていなかった） |
| `pnpm lint:fix` | oxlint の自動修正 |
| `pnpm test` | vitest(`@effect/vitest` の `it.effect` が主 API) |
| `pnpm test:watch` | vitest watch |
| `pnpm test:coverage` | カバレッジ計測(閾値は未設定) |
| `pnpm check:deps` | 依存ホワイトリスト + 循環検査 + `Date.now()` 禁止の検査 |
| `pnpm verify` | `typecheck && lint && check:deps && test`。CI と同じ内容 |

## 現状

**このリポジトリはまだ叩き台(pre-audit first cut)である。** 以下は確定事項ではない。

- **メッセージ集合は代表的な 9 種のみ。** 参照実装の 18 種は再現していない
  ([docs/porting.md](./docs/porting.md) 参照)
- **`GameModule` / `StageRegistration` の実装がまだ無い。** mc-kernel の契約型
  (特に `FrameServices`)がプレースホルダのため
- **mc-sim への状態反映がまだ無い。** mc-sim 公開後
- **実 WebSocket アダプタが無い。** `TransportPort` の実装はプラットフォーム層に置く。
  現在あるのはループバック(テスト用)と `disconnectedTransport` のみ
- **ビルド / publish がまだ無い。** `package.json` の `exports` は TypeScript ソースを直接指している
- **カバレッジ閾値は未設定。** 99% ゲートは完成条件到達時に有効化する

確定しているのは**仕組み**のほうである: バージョン付きエンベロープ、テキストで止まるコーデック、
`ProtocolError` と `TransportError` の分離、リトライ方針を持たない接続状態機械。

## License

MIT
