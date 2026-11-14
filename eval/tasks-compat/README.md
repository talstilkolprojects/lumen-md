# tasks-compat (plan 4.13)

20 notes from the obsidian-tasks repository's test data
(`tests/Obsidian/__test_data__/*.json`, MIT, © 2021 Clare Macrae, Ilyas Landikov
and Martin Schenck; LICENSE here). Each upstream fixture holds a note and
Obsidian's own Markdown cache for it. `expected.json` is that cache's answer:
the line and the status character of every task. So the oracle is Obsidian,
not our parser. Tasks in callouts, blockquotes, numbered and mixed lists,
nested lists, links, comments and code blocks are covered.

The field values (dates, priority, recurrence, ids) are pinned separately in
`src/__tests__/vaultTasks.test.ts` against the plugin's documented format.
