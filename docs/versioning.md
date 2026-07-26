# バージョニングと公開

## 1. 現在地

- **package version**: `0.1.0`
- **公開状態**: **未公開。** ビルド / publish パイプラインはまだ存在しない
- **`package.json#exports`**: TypeScript ソースを直接指している(`./index.ts`)

## 2. なぜ公開しないのか(plan.md §6 Step 0 / Step 3)

plan.md §6 Step 0 item 2:
> 開発中は `workspace:*` 解決でモノレポ同等の DX。
> **npm 公開・バージョン bump 運用は界面安定(4 週間 API ロック無変更)まで開始しない**

plan.md §8 のリスク表:
> 新規構築初期は全界面が高 churn → npm 公開を遅らせ dev-meta workspace で開発。bump 連鎖を構造的に回避

16 リポジトリが相互に依存する状態で早期に publish を始めると、
mc-kernel の 1 行変更が 15 リポジトリの bump 連鎖を引き起こす。
それを構造的に避けるため、開発中は `@nerima-games/mc-dev-meta` が
15 リポジトリを 1 つの pnpm workspace に束ね、`workspace:*` で解決する。

## 3. `dependencies` に `@nerima-games/mc-sim` が無い理由

[architecture.md](./architecture.md) のとおり mx-multiplayer の実行時依存は mc-sim だけである。
にもかかわらず `package.json` には `effect` しか無い。

理由は **ボトムアップの publish-then-pin** である:

1. 依存順(kernel → noise/meshing/physics/save/audio → worldgen → sim → render → kit →
   gameplay/redstone → ui → multiplayer → compose)に完成させる
2. 完成した層から publish する
3. 下流はそこで初めて**公開済みバージョンを pin** する

現時点では mc-sim が存在しないため、`dependencies` に書くと `pnpm install` が失敗する。
**ポリシー側(`scripts/check-dependency-whitelist.ts` の `REPOSITORY_POLICY`)には
mc-sim が既に宣言してある** ので、契約は最初から機械可読な形で存在する。
`package.json` があとから追いつく。

## 4. 0.x の間の約束

| 項目 | 約束 |
| --- | --- |
| 公開 API | **破壊的変更を予告なく入れてよい。** 0.x とはそういう意味である |
| バージョン | 変更のたびに patch/minor を上げるが、semver の保証はしない |
| プロトコル | `PROTOCOL_VERSION` は 1 のまま。互換性の保証は**開始していない** |
| ドキュメント | `docs/` は実装と同時に更新する。ここだけは 0.x でも守る |

## 5. 1.0.0 の条件

以下がすべて満たされたとき 1.0.0 にする。

1. **下流が実際に消費して契約を確認した。** 具体的には mc-compose が
   このリポジトリを import し、E2E が green になっている
2. **API ロック 4 週間無変更**(plan.md §6 Step 3)。公開 API のレポートを diff レビューし、
   4 週間変更が入らないこと
3. **参照実装のテスト資産の移植が完了**([porting.md](./porting.md) の 1〜6)
4. **ビルド / publish パイプラインが存在する**(§6)
5. **カバレッジ 99% ゲートが有効**([testing.md](./testing.md) §6)

## 6. ビルドと publish(完成時に追加する)

現在 `tsconfig.base.json` は `noEmit: true` であり、**すべての tsconfig は検査専用**である。
完成条件を満たした時点で以下を追加する:

- `.d.ts` + ESM を出す emit 用 tsconfig
- `package.json#exports` を `./dist/index.js` / `./dist/index.d.ts` に切り替え
- GitHub Packages(`https://npm.pkg.github.com`)への publish ワークフロー
  — `publishConfig` は既に設定済み
- changesets 運用(plan.md §6 Step 3)

## 7. プロトコルバージョンと package バージョンは別物

**混同しないこと。**

| | 何を表すか | 誰が困るか |
| --- | --- | --- |
| `version`(package.json) | この npm パッケージの API の互換性 | このパッケージを import する開発者 |
| `PROTOCOL_VERSION` | **ワイヤ互換性** | 異なるビルド同士で遊んでいるプレイヤー |

`PROTOCOL_VERSION` を上げるということは、
**古いビルドのピアと接続できなくなる**ということである。
`test/public-api.test.ts` の
`pins the protocol version, so a bump is always an explicit edit` が値をピン留めしているので、
bump は必ず明示的な編集になる。

### bump のルール(暫定)

| 変更 | `PROTOCOL_VERSION` | `version` |
| --- | --- | --- |
| メッセージを**追加**する | 据え置き(未知タグは相手が弾く。ただし機能が片側で欠ける) | minor |
| メッセージのフィールドを**追加**する | **上げる**。旧ビルドはデコードに失敗する | minor 以上 |
| フィールドを**削除・改名**する | **上げる** | major(1.0.0 以降) |
| 制約を**緩める**(`int()` を外す等) | 据え置き可(旧ビルドが受け取れないだけ) | minor |
| 制約を**きつくする** | **上げる** | major |

「追加は後方互換」は**このプロトコルでは成り立たない**。
`Schema.Struct` は既定で未知フィールドを落とすが、
必須フィールドの欠落はデコード失敗になるためである。
オプショナルフィールドによる漸進的な拡張を許すかどうかは、
最初の互換性が必要になる場面(= 実際に 2 バージョンが同時に動く場面)まで決めない。
