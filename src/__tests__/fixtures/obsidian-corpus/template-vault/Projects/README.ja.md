# Projects

[English version](README.md)

複数ステップや意思決定が必要な「進行中の作業」を管理するフォルダです。

## このフォルダでできること

- 実行中プロジェクトの進捗管理
- 次アクションと期限の明確化
- 関連ノートへのリンク集約
- 週次・月次レビューへの入力

## このフォルダが役立つ理由

- 実行中タスクと参照知識を分離できる
- 現在のコミットメントを一覧しやすい
- Bases ビューと組み合わせて状況把握しやすい

## はじめ方

アクティブな案件ごとに 1 ノート作成し、冒頭に状態を記載します。

## 利用例

```md
---
type: project
status: active
review: 2026-03-31
tags:
	- documentation
---

# Vault README 整備

## ゴール
新規ユーザーが迷わない構成説明にする。

> [!tip] 完了条件
> 最終ガイドは [[References/README]] にリンクし、最新版の構成図を添付する。

## 次のアクション
- [ ] フォルダREADME更新
- [ ] ルートREADMEのリンク確認

## 添付
![[vault-readme-structure.png]]

## 関連ノート
- [[Ideas/README]]
- [[Weekly/README]]
```

## ヘルプ・サポート

- 構造化ビュー: [../Bases/README.ja.md](../Bases/README.ja.md)
- 週次レビュー: [../Weekly/README.ja.md](../Weekly/README.ja.md)
- 月次レビュー: [../Monthly/README.ja.md](../Monthly/README.ja.md)
- 全体導入: [../README.ja.md](../README.ja.md)

## メンテナとコントリビューション

進捗の見通しを良くするテンプレート、状態管理ルール、相互リンク改善の提案を歓迎します。
