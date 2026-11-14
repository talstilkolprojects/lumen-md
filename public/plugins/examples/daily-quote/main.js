// Quote of the day — an example Lumen plugin (plan W1.20) that reaches the
// network. It may fetch from exactly one origin, the one its manifest
// declares; the sandbox refuses every other address, and the request shows
// in the privacy ledger.

const SOURCE = "https://example.com/quotes/today.json";

async function insertQuote() {
  try {
    const res = await lumen.network.fetch(SOURCE);
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const q = JSON.parse(res.body);
    const text = typeof q.text === "string" ? q.text : "";
    const by = typeof q.author === "string" ? q.author : "";
    if (!text) throw new Error("no quote today");
    await lumen.document.insertText(`> ${text}${by ? `\n> — ${by}` : ""}\n`);
  } catch (e) {
    await lumen.notifications.show(`Could not fetch the quote: ${e && e.message ? e.message : e}`, "error");
  }
}

await lumen.commands.register({ id: "insert", label: "Insert quote of the day", hint: "From example.com" }, insertQuote);
