# mx-multiplayer ドキュメント索引

`@nerima-games/mx-multiplayer` の実装情報はここに集約する。README.md はセットアップとコマンドの案内に留め、
設計の理由・境界・移植計画はこのディレクトリで扱う。

| ドキュメント | 内容 | 主な読者 |
| --- | --- | --- |
| [architecture.md](./architecture.md) | 4 階層アーキテクチャ、16 リポジトリ依存グラフ、本リポジトリの位置、名詞/動詞ルール、mc-playground-kit の devDependency 専用ルール | 全員。最初に読む |
| [responsibility.md](./responsibility.md) | 何を持ち、何を持たないか。mx-ui との境界線 | 実装者・レビュアー |
| [public-api.md](./public-api.md) | 公開 API 一覧と、それぞれの契約 | 下流(mc-compose)の実装者 |
| [design-notes.md](./design-notes.md) | 参照実装の実測知見。各項目が「名前付き回帰テスト」として書かれている | 実装者。**実装前に必読** |
| [porting.md](./porting.md) | 参照実装 `takeokunn/ts-minecraft` からの移植計画。**LOC は実測値** | 実装者 |
| [testing.md](./testing.md) | テスト戦略。何をどのレイヤで検証するか | 実装者・レビュアー |
| [versioning.md](./versioning.md) | 0.x → 1.0.0 の条件、GitHub Packages 公開、プロトコルバージョンとの関係 | リリース担当 |

## 表記

| 表記 | 意味 |
| --- | --- |
| `<reference-impl>` | **参照実装のチェックアウトのルート**。凍結された `takeokunn/ts-minecraft` の作業コピーを指す。本ドキュメント群では `<reference-impl>/packages/…` の形か、単に `packages/…`（同じくルート相対）で引用する。手元のどこに clone してあっても読み替えられるようにするためのプレースホルダである |
| plan.md | リポジトリ構成仕様書（16 リポジトリ、確定済み）。**非公開**であり、公開読者は開けない。だから本ドキュメント群は「plan.md を読まなくても追える」ことを要件にしている —— plan.md の主張を引くときは必ず原文を引用し、参照実装での裏づけを file:line で添える |
| `nerima-games/<repo>` | 同 org の兄弟リポジトリ。リンクは GitHub の URL で張る |

## 読む順番

1. **architecture.md** — このリポジトリがグラフのどこにいて、なぜ mc-sim にしか依存しないか
2. **responsibility.md** — mx-ui との境界。ここを誤ると参照実装と同じ構造に戻る
3. **design-notes.md** — 参照実装で実際に起きたことと、その回帰テスト
4. **porting.md** — 実際に移植を始めるとき

## 現状

このリポジトリは **叩き台(pre-audit first cut)** である。
プロトコルのメッセージ集合は参照実装の全 18 種ではなく代表的な 9 種のみで、
`@nerima-games/mc-sim` への依存は `package.json` にまだ宣言していない
(ロスター全体が未公開のため。[versioning.md](./versioning.md) 参照)。

確定しているのは **仕組み** のほうである:

- フレームはバージョン付きエンベロープを必ず持つ(参照実装には無かった)
- コーデックはテキストで止まる(プラットフォーム非依存)
- `ProtocolError` と `TransportError` は最後まで別型
- 接続ライフサイクルは明示的な状態機械であり、リトライ方針を持たない
