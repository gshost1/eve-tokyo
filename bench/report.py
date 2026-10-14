"""Aggregate a model-layer results JSON into per-strategy tables (mean over seeds).

python3 bench/report.py results/model-haiku.json [--md]
"""
import json
import sys
from collections import defaultdict

d = json.load(open(sys.argv[1]))
md = "--md" in sys.argv
KINDS = ["path", "error", "command", "decision"]

# strategy -> summary round index -> list of per-seed metric dicts
table = defaultdict(lambda: defaultdict(list))
costs = defaultdict(list)
caps_before = defaultdict(list)
for r in d["results"]:
    summaries = [x for x in r["rounds"] if x["path"] == "summary"]
    caps_before[r["strategy"]].append(len(r["rounds"]) - len(summaries))
    for i, x in enumerate(summaries, 1):
        row = {k: x["byKind"][k]["present"] / max(1, x["byKind"][k]["total"]) for k in KINDS}
        dl = x["decisionLoose"]
        row["decision~"] = dl["present"] / max(1, dl["total"])
        row["tokensAfter"] = x["tokensAfter"]
        table[r["strategy"]][i].append(row)
        s = x["summary"]
        costs[r["strategy"]].append((s["costUsd"], s["ms"], s["inputTokens"], s["outputTokens"]))

cols = ["path", "error", "command", "decision", "decision~", "tokensAfter"]
mean = lambda xs: sum(xs) / len(xs) if xs else 0
for strategy, rounds in table.items():
    c = costs[strategy]
    print(f"\n### {strategy}  (cap rounds before 1st summary: {caps_before[strategy]}; "
          f"per summary: ${mean([x[0] for x in c]):.4f}, {mean([x[1] for x in c]) / 1000:.1f}s, "
          f"{mean([x[2] for x in c]):.0f} in / {mean([x[3] for x in c]):.0f} out tokens)")
    if md:
        print("\n| summary round | " + " | ".join(cols) + " | seeds |\n|" + "---|" * (len(cols) + 2))
    for i in sorted(rounds):
        rows = rounds[i]
        vals = [mean([row[k] for row in rows]) for k in cols]
        cells = [f"{v * 100:.0f}%" for v in vals[:-1]] + [f"{vals[-1]:.0f}"]
        if md:
            print(f"| S{i} | " + " | ".join(cells) + f" | {len(rows)} |")
        else:
            print(f"  S{i}: " + "  ".join(f"{k} {c}" for k, c in zip(cols, cells)) + f"  (n={len(rows)})")
