/**
 * Hand-written analyst programs for the data-analysis dev questions
 * (plan 6.15). They follow the analyst agent's contract (inputs["csv"],
 * one json.dumps({"answer": …}) line) and are written from the questions
 * only. They exercise the pipeline in data-analysis.mjs --programs
 * reference; they are not a model's answers.
 */
const READ = `import csv, io, json
rows = list(csv.DictReader(io.StringIO(inputs["csv"])))
for r in rows:
    r["month"] = r["date"][:7]
    for k in ("army_size", "disease", "wounds", "other"):
        r[k] = float(r[k])
`;

export const REFERENCE_PROGRAMS = {
  "rose-total-wounds-1855": READ + `print(json.dumps({"answer": int(sum(r["wounds"] for r in rows if r["month"].startswith("1855")))}))`,
  "rose-max-disease": READ + `best = max(rows, key=lambda r: r["disease"])
print(json.dumps({"answer": best["month"], "chart": {"labels": [r["month"] for r in rows], "values": [r["disease"] for r in rows], "title": "Deaths from zymotic disease"}}))`,
  "rose-rate-disease-1855-12": READ + `r = next(r for r in rows if r["month"] == "1855-12")
print(json.dumps({"answer": round(r["disease"] * 12 * 1000 / r["army_size"], 1)}))`,
  "rose-count-disease-500": READ + `print(json.dumps({"answer": sum(1 for r in rows if r["disease"] > 500)}))`,
  "rose-share-disease": READ + `total = sum(r["disease"] + r["wounds"] + r["other"] for r in rows)
print(json.dumps({"answer": round(100 * sum(r["disease"] for r in rows) / total, 1)}))`,
};
