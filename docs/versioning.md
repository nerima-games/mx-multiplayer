# バージョニングと公開

## 1. Package metadata

- `package.json` is the source of truth for the package version and dependency versions. Do not copy the current package version into documentation.
- The package is published to GitHub Packages.
- `package.json#exports["."]` exposes `./dist/index.js` and `./dist/index.d.ts`.
- `package.json#files` publishes only `dist`, `LICENSE`, and `README.md`.

## 2. Release order

Release follows the dependency graph from the kernel and simulation layers to the
consumer-facing composition packages. Published package metadata remains defined by
`package.json`; dependency order does not justify duplicating package versions in docs.

## 3. Runtime dependencies

[architecture.md](./architecture.md) describes the dependency boundary. The direct runtime dependencies are the packages listed in `package.json`, including `@nerima-games/mc-kernel`, `@nerima-games/mc-sim`, and `effect`.

The dependency versions are exact pins in `package.json`; this document must not duplicate them.

The package is released bottom-up, but release order does not change the package metadata contract.

## 4. 0.x の間の約束

| 項目 | 約束 |
| --- | --- |
| 公開 API | **破壊的変更を予告なく入れてよい。** 0.x とはそういう意味である |
| バージョン | 変更のたびに patch/minor を上げるが、semver の保証はしない |
| プロトコル | `PROTOCOL_VERSION` in `src/domain/protocol.ts` is the wire-compatibility source of truth; protocol changes require an explicit compatibility note |
| ドキュメント | `docs/` は実装と同時に更新する。ここだけは 0.x でも守る |

## 5. 1.0.0 の条件

以下がすべて満たされたとき 1.0.0 にする。

1. **下流が実際に消費して契約を確認した。** 具体的には mc-compose が
   このリポジトリを import し、E2E が green になっている
2. **1.0.0 への昇格は maintainer(take)の裁量判断による。** 日数計測ベースの自動凍結ゲート
   (旧「API ロック 4 週間無変更」)は廃止された([RELEASE_STANDARD.md §4.2](https://github.com/nerima-games/.github/blob/main/RELEASE_STANDARD.md#42-新しい昇格ポリシー人間による裁量判断))。
   代替の定量基準も設けない。判断材料は上位階層からの利用実績や破壊的変更の落ち着き具合など、
   都度異なってよい
3. **参照実装のテスト資産の移植が完了**([porting.md](./porting.md) の 1〜6)
4. **ビルド / publish パイプラインが存在する**(§6)
5. **カバレッジ 100% ゲートが有効**([testing.md](./testing.md) §6)

## 6. ビルドと publish

`tsconfig.base.json` は今も `noEmit: true` で検査専用だが、`tsconfig.release.json`
(`extends: tsconfig.base.json`, `noEmit: false`, `rootDir: src`, `outDir: dist`)だけが emit する
(Wave 0、plan.md §2.2/§2.4)。`pnpm build` = `node scripts/clean-dist.mjs && tsc -p tsconfig.release.json`。

- `package.json#exports` は `./dist/index.js` / `./dist/index.d.ts` を指す
- `scripts/verify-package.mjs`(`pnpm package:verify`)が pack した tarball を別ディレクトリに
  install し、公開 API の実行時 import と型検査の両方を検証する
- GitHub Packages(`https://npm.pkg.github.com`)への publish は `.github/workflows/release.yaml`
  (detect → publish → tag)。`publishConfig` は既に設定済み
- changesets 運用(plan.md §6 Step 3)。`.changeset/config.json` は `access: public`

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
