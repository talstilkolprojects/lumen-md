"""One-time migration (plan 0.6): plan5.py + gen5.py (the earlier Python
generator, outside the repo) -> plan/plan.json.

    python3 -B scripts/plan/import-plan5.py <dir with plan5.py and gen5.py> [plan/plan.json]

Reads both scripts and changes neither: plan5.py is imported (it only
computes), gen5.py is parsed, never run (running it writes files). After
the switch, plan/plan.json is the source and this script is not needed;
it stays so a late edit to the Python plan can be carried over once more.
The milestone definitions mirror gen5.py's MILESTONES expressions.
"""
import ast, json, os, sys

src_dir = os.path.abspath(sys.argv[1])
out = os.path.abspath(sys.argv[2] if len(sys.argv) > 2 else "plan/plan.json")
sys.path.insert(0, src_dir)
cwd = os.getcwd(); os.chdir(src_dir)
import plan5 as P  # noqa: E402
os.chdir(cwd)

gen = ast.parse(open(os.path.join(src_dir, "gen5.py"), encoding="utf8").read())
updated, done_rows, opens = None, None, {}
for n in ast.walk(gen):
    if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "UPDATED":
        updated = "%04d-%02d-%02dT%02d:%02d" % tuple(a.value for a in n.value.args)
    if isinstance(n, ast.For) and isinstance(n.iter, ast.List) and getattr(n.target, "id", None) == "row":
        done_rows = ast.literal_eval(n.iter)
    if isinstance(n, ast.Assign) and isinstance(n.targets[0], ast.Subscript) and getattr(n.targets[0].value, "id", None) == "OPENS":
        opens[ast.literal_eval(n.targets[0].slice)] = ast.literal_eval(n.value)
assert updated and done_rows, "gen5.py: UPDATED or the done table not found"

def task(t):
    d = {"id": t["id"], "title": t["t"], "branch": t["br"], "lane": t["lane"], "minutes": t["m_est"] if t.get("done") else t["m"]}
    if t["id"] == "13.5": d["depRule"] = "allP0"      # gen5: every P0 task + the owner's P0 items
    elif t["id"] == "13.6": d["depRule"] = "all"      # gen5: everything else
    else: d["dep"] = t["dep"]
    if t["g"]: d["groups"] = t["g"]
    d["priority"] = t["p"]
    if t.get("status"): d["status"] = t["status"]
    if t["new"]: d["new"] = True
    if t["tal"]: d["owner"] = t["tal"]
    if t["old"]: d["was"] = t["old"]
    d["source"] = t["w"]
    d["steps"] = t["steps"]
    d["acceptance"] = t["ok"]
    return d

owner = []
for t in P.TALT:
    o = {"id": t["id"], "title": t["t"], "details": t["steps"][0], "time": t["time"], "minutes": t["m"], "dep": t["dep"], "priority": t["p"]}
    if t["id"] in opens: o["opens"] = opens[t["id"]]
    owner.append(o)

plan = {
    "$comment": "The plan's single source (plan 0.6). Edit this file, then `npm run plan` regenerates the board in MASTER_PLAN.md and plan/board.html; CI (`npm run plan:check`) fails when they differ. A task's status is one line: phases[].tasks[].status.",
    "updated": updated,
    "start": P.START.strftime("%Y-%m-%dT%H:%M"),
    "buffer": P.BUFFER,
    "ownerWindow": list(P.TAL_WIN),
    "lanes": P.LANES,
    "schedule": {
        "laneFirst": ["0.1", "1.1"],
        "ownerFirst": ["15.1", "15.9", "15.10", "15.11"],
        "ownerInputsFirst": ["15.9", "15.10", "15.11"],
        "ownerAlwaysP0": ["15.1"],
        "defaultDep": "0.1",
        "noDefaultDep": ["0.1", "1.1"],
        "cutLineExempt": ["13.6"],
        "releaseTask": "13.5",
    },
    "milestones": [
        {"title": "כל הממצאים סגורים וכלי ה-P0 של שלב 0 עובדים", "at": ["task:1.1", "phase:0:P0"]},
        {"title": "שלב 1 גמור — כל ✅ עובר DoD", "at": ["task:1.8"]},
        {"title": "יסודות ניהול הידע (P0 של שלב 4)", "at": ["phase:4:P0"]},
        {"title": "גרסה ראשונה לשחרור — כל ה-P0 + ביקורת עצמאית", "at": ["release"]},
        {"title": "הכול גמור + ביקורת מול יעדי §14", "at": ["end"]},
    ],
    "done": [{"part": a, "prs": b, "start": c, "end": d} for (a, b, c, d) in done_rows],
    "phases": [{"title": p["title"], "goal": p["goal"], "why": p["why"], "tasks": [task(t) for t in p["tasks"]]} for p in P.PHASES],
    "owner": owner,
}
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, "w", encoding="utf8") as f:
    json.dump(plan, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{out}: {len(P.ALL_AGENT)} tasks, {len(P.TALT)} owner items, updated {updated}")
