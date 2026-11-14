# フォルダ運用規約

Vault 内のフォルダの用途、命名規則、ノートのライフサイクルをまとめたリファレンスノートです。

## フォルダ一覧

| フォルダ | 置くもの | 置かないもの |
| --- | --- | --- |
| `Daily/` | 日付付きジャーナル・日次ログ・短命タスク | 長期参照知識、プロジェクト計画 |
| `Weekly/` | 週次レビューと計画ノート | 日次の細かい記録 |
| `Monthly/` | 月次レビューと目標設定ノート | 週次粒度の記録 |
| `Projects/` | 明確なゴールと次アクションがある実行中の作業 | 完了・放棄済み、あいまいなアイデア |
| `Ideas/` | まだ実行段階でない探索的なノート | 締め切りのある実行中コミットメント |
| `References/` | 常緑の知識ノート・一次ソース要約・長期参照 | 日次ログ、実行タスク |
| `Clippings/` | Web 抜粋・一次ソース保存・生のキャプチャ | 処理済みの要約（それは References へ） |
| `Templates/` | Templates プラグインで挿入する再利用テンプレート | 記入済みのノート |
| `Bases/` | Obsidian Bases 定義ファイル（`.base`） | 通常の Markdown コンテンツ |
| `Canvases/` | ビジュアルキャンバスとホワイトボード図 | テキストのみのノート |
| `Sandbox/` | Obsidian 入門ガイドと書式サンプル | 本番コンテンツ |
| `Meta/` | Vault 運用ノート（規約・方針・レビュー周期） | 内容に関するノート |

## 命名規則

| 対象 | 規則 | 例 |
| --- | --- | --- |
| Daily ノート | `YYYY-MM-DD` | `2026-04-01` |
| Weekly ノート | `YYYY-Www` | `2026-W14` |
| Monthly ノート | `YYYY-MM` | `2026-04` |
| プロジェクトノート | 小文字ハイフン区切りスラグ | `vault-readme整備` |
| アイデアノート | 短い説明的フレーズ | `週次レビュープロンプト` |
| リファレンスノート | トピック名または著者–タイトル形式 | `zettelkasten-method` |
| クリッピングノート | ソーススラグ or 日付付きスラグ | `2026-04-01-記事タイトル` |

ファイル名にはなるべくスペースを使わず、ハイフンで区切ります。Obsidian はスペースを `%20` エンコードするため、ウィキリンクの可読性が下がります。

## ノートのライフサイクル

```
Ideas/ ──── （実行可能になった）──▶ Projects/ ──── （完了・放棄）──▶ #archived
  │                                     │
  │                                     └── （永続知識を抽出）──▶ References/
  │
  └── （キャプチャ・一次ソース）──▶ Clippings/ ──── （処理済）──▶ References/
```

### ライフサイクルステージ

| ステージ | タグ | 置き場所 |
| --- | --- | --- |
| 探索中 | `#idea` | `Ideas/` |
| 実行中 | `#active` | `Projects/` |
| 一時停止 | `#paused` | `Projects/` |
| 常緑 | — | `References/` |
| アーカイブ済 | `#archived` | [[Archive policy.ja]] を参照 |

## フロントマター規約

Bases ビューやフィルタリングを有効にするため、以下のキーを統一して使用します。

```yaml
---
type: project          # project | idea | reference | clipping | daily | weekly | monthly
status: active         # active | paused | done | abandoned
created: 2026-04-01
reviewed: 2026-04-01
tags:
  - project
---
```

## ヘルプ・サポート

- Vault 全体の構成: [../README.ja.md](../README.ja.md)
- アーカイブルール: [[Archive policy.ja]]
- レビューチェックリスト: [[Review cadence.ja]]

## メンテナとコントリビューション

フォルダの境界変更、新フォルダ追加、命名規則の改訂のたびにこのノートを更新してください。ルート [README.ja.md](../README.ja.md) のフォルダ一覧も合わせて更新します。
