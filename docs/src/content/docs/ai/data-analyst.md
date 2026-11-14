---
title: Data analyst
description: Ask a question about a table in your note; a short Python program answers it on this device, checked by a second run.
---

Put a table in the note: a ```` ```csv ```` block, a Markdown table, or
comma-separated lines. Then run `⌘K → AI: Analyse the table` and ask your
question, for example "Which month had the most deaths from disease?" or
"Total sales in 2025?".

## What happens

1. **A program, not a guess.** The analyst agent writes a short Python 3
   program for the question. It may use only the standard library (`csv`,
   `statistics`, `math`, `datetime`, `json`) and receives the table as
   `inputs["csv"]`. A validator rejects a program that does not read the
   table, does not print a JSON answer, or imports anything outside that
   list (`random`, `time`, `os`, the network…).
2. **The sandbox.** The program runs in the [`run_python`](/ai/local-agents/)
   sandbox: Pyodide on this device, with no network, no workspace files and a
   time limit.
3. **A second run.** The same program runs again in a fresh sandbox. If the
   two answers differ, or either run fails, you get no answer: only the
   reason.
4. **Into the note.** The answer is added as a quote, followed by a
   ```` ```live-python ```` block that holds the table and the program. You
   can re-run it and see exactly how the number was computed. When the
   program returns chart data, a ```` ```chart ```` block is added too.

The model that writes the program is your local one (Ollama or the
in-browser model) under the AI policy, like every other agent. The table is
sent to it as text (the first 12 lines, for the column names) and nowhere
else.

## Quality

`node scripts/golden/evals/data-analysis.mjs --dev` runs the golden
questions through the same sandbox path. The target is at least 85% correct
numeric answers on 20 golden questions with a real model. That measurement
is the owner's (plan 15.13).
