// The result table of providersRealServers.test.ts (plan W6.27) as Markdown.
// Usage: node scripts/real-servers/table.mjs <results.json>
import { readFileSync } from "node:fs";
const { table, rounds, writers, at } = JSON.parse(readFileSync(process.argv[2], "utf8"));
const cols = ["P1", "P2", "PN", "R", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "T8"];
const cell = (o) => (!o ? "–" : o.ok ? "✅" : "❌");
console.log(`Run ${at}; races: ${rounds} rounds of ${writers} writers.\n`);
console.log(`| Server | ${cols.join(" | ")} |`);
console.log(`|---|${cols.map(() => "---").join("|")}|`);
for (const [name, row] of Object.entries(table)) console.log(`| ${name} | ${cols.map((c) => cell(row[c])).join(" | ")} |`);
console.log("\nDetails:");
for (const [name, row] of Object.entries(table)) for (const c of cols) if (row[c]?.detail) console.log(`- ${name} ${c}: ${row[c].detail.replace(/\s+/g, " ").slice(0, 160)}`);
