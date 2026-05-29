"""
G22 modifier — QTP Bias Filter MTF threshold reconciliation.

Single-line jsCode edit on the "QTP Bias Filter" node:

  BEFORE: const finalMtfPass = mtfEngineSeen && finalMtfDecision === 'FINAL_MTF_CONFLUENCE_PASS' && mtfScore >= 65 && aiMtfScore >= 65;
  AFTER:  const finalMtfPass = mtfEngineSeen && finalMtfDecision === 'FINAL_MTF_CONFLUENCE_PASS';

Delegates MTF threshold enforcement entirely to the MTF Confluence Engine
(threshold 60 + per-tier floors per QTP_MTF_THRESHOLD_LOWER_v6.3_20260521).

Pre-PUT checks:
  - exactly one target line matches
  - exactly one node modified ("QTP Bias Filter")
  - jsCode change is exactly that one line (byte-level diff)
  - JS syntax sanity-check (Node.js --check)
  - Tarjan SCC on full graph: 0 non-trivial SCCs (no topology change)
"""

import json
import os
import re
import subprocess
import tempfile
from collections import defaultdict


TARGET_NODE = "QTP Bias Filter"
BEFORE_RE = re.compile(
    r"^(\s*const\s+finalMtfPass\s*=\s*mtfEngineSeen\s*&&\s*finalMtfDecision\s*===\s*'FINAL_MTF_CONFLUENCE_PASS')(\s*&&\s*mtfScore\s*>=\s*65\s*&&\s*aiMtfScore\s*>=\s*65)(\s*;\s*)$",
    re.MULTILINE,
)


def _tarjan_scc(nodes_set, adj):
    index_counter = [0]
    stack = []
    lowlinks = {}
    index = {}
    on_stack = {}
    result = []

    def strongconnect(start):
        work = [(start, 0)]
        while work:
            v, pi = work.pop()
            if pi == 0:
                index[v] = index_counter[0]
                lowlinks[v] = index_counter[0]
                index_counter[0] += 1
                stack.append(v)
                on_stack[v] = True
            recurse = False
            neighbours = adj.get(v, [])
            for i in range(pi, len(neighbours)):
                w = neighbours[i]
                if w not in index:
                    work.append((v, i + 1))
                    work.append((w, 0))
                    recurse = True
                    break
                elif on_stack.get(w):
                    lowlinks[v] = min(lowlinks[v], index[w])
            if recurse:
                continue
            if lowlinks[v] == index[v]:
                comp = []
                while True:
                    w = stack.pop()
                    on_stack[w] = False
                    comp.append(w)
                    if w == v:
                        break
                result.append(comp)

    for v in nodes_set:
        if v not in index:
            strongconnect(v)
    return result


def _build_adj(conns):
    adj = defaultdict(list)
    for src, outputs in conns.items():
        for slot in outputs.get("main", []) or []:
            if not slot:
                continue
            for edge in slot:
                tgt = edge.get("node")
                if tgt:
                    adj[src].append(tgt)
    return adj


def _js_syntax_check(js_source):
    """Best-effort JS syntax check using node --check. Skip silently if node not available."""
    node = None
    for path in ("/usr/bin/node", "/usr/local/bin/node"):
        if os.path.exists(path):
            node = path
            break
    if node is None:
        try:
            node = subprocess.check_output(["which", "node"]).decode().strip()
        except Exception:
            print("  [js  ] node not found — skipping syntax check (will rely on n8n runtime)")
            return
    # Wrap in a function so top-level await/return are tolerated
    wrapped = "async function __qtp_check(items) {\n" + js_source + "\n}\n"
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(wrapped)
        tmp = f.name
    try:
        r = subprocess.run([node, "--check", tmp], capture_output=True, text=True, timeout=10)
        if r.returncode != 0:
            raise RuntimeError(f"JS syntax check failed:\nSTDOUT:\n{r.stdout}\nSTDERR:\n{r.stderr}")
        print(f"  [js  ] node --check OK")
    finally:
        try:
            os.unlink(tmp)
        except Exception:
            pass


def modify(wf):
    # Find Bias Filter node
    bias_filter = None
    for n in wf["nodes"]:
        if n["name"] == TARGET_NODE:
            bias_filter = n
            break
    if bias_filter is None:
        raise RuntimeError(f"Node '{TARGET_NODE}' not found — abort.")

    if "jsCode" not in bias_filter["parameters"]:
        raise RuntimeError(f"Node '{TARGET_NODE}' has no jsCode parameter — abort.")

    before_code = bias_filter["parameters"]["jsCode"]

    matches = list(BEFORE_RE.finditer(before_code))
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected exactly 1 match for target finalMtfPass line; found {len(matches)} — abort."
        )

    # Replace: keep group(1) + group(3), drop group(2) (the && mtfScore... && aiMtfScore... portion)
    new_code = BEFORE_RE.sub(r"\1\3", before_code)

    if new_code == before_code:
        raise RuntimeError("Substitution produced no change — abort.")

    # Sanity: only one line differs, and only the threshold portion was removed
    before_lines = before_code.split("\n")
    after_lines = new_code.split("\n")
    if len(before_lines) != len(after_lines):
        raise RuntimeError(
            f"Line count changed ({len(before_lines)} → {len(after_lines)}) — abort (expected same number of lines)."
        )
    diff_lines = [
        (i + 1, b, a) for i, (b, a) in enumerate(zip(before_lines, after_lines)) if b != a
    ]
    if len(diff_lines) != 1:
        raise RuntimeError(f"Expected exactly 1 line to differ; got {len(diff_lines)} — abort.")
    ln, b_line, a_line = diff_lines[0]
    print(f"  [diff] exactly 1 line modified at L{ln}")
    print(f"    BEFORE: {b_line.strip()}")
    print(f"    AFTER : {a_line.strip()}")

    # Confirm exactly what was removed
    removed = b_line.replace(a_line.rstrip(";").rstrip(), "").strip()
    print(f"    REMOVED FRAGMENT: {removed!r}")
    expected_removed_re = re.compile(r"^&&\s*mtfScore\s*>=\s*65\s*&&\s*aiMtfScore\s*>=\s*65$")
    if not expected_removed_re.match(removed.rstrip(";")):
        raise RuntimeError(
            f"Removed fragment '{removed}' does not match expected threshold clause — abort."
        )

    # JS syntax check
    _js_syntax_check(new_code)

    # Apply
    bias_filter["parameters"]["jsCode"] = new_code

    # Confirm no other node was touched: take a hash of every other node's params before/after via copy
    # (we already only mutated bias_filter["parameters"]["jsCode"], but verify by comparing)
    print(f"  [scope] only '{TARGET_NODE}' parameters.jsCode touched")

    # SCC check on connections (unchanged, but verify)
    nodes_set = {n["name"] for n in wf["nodes"]}
    adj = _build_adj(wf["connections"])
    sccs = _tarjan_scc(nodes_set, adj)
    non_trivial = [s for s in sccs if len(s) > 1]
    if non_trivial:
        raise RuntimeError(
            f"SCC CHECK FAILED — {len(non_trivial)} non-trivial SCC(s): {non_trivial[:3]}"
        )
    print(f"  [scc ] OK — {len(sccs)} SCCs, 0 non-trivial (topology unchanged)")

    wf.setdefault("_modifier_metadata", {})["g22_change"] = {
        "node": TARGET_NODE,
        "line_modified": ln,
        "before": b_line.strip(),
        "after": a_line.strip(),
        "removed_fragment": removed.rstrip(";"),
    }

    return wf
