#!/usr/bin/env python3
"""G19: n8n workflow DAG validator.

Fails (exit 1) if any cycle is detected in the workflow's connections graph.
Designed as a pre-merge CI gate to block PRs that would introduce a feedback
loop into an n8n Cloud workflow (root cause of the 2026-05-29 CINF incident).

Usage:
    python scripts/validate_workflow_dag.py workflows/ssm.json [workflows/scanner.json ...]
"""
import json
import sys
from collections import defaultdict


def has_cycle(connections):
    """Return list of nodes in the first detected cycle, or None if the graph is a DAG."""
    adj = defaultdict(list)
    for src, ports in connections.items():
        for port in ports.get("main", []):
            for edge in (port or []):
                adj[src].append(edge["node"])
    WHITE, GRAY, BLACK = 0, 1, 2
    color = defaultdict(int)
    cycle_nodes = []

    def dfs(u, stack):
        color[u] = GRAY
        stack.append(u)
        for v in adj[u]:
            if color[v] == GRAY:
                idx = stack.index(v)
                cycle_nodes.extend(stack[idx:])
                return True
            if color[v] == WHITE and dfs(v, stack):
                return True
        stack.pop()
        color[u] = BLACK
        return False

    for n in list(adj):
        if color[n] == WHITE and dfs(n, []):
            return cycle_nodes
    return None


if __name__ == "__main__":
    wf = json.load(open(sys.argv[1]))
    conns = wf.get("workflow", wf).get("connections", {})
    cycle = has_cycle(conns)
    if cycle:
        print(f"FAIL: cycle detected through nodes: {cycle}")
        sys.exit(1)
    print("OK: workflow is a DAG")
    sys.exit(0)
