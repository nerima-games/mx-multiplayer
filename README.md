# @nerima-games/mx-multiplayer

## 責務

ネットワーク同期の **トランスポート、プロトコル、受信スナップショット補間** を持つ(plan.md §3.14)。

サーバ一覧・接続ダイアログ・ロスター表示といったマルチプレイヤー**画面**は mx-ui の所有物であり、
ここには無い。詳細は [docs/responsibility.md](./docs/responsibility.md)。

## 依存

実行時依存は `package.json` に列挙された `@nerima-games/mc-kernel`、
`@nerima-games/mc-sim`、`effect` である。mx-gameplay / mx-redstone / mx-ui へのエッジはゼロである
— 体験モジュールは互いを知らない(plan.md §2.3-1)。

**mc-sim を経由して到達できる mc-physics / mc-worldgen / mc-save の import は禁止**である。
直接依存と import 境界の正本は [docs/architecture.md](./docs/architecture.md) §3 と
`package.json` である。詳細は [docs/versioning.md](./docs/versioning.md) §3。

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

## 開発

### セットアップ

```console
$ direnv allow                             # flake.nix の devShell で nodejs_26 + corepack_24 + oxlint + ast-grep が入る
$ NODE_AUTH_TOKEN=$(gh auth token) pnpm install   # @nerima-games/mc-sim を GitHub Packages から解決する
```

Nix を使わない場合は Node.js 24 以上と pnpm 11.24.0 以上(`corepack` 推奨)を用意する。
ただし `oxlint` と `ast-grep` は Nix の devShell からのみ供給される(npm devDependency ではない、
org 共通ポリシー。§「開発」の `lint` を参照)ため、`pnpm lint` は `nix develop --command` 経由で走らせる。

> **注意**: ツールチェーンは `flake.nix` + `flake.lock` で管理する。`flake.lock` はコミットされているので、
> `nix develop`（`.envrc` は `use flake`）は誰の手元でも同じ nixpkgs に解決される。
> `flake.lock` は `nixpkgs` を特定リビジョンにロックしている(oxlint ≥1.79.0 の
> `no-redeclare` が本リポジトリの `Brand.refined` イディオムを誤検知するため。flake.nix のコメント参照)。

### コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm typecheck` | `tsconfig.build.json`（出荷ソース）/ `tsconfig.test.json`（テスト + スクリプト）/ `tsconfig.preview.json` / `tsconfig.scenarios.json` / `tsconfig.debug-ui.json` を型検査 |
| `pnpm lint` | oxlint(このリポジトリ唯一の lint / format 設定。prettier も biome も .editorconfig も置かない)。設定ファイルは `.oxlintrc.json`(oxlint が自動検出する唯一のファイル名。旧 `oxlint.json` は無視され、実際には一度も読み込まれていなかった)。**`--deny-warnings` 付きで走る**ため、`warn` のルールもビルドを落とす（`.oxlintrc.json` は 5 カテゴリすべてと個別 50 ルールが `warn`、`error` は `no-eval` / `no-implied-eval` / `no-restricted-imports` の 3 つだけ。このフラグが無かった頃は実質その 3 つしかゲートになっていなかった） |
| `pnpm lint:fix` | oxlint の自動修正 |
| `pnpm preview` | 内蔵プレビュー(ローカル 2 クライアント + フォールトインジェクション)。**`pnpm verify` には入らない**。[apps/preview-two-clients/README.md](./apps/preview-two-clients/README.md) |
| `pnpm debug-ui` | ブラウザ開発用 Debug UI を起動する（下記）。 |
| `pnpm test` | vitest(`@effect/vitest` の `it.effect` が主 API) |
| `pnpm test:watch` | vitest watch |
| `pnpm test:browser` | `test-browser/` の Playwright ブラウザ仕様テストを実行する。 |
| `pnpm test:coverage` | vitest をカバレッジ付きで実行 |
| `pnpm package:verify` | 出荷ビルドとパッケージ内容を検査 |
| `pnpm verify` | `typecheck && lint && test`。CI と同じ内容 |

### Debug UI（開発専用）

`pnpm debug-ui` は Vite の開発サーバーを起動し、既定では `http://127.0.0.1:5182` で待ち受ける。`HARNESS_PORT` でポートを変更できる（[apps/debug-ui/vite.config.ts](./apps/debug-ui/vite.config.ts)、[package.json](./package.json)）。この UI は開発専用であり、公開パッケージには含まれない。`package.json` の `files` は `dist`、`LICENSE`、`README.md` のみを許可する。

