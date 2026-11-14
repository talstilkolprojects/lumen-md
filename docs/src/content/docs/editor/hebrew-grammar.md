---
title: Hebrew grammar and style
description: Hebrew grammar and style checks that run on this device, beyond spelling, with three writing levels and a short explanation for each suggestion.
---

With grammar checking on (`⌘K` → **Enable grammar check (LanguageTool)**), Hebrew
paragraphs are checked on this device. Nothing is sent anywhere. Each
suggestion comes with a one-line explanation.

## What it catches

| Error | Example | Suggestion |
|---|---|---|
| Number and gender (3–10) | שלוש ילדים | שלושה ילדים |
| Two before a noun | שתי ספרים, שניים ילדים | שני ספרים, שני ילדים |
| הכי with ביותר | הכי טוב ביותר | טוב ביותר |
| את instead of עם | נפגשתי את דני | נפגשתי עם דני |
| The article in a construct pair | הבית ספר | בית הספר |
| אני with a third-person future | אני ילך | אני אלך |
| A repeated meaning | חזר שוב, בערך כמאה | חזר, כמאה |

The rules are careful rather than greedy. If the word list cannot tell a
noun's gender, the noun is left alone, and so are compound numbers like
שלוש עשרה.

## Writing levels

`⌘K` → **Hebrew grammar: change the writing level** cycles through three
levels:

- **Everyday:** only the errors in the table above.
- **Academic** and **Legal:** also flag spoken Hebrew in formal writing, such
  as הכי חשוב (→ חשוב ביותר) and בגלל ש (→ מכיוון ש).

## A local model (optional)

The rules never need a model. If you want one, a model running in Ollama
on this computer (DictaLM 3.0 1.7B, for example) can judge each grammar
suggestion and drop the ones it rejects. The checker talks to `localhost`
only.

## How it is measured

`eval/probes/hebrew-grammar.json` has 200 sentences with one marked error
each, and the corrected sentence beside each one.
`src/__tests__/hebrewGrammar.test.ts` checks four things:
- that at least 70% of the errors are found;
- that at most 5% of the corrected sentences, and of the 1,302 sentences of
  real prose in the HeQ dev paragraphs, get any suggestion;
- the time per paragraph;
- that no request is made.

The probe was written for this repository, so its numbers are development
numbers. A held-out set of real sentences with marked errors is still
needed.
