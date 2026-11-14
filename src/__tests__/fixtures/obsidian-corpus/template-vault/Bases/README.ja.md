# Bases

[English version](README.md)

Obsidian の Bases 機能を使って、ノートを表やカードで一覧化するための定義を管理するフォルダです。

## このフォルダでできること

このフォルダには `.base` ファイルがあり、Books / People / Projects / Trips などのノートを、プロパティベースで表示・ソート・フィルタできます。

## このフォルダが役立つ理由

- 同じ種類のノートを横断的に管理できる
- プロパティ駆動で、検索より速く一覧把握しやすい
- Markdown 本体はそのまま保ちつつ、ビューだけを切り替えられる

## はじめ方

1. Obsidian で Vault を開く
2. Bases 機能を有効化する
3. `Bases` 配下の `.base` ファイルを開く
4. 対象ノートのフロントマターに必要プロパティを追加する

## 利用例

ノート側の最小例:

```md
---
type: project
status: active
review: 2026-04-01
---

# ドキュメント改善
```

`.base` ファイル側の例（obsidian-skills の Task Tracker Base パターン）:

```yaml
filters:
  and:
    - file.hasTag("task")
    - 'file.ext == "md"'

formulas:
  days_until_due: 'if(due, (date(due) - today()).days, "")'
  is_overdue: 'if(due, date(due) < today() && status != "done", false)'
  priority_label: 'if(priority == 1, "🔴 High", if(priority == 2, "🟡 Medium", "🟢 Low"))'

properties:
  status:
    displayName: Status
  formula.days_until_due:
    displayName: "Days Until Due"
  formula.priority_label:
    displayName: Priority

views:
  - type: table
    name: "Active Tasks"
    filters:
      and:
        - 'status != "done"'
    order:
      - file.name
      - status
      - formula.priority_label
      - due
      - formula.days_until_due
    groupBy:
      property: status
      direction: ASC
    summaries:
      formula.days_until_due: Average

  - type: table
    name: "Completed"
    filters:
      and:
        - 'status == "done"'
    order:
      - file.name
      - completed_date
```

## ヘルプ・サポート

- Vault 全体の導入: [../README.ja.md](../README.ja.md)
- 公式 Obsidian ヘルプ: https://help.obsidian.md/

## メンテナとコントリビューション

このフォルダはテンプレート全体と同じ運用で管理されています。新しい `.base` の追加や既存定義の改善は歓迎です。
