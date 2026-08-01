# @nerima-games/mx-multiplayer

## 責務

ネットワーク同期の **トランスポート、プロトコル、受信スナップショット補間** を持つ(plan.md §3.14)。

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
$ direnv allow          # flake.nix の devShell で nodejs_24 + corepack が入る
$ pnpm install
```

Nix を使わない場合は Node.js 24 以上と pnpm 11(`corepack` 推奨)を用意する。

> **注意**: ツールチェーンは `devenv.nix` から `flake.nix` + `flake.lock` に移行済みである。
> `flake.lock` はコミットされているので、`nix develop`（`.envrc` は `use flake`）は
> 誰の手元でも同じ nixpkgs に解決される。`devenv.nix` / `devenv.lock` はもう存在しない。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json`（出荷ソース）/ `tsconfig.test.json`（テスト + スクリプト）/ `tsconfig.preview.json`（`apps/`）の 3 プロジェクトを型検査 |
| `pnpm lint` | oxlint(このリポジトリ唯一の lint / format 設定。prettier も biome も .editorconfig も置かない)。設定ファイルは `.oxlintrc.json`(oxlint が自動検出する唯一のファイル名。旧 `oxlint.json` は無視され、実際には一度も読み込まれていなかった)。**`--deny-warnings` 付きで走る**ため、`warn` のルールもビルドを落とす（`.oxlintrc.json` は 5 カテゴリすべてと個別 50 ルールが `warn`、`error` は `no-eval` / `no-implied-eval` / `no-restricted-imports` の 3 つだけ。このフラグが無かった頃は実質その 3 つしかゲートになっていなかった） |
| `pnpm lint:fix` | oxlint の自動修正 |
| `pnpm preview` | 内蔵プレビュー(ローカル 2 クライアント + フォールトインジェクション)。**`pnpm verify` には入らない**。[apps/preview-two-clients/README.md](./apps/preview-two-clients/README.md) |
| `pnpm test` | vitest(`@effect/vitest` の `it.effect` が主 API) |
| `pnpm test:watch` | vitest watch |
| `pnpm test:coverage` | カバレッジ計測(閾値は未設定) |
| `pnpm check:deps` | 依存ホワイトリスト + 循環検査 + `Date.now()` 禁止の検査 |
| `pnpm api:check` | `api-lock.md` が実際の公開 API と食い違えば非ゼロ終了（[`docs/public-api.md`](./docs/public-api.md) §6） |
| `pnpm api:update` | `api-lock.md` を書き直す。公開面を変える PR は結果を同じ PR に含める |
| `pnpm verify` | `typecheck && lint && check:deps && api:check && test`。CI と同じ内容 |

### スナップショット補間

`SnapshotInterpolator` はプレイヤーごとに sequence/tick 順の受信履歴を保持し、描画 tick の
決定的な姿勢を返す。重複・遅延・逆順パケットは破棄し、履歴長は設定値で上限を持つ。
大きな位置差は補間せず、設定した teleport 距離でスナップする。切断時は `disconnect` で
対象プレイヤー、または全履歴を削除する。

これは protocol v1 の wire format を変更しない受信側コンポーネントである。sequence と tick は
サーバや上位の同期処理がスナップショットへ付与する。API と利用例は
[docs/public-api.md](./docs/public-api.md) を参照。

## 現状

**このリポジトリはまだ叩き台(pre-audit first cut)である。** 以下は確定事項ではない。

- **メッセージ集合は代表的な 9 種のみ。** 参照実装の 18 種は再現していない
  ([docs/porting.md](./docs/porting.md) 参照)
- **`GameModule` / `StageRegistration` は実装済み**（[stages/](./stages/)）。
  `multiplayer:inbound` と `multiplayer:outbound` の 2 本を登録する。
  ただし **mc-compose の標準 stage 骨格に `multiplayer:` を拾うフェーズが 1 つも無い**ため、
  今日この 2 本は**フレームの末尾、HUD の後ろ**に落ちる（実測値と、必要なフェーズ 2 つの
  位置は [stages/stage-ids.ts](./stages/stage-ids.ts) 冒頭）。骨格は plan.md §2.3-3 により
  mc-compose の唯一の所有物なので、ここからは直せない。
  契約型は `domain/frame-contract.ts` に暫定ミラーを置いている（mc-kernel 公開時に削除）
- **mc-sim への状態反映がまだ無い。** mc-sim 公開後
- **実 WebSocket アダプタが無い。** `TransportPort` の実装はプラットフォーム層に置く。
  現在あるのはループバック(テスト用)と `disconnectedTransport` のみ
- **プレビューは動く。** `pnpm preview`（[apps/preview-two-clients/](./apps/preview-two-clients/README.md)）。
  1 プロセスの中で 2 つのピアを `makeLoopbackPair` で配線し、15 ステップのハンドシェイクを
  1 キーストロークずつ進めながら、フレーム・状態遷移・**フォールト注入**を見せる。
  ソケットは 1 つも開かず、`mc-playground-kit` も新規依存も使っていない。
  `pnpm preview --stats` は初回実行（2026-07-27）で **4 件**の finding を出し、
  4 件とも `test/preview-findings.test.ts` に assertion として固定してある。
  うち 3 件（M1 / M3 / M4）は既存 107 本のテストが 1 つも捕まえていなかった
- **ビルド / publish がまだ無い。** `package.json` の `exports` は TypeScript ソースを直接指している
- **カバレッジ閾値は未設定。** 99% ゲートは完成条件到達時に有効化する

確定しているのは**仕組み**のほうである: バージョン付きエンベロープ、テキストで止まるコーデック、
`ProtocolError` と `TransportError` の分離、リトライ方針を持たない接続状態機械。

ただし**エンベロープの検査順序は仕組みどおりになっていない** —— バージョンはエンベロープに載っているが、
`domain/codec.ts` はメッセージ形状を先にパースしてからバージョンを見る。
プレビューの M1 がそれで、[docs/testing.md](./docs/testing.md) §9 に詳細がある。

## License

MIT
