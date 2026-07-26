# 責務

## 1. 一行で

**ネットワーク同期のトランスポートとプロトコルだけを持つ。**(plan.md §3.14)

## 2. 持つもの

| 責務 | 具体物 | 現状 |
| --- | --- | --- |
| プロトコル定義 | `NetworkMessage` の集合、`Frame` エンベロープ、`PROTOCOL_VERSION` | `domain/protocol.ts`(9 種。参照実装は 18 種) |
| フレームコーデック | `encodeFrame` / `decodeFrame`。ラウンドトリップが契約 | `domain/codec.ts` |
| 障害分類 | `ProtocolError`(再送無意味)/ `TransportError`(再送が正解) | `domain/errors.ts` |
| 接続ライフサイクル | 明示的な状態機械。合法遷移の表 | `domain/connection.ts` |
| トランスポート Port | `TransportPort` とループバック実装 | `domain/transport.ts` |
| 状態同期 | mc-sim のサービスへの書き込み(受信 → 反映) | **未実装**。mc-sim 公開後 |
| stage 登録 | `StageRegistration`(`after` 制約のみ宣言) | **未実装**。mc-kernel 公開後 |

## 3. 持たないもの ― mx-ui との境界線

plan.md §3.14 設計注意:
> 参照実装のメインメニュー導線・マルチプレイヤー画面は mx-ui 側。ここはトランスポートとプロトコルに限定

参照実装では `packages/network`(1,718 LOC)と `packages/presentation/multiplayer`(592 LOC)が
別パッケージでありながら同じ「マルチプレイヤー機能」として一体で扱われていた。
新構成ではこれを **リポジトリ境界** に格上げする。

| 参照実装での所在 | 新構成での所有者 | 理由 |
| --- | --- | --- |
| `packages/presentation/multiplayer/player-list-panel.ts`(154 LOC) | **mx-ui** | DOM を触るものはすべて mx-ui |
| サーバ一覧 / 接続ダイアログ / メインメニュー導線 | **mx-ui** | 同上 |
| `packages/network/domain/schemas.ts` | **mx-multiplayer** | プロトコル |
| `packages/network/application/codec.ts` | **mx-multiplayer** | コーデック |
| `packages/network/infrastructure/*websocket*` | **mx-multiplayer** の Port + アダプタ | Port はここ、実 WebSocket 実装はプラットフォーム層 |
| `packages/network/application/server-handlers.ts` の claim 調停 | **mc-sim + mx-gameplay** | §4 参照。ここはルールを持たない |

### 境界が守れているかの機械的チェック

`test/public-api.test.ts` に「`screen` / `menu` / `hud` / `render` / `dom` / `element` / `widget` / `overlay`
を名前に含む export がゼロであること」という弱いチェックがある。
名前だけの検査なので厳密ではないが、**新しい export を足すその場所で意図を可視化する**ためにある。

## 4. ルールを持たない、という制約

参照実装の `packages/network/application/server-handlers.ts:288-330` には
**先着優先の claim 調停**が実装されている:

> 最初にドロップアイテムを拾ったプレイヤーが勝ち、後から claim した側には `ClaimDenied` を返して
> ローカルの pickup を巻き戻させる

これは典型的な**ゲームルール**である。「競合した pickup で誰が勝つか」はネットワークの都合ではなく、
インベントリの都合で決まる。新構成では:

- **誰が勝つか**を決めるのは mc-sim(状態の正)と mx-gameplay(ルール)
- mx-multiplayer は**決定を運ぶだけ**。`ClaimDenied` に相当するメッセージはプロトコルに持つが、
  誰を deny するかは決めない

この分離を破ると、mc-compose にルールが堆積したのと同じことが mx-multiplayer で起きる。

## 5. 「トランスポートとプロトコルだけ」の運用上の意味

追加しようとしているコードが以下のどれかに該当するなら、それはここではない。

| 症状 | 正しい置き場 |
| --- | --- |
| DOM を触る / 画面を描く | mx-ui |
| 「〜したら〜になる」というルールを書いている | mx-gameplay(または該当する mx-*) |
| プレイヤーやエンティティの状態そのものを保持している | mc-sim |
| ワールドデータを生成・変更している | mc-worldgen |
| 実 WebSocket / TCP / WebRTC を直接叩いている | プラットフォームアダプタ(Port の実装として repo 外へ) |
| 壁時計を読んでいる(`Date.now()`) | mc-kernel の `ClockPort` を注入して読む |

最後の行は参照実装で実際に破られていた。[design-notes.md](./design-notes.md) の DN-3 を参照。