| パネル | 表示・操作する内容 |
| --- | --- |
| Scenario runner ([apps/debug-ui/panels/scenario-runner.ts](./apps/debug-ui/panels/scenario-runner.ts)) | シナリオカタログからグループとフレーム数を選んで実行し、クライアント・authority の状態と verdict を表示する。 |
| AOI grid ([apps/debug-ui/panels/aoi-grid.ts](./apps/debug-ui/panels/aoi-grid.ts)) | AOI 負荷シナリオを実行・step し、クライアントごとの投影と block-change の配送結果を表示する。 |
| Invariants and rejection coverage ([apps/debug-ui/panels/invariants.ts](./apps/debug-ui/panels/invariants.ts)) | シナリオ assertion、観測した拒否理由、revision history の単調性、注入 clock と論理 frame の一致を表示する。 |
| Timeline and reproduction ([apps/debug-ui/panels/timeline.ts](./apps/debug-ui/panels/timeline.ts)) | 再生・pause・step・reset・seek・速度変更と reproduction JSON の import/export を行う。 |
| Communication and wire log ([apps/debug-ui/panels/communication.ts](./apps/debug-ui/panels/communication.ts)) | シナリオと runtime fault を選んで実行し、wire log と verdict を表示する。 |
| Join and reconnect ([apps/debug-ui/panels/participants.ts](./apps/debug-ui/panels/participants.ts)) | クライアント状態と reconnect 認証を表示し、snapshot scenario では 1 frame 後に client C を参加させる。認証は決定的なメモリ内テスト fixture を使う。 |
| Connection, transport, and security ([apps/debug-ui/panels/connection-security.ts](./apps/debug-ui/panels/connection-security.ts)) | 接続状態、`canSend`、reconnect・拒否の要約、設定済み rate limit、観測 traffic と frame size を表示する。rate probe は limiter を直接試し、network frame は送信しない。 |

scenario runtime は seed と注入 clock を使い、revision history を記録する。fault は `none`、`delay`、`drop`、`reorder`、`disconnect`、`corrupt`、`version`、`future`、`duplicate` を扱う（[scenarios/types.ts](./scenarios/types.ts)、[apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts](./apps/debug-ui/entrypoints/scenarios/scenario-runtime.ts)）。CLI の `pnpm preview` は別の in-memory handshake preview であり、このブラウザ UI ではない。

### スナップショット補間

`SnapshotInterpolator` はプレイヤーごとに sequence/tick 順の受信履歴を保持し、描画 tick の
決定的な姿勢を返す。重複・遅延・逆順パケットは破棄し、履歴長は設定値で上限を持つ。
大きな位置差は補間せず、設定した teleport 距離でスナップする。切断時は `disconnect` で
対象プレイヤー、または全履歴を削除する。

これは `src/domain/protocol.ts` の `PROTOCOL_VERSION` を正本とする wire format を変更しない
受信側コンポーネントである。sequence と tick はサーバや上位の同期処理がスナップショットへ付与する。API と利用例は
[docs/public-api.md](./docs/public-api.md) を参照。

## 現状

**このリポジトリはまだ叩き台(pre-audit first cut)である。** 以下は確定事項ではない。

- **メッセージ集合の正本は `src/domain/protocol.ts`**。`NetworkMessage` と `MESSAGE_TAGS` を
  実装・テストで網羅的に管理し、タグ集合を固定数では説明しない。
- **`GameModule` / `StageRegistration` は実装済み**（[src/stages/](./src/stages/)）。
  `multiplayer:inbound` と `multiplayer:outbound` の 2 本を登録する。
  ただし **mc-compose の標準 stage 骨格に `multiplayer:` を拾うフェーズが 1 つも無い**ため、
  今日この 2 本は**フレームの末尾、HUD の後ろ**に落ちる（実測値と、必要なフェーズ 2 つの
  位置は [src/stages/stage-ids.ts](./src/stages/stage-ids.ts) 冒頭）。骨格は plan.md §2.3-3 により
  mc-compose の唯一の所有物なので、ここからは直せない。
  stage の状態と登録契約は [src/stages/registration.ts](./src/stages/registration.ts) にある。
- **mc-sim への状態反映は実装済み。** `src/application/server/command-application.ts` が
  対応する権威コマンドを mc-sim のサービスへ write-through し、
  `test/command-application.test.ts` で検証している。未対応のコマンドは明示的に拒否する。
- **ブラウザ用 WebSocket adapter がある。** `src/application/browser-transport.ts` は注入された `WebSocket` / `URL` constructor から `TransportPort` の実装を作る。WebSocket server は含まれない。`test/websocket-harness.test.ts` は実 WebSocket 接続を検証し、`test/browser-transport.test.ts` は `FakeSocket` を使う。
- **ビルドとパッケージ検証がある。** `pnpm build` が `dist/` を生成し、`package.json` の `exports` は
  生成物を参照する。`pnpm package:verify` は tarball の内容とインストール可能性を検査する。
- **カバレッジ閾値は4指標とも100%。** `vitest.config.ts` の statements / branches / functions / lines
  の閾値で管理する。
- **プレビューは動く。** `pnpm preview`（[apps/preview-two-clients/](./apps/preview-two-clients/README.md)）。
  1 プロセスの中で 2 つのピアを `makeLoopbackPair` で配線し、15 ステップのハンドシェイクを
  1 キーストロークずつ進めながら、フレーム・状態遷移・**フォールト注入**を見せる。
  ソケットは 1 つも開かず、`mc-playground-kit` も新規依存も使っていない。
  `pnpm preview --stats` は実行時に finding を測定し、現在は M2 / M3 / M-clock の
  3 件を報告する。codec の境界検証は `test/preview-findings.test.ts` と
  `test/codec.test.ts` に assertion として固定してある。
確定しているのは**仕組み**のほうである: バージョン付きエンベロープ、テキストで止まるコーデック、
`ProtocolError` と `TransportError` の分離、リトライ方針を持たない接続状態機械。

エンベロープは opaque な `message` と `protocolVersion` として先に decode され、
バージョンを検査してから `message` を `NetworkMessage` として decode する。
実装は [src/domain/codec.ts](./src/domain/codec.ts) と
[docs/testing.md](./docs/testing.md) §9 を参照。

## License

MIT
