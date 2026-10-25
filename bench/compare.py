"""Cross-model comparison of model-layer runs.

python3 bench/compare.py results/model-haiku.json results/gw-full-*.json results/do-full-*.json [--md]

Per model and strategy: exact retention after the 1st and 5th summary (mean over seeds), the
paraphrase-tolerant decision score, and how many checkpoints claim a build or test run went
fine. Every build and test run in the synthetic sessions fails, so any such claim is false.
"""
import json
import re
import sys
from collections import defaultdict

files = [a for a in sys.argv[1:] if not a.startswith("--")]
md = "--md" in sys.argv
ORDER = ["eve-default", "fix-4771", "head-tail", "head-tail+anchors", "eve-4773"]
HEAD_ONLY = ("eve-default", "fix-4771")  # eve-4773 is eve at a3654ef, head + tail built in

# A checkpoint line that says a build/test/compile went fine.
FALSE_OK = re.compile(
    r"\b(ran cleanly|compiled cleanly|compiles? cleanly|clean (build|compile)|built successfully|"
    r"all (tests )?pass(ed|ing)?|tests? pass(ed|ing)?|no (errors|failures)( (shown|visible|reported))?|"
    r"succeeded|exit(ed)? (with )?(code )?0\b)",
    re.I,
)
FAILURE = re.compile(r"fail|AssertionError|\bTS\d{4}\b|\bE_[A-Z]+|exit(ed)? (with )?(code )?1\b|error[: ]|\b500\b|instead of 200|expected 200", re.I)
NEGATED = re.compile(r"\b(no|not|never|none|nothing|n't)\b[^,;:]{0,40}$", re.I)


def claims_false_ok(checkpoint):
    """True when a line says a run went fine, isn't negated, and mentions no failure.

    Lines, not sentences: checkpoints are bullet lists and file names contain dots.
    """
    for line in (checkpoint or "").splitlines():
        for m in FALSE_OK.finditer(line):
            if not m.group(1).lower().startswith("no ") and NEGATED.search(line[: m.start()]):
                continue
            if not FAILURE.search(line[: m.start()] + line[m.end():]):
                return True
    return False


def mean(xs):
    return sum(xs) / len(xs) if xs else float("nan")

rows = []
for path in files:
    d = json.load(open(path))
    model = d.get("model") or "anthropic/claude-haiku-5.5"
    by = defaultdict(lambda: {"s": defaultdict(list), "false_ok": 0, "ckpts": 0, "in": [], "ms": []})
    for r in d["results"]:
        b = by[r["strategy"]]
        summaries = [x for x in r["rounds"] if x["path"] == "summary"]
        for i, x in enumerate(summaries, 1):
            k = x["byKind"]
            b["s"][i].append({
                "path": k["path"]["present"] / max(1, k["path"]["total"]),
                "error": k["error"]["present"] / max(1, k["error"]["total"]),
                "command": k["command"]["present"] / max(1, k["command"]["total"]),
                "decision~": x["decisionLoose"]["present"] / max(1, x["decisionLoose"]["total"]),
            })
            b["ckpts"] += 1
            b["false_ok"] += 1 if claims_false_ok(x.get("checkpoint")) else 0
            b["in"].append(x["summary"]["inputTokens"])
            b["ms"].append(x["summary"]["ms"])
    for strategy in ORDER:
        if strategy not in by:
            continue
        b = by[strategy]
        s1 = b["s"].get(1, [])
        s5 = b["s"].get(max(b["s"]) if b["s"] else 1, [])
        rows.append({
            "model": model,
            "strategy": strategy,
            "rounds": max(b["s"]) if b["s"] else 0,
            **{f"{k}1": mean([x[k] for x in s1]) for k in ["path", "error", "command", "decision~"]},
            **{f"{k}5": mean([x[k] for x in s5]) for k in ["path", "error", "command", "decision~"]},
            "false_ok": b["false_ok"],
            "ckpts": b["ckpts"],
            "in": mean(b["in"]),
            "s": mean(b["ms"]) / 1000,
        })

pct = lambda v: "-" if v != v else f"{v * 100:.0f}%"
head = ["model", "strategy", "paths S1→S5", "errors S1→S5", "commands S1→S5", "decisions~ S1→S5", "false 'it passed'", "in tok", "s/summary"]
lines = []
for r in rows:
    lines.append([
        r["model"], r["strategy"],
        f'{pct(r["path1"])} → {pct(r["path5"])}', f'{pct(r["error1"])} → {pct(r["error5"])}',
        f'{pct(r["command1"])} → {pct(r["command5"])}', f'{pct(r["decision~1"])} → {pct(r["decision~5"])}',
        f'{r["false_ok"]}/{r["ckpts"]}', f'{r["in"]:.0f}', f'{r["s"]:.0f}',
    ])
if md:
    print("| " + " | ".join(head) + " |\n|" + "---|" * len(head))
    for l in lines:
        print("| " + " | ".join(l) + " |")
else:
    for l in lines:
        print("  ".join(f"{c:>16}" if i > 1 else f"{c:<28}" for i, c in enumerate(l)))

# Headline: false "it passed" by cap type, pooled over models.
pool = defaultdict(lambda: [0, 0])
for r in rows:
    kind = "head-only cap" if r["strategy"] in HEAD_ONLY else "head+tail cap"
    pool[kind][0] += r["false_ok"]
    pool[kind][1] += r["ckpts"]
print()
for kind, (a, n) in pool.items():
    print(f"{kind}: {a}/{n} checkpoints claim a failing build/test went fine ({100 * a / max(1, n):.0f}%)")
