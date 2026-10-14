"""Print per-round retention from a bench results JSON: python3 bench/summarize.py results/offline.json"""
import json, sys
d = json.load(open(sys.argv[1]))
f = lambda c: f'{c["present"]}/{c["total"]}'
for r in d["results"]:
    print(f'seed {r["seed"]} {r["strategy"]}: {len(r["rounds"])} rounds {("| " + r["stoppedAt"]) if r.get("stoppedAt") else ""}')
    for x in r["rounds"]:
        k, w = x["byKind"], x["byWhere"]
        s = x.get("summary") or {}
        extra = f' ${s.get("costUsd",0):.4f} {s.get("ms",0)}ms' if s else ""
        dl = x.get("decisionLoose")
        print(f'  r{x["round"]} {x["path"]:7} {x["tokensBefore"]:>6.0f}->{x["tokensAfter"]:<6.0f} '
              f'path {f(k["path"]):>7} err {f(k["error"]):>7} cmd {f(k["command"]):>7} dec {f(k["decision"]):>7} (loose {f(dl) if dl else "-"}) | '
              f'head {f(w["head"]):>7} mid {f(w["middle"]):>7} tail {f(w["tail"]):>7}{extra}')
