# Open Book of Laws fixture — synthetic

`israeli_law.synthetic.jsonl` is in the shape of a JSON-lines export of the
Hugging Face dataset gkour/israeli_law (one object per page, `title` and
`text`), written for the W11.H16 unit test. The law **titles are real** (as
in the Knesset fixture); the **section texts are short made-up paraphrases**,
not the laws' wording and not Wikisource's text. Half the rows use Wikisource's
ח: templates, half are plain text. No number measured on it is a result: the
20-lookup check is owed on the real dataset once it is pinned and downloaded.
