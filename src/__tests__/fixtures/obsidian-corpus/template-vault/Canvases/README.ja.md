# Canvases

[English version](README.md)

視覚的なノート整理のための `.canvas` ファイルを置くフォルダです。

## このフォルダでできること

無限キャンバス上にノート、画像、リンクを配置し、関係線やグループで情報を構造化できます。

## このフォルダが役立つ理由

- 文章だけでは把握しづらい関係性を可視化できる
- プロジェクトの全体像や依存関係を直感的に整理できる
- Markdown ノートと相互参照しながら思考できる

## はじめ方

1. Obsidian で `Canvases` フォルダを開く
2. 新規 Canvas を作成
3. [../Projects](../Projects) や [../References](../References) のノートをドラッグ
4. 関係線やグループで構造化

## 利用例

`.canvas` ファイル例（obsidian-skills パターン）:

```json
{
	"nodes": [
		{
			"id": "8a9b0c1d2e3f4a5b",
			"type": "text",
			"x": 0,
			"y": 0,
			"width": 300,
			"height": 150,
			"text": "# Main Idea\n\nThis is the central concept."
		},
		{
			"id": "1a2b3c4d5e6f7a8b",
			"type": "text",
			"x": 400,
			"y": -100,
			"width": 250,
			"height": 100,
			"text": "## Supporting Point A\n\nDetails here."
		}
	],
	"edges": [
		{
			"id": "3c4d5e6f7a8b9c0d",
			"fromNode": "8a9b0c1d2e3f4a5b",
			"fromSide": "right",
			"toNode": "1a2b3c4d5e6f7a8b",
			"toSide": "left"
		}
	]
}
```

## ヘルプ・サポート

- Vault 全体の導入: [../README.ja.md](../README.ja.md)
- 公式 Obsidian ヘルプ: https://help.obsidian.md/

## メンテナとコントリビューション

キャンバス運用のテンプレート例や、学習しやすいサンプルの追加を歓迎します。
