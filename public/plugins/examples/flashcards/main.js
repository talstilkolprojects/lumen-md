// Flashcards — a Lumen plugin (plan W4.32; the Spaced Repetition idea,
// written from scratch). Lines like `question :: answer` in the open note
// are cards. "Review flashcards" shows the cards that are due, one at a
// time; you grade each (Again / Hard / Good / Easy) and the next review is
// scheduled with SM-2. The schedule is kept in the plugin's own storage,
// keyed by the card's text, so the note itself is never changed.

const DAY = 86400000;

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Cards of a note: `front :: back` lines outside code. */
function cardsOf(text) {
  const out = [];
  let fence = null;
  for (const line of text.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const m = /^\s*(?:[-*+]\s+)?(.+?)\s+::\s+(.+?)\s*$/.exec(line);
    if (m) out.push({ id: hash(`${m[1]}\u0000${m[2]}`), front: m[1], back: m[2] });
  }
  return out;
}

/** SM-2: the next state after grade q (0 again, 3 hard, 4 good, 5 easy). */
function schedule(prev, q, today) {
  let { reps = 0, interval = 0, ease = 2.5 } = prev ?? {};
  if (q < 3) {
    reps = 0;
    interval = 1;
  } else {
    reps += 1;
    interval = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(interval * ease);
    if (q === 3) interval = Math.max(1, Math.round(interval * 0.8));
  }
  ease = Math.max(1.3, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  return { reps, interval, ease: Math.round(ease * 100) / 100, due: today + interval * DAY };
}

const session = { queue: [], showBack: false, done: 0, today: 0 };

async function render() {
  const card = session.queue[0];
  if (!card) {
    await lumen.panel.render({ type: "box", gap: 6, children: [{ type: "heading", level: 2, text: session.done ? `Done: ${session.done} reviewed · סיימתם: ${session.done}` : "No cards due · אין כרטיסים לחזרה" }, { type: "text", text: "Cards are lines like “question :: answer”. · כרטיס הוא שורה בצורה „שאלה :: תשובה”." }] });
    return;
  }
  const children = [
    { type: "text", text: `${session.queue.length} due · ${session.queue.length} לחזרה` },
    { type: "heading", level: 2, text: card.front },
  ];
  if (!session.showBack) children.push({ type: "button", id: "show", label: "Show answer · הצגת התשובה", primary: true });
  else
    children.push(
      { type: "paragraph", children: [{ type: "text", text: card.back }] },
      {
        type: "box",
        direction: "row",
        gap: 6,
        children: [
          { type: "button", id: "g0", label: "Again · שוב" },
          { type: "button", id: "g3", label: "Hard · קשה" },
          { type: "button", id: "g4", label: "Good · טוב", primary: true },
          { type: "button", id: "g5", label: "Easy · קל" },
        ],
      },
    );
  await lumen.panel.render({ type: "box", gap: 8, children });
}

lumen.on("ui:panel", async (e) => {
  if (e.kind !== "click") return;
  if (e.id === "show") session.showBack = true;
  else {
    const m = /^g([0345])$/.exec(e.id);
    const card = session.queue[0];
    if (!m || !card) return;
    const q = Number(m[1]);
    await lumen.storage.set(card.id, schedule(await lumen.storage.get(card.id), q, session.today));
    session.queue.shift();
    // "Again" comes back at the end of this session.
    if (q === 0) session.queue.push(card);
    else session.done++;
    session.showBack = false;
  }
  await render();
});

await lumen.commands.register({ id: "review", label: "Review flashcards", hint: "“question :: answer” lines of this note · חזרה על כרטיסיות" }, async (payload) => {
  const now = payload && typeof payload.today === "string" ? Date.parse(`${payload.today}T00:00:00Z`) : Date.now();
  session.today = now - (now % DAY);
  session.queue = [];
  session.done = 0;
  session.showBack = false;
  for (const c of cardsOf(await lumen.document.getText())) {
    const st = await lumen.storage.get(c.id);
    if (!st || st.due <= session.today) session.queue.push(c);
  }
  await lumen.panel.open({ title: "Flashcards · כרטיסיות" });
  await render();
});
