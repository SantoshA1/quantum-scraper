import datetime
import json
import pathlib
import re
import subprocess
import urllib.error
import urllib.request

WORKSPACE = pathlib.Path("/home/user/workspace")
OUTPUTS = WORKSPACE / "outputs"
OUTPUTS.mkdir(exist_ok=True)

BASE = "https://tradenextgen.app.n8n.cloud/api/v1"
WORKFLOW_ID = "vaqfCaELhOEWnkdo"
TARGET_NODE = "Merge MTF AI Verdict"
TARGET_NODE_ID = "qtp-merge-mtf-ai-verdict-v59"

ANCHOR = "j.final_mtf_confluence_decision = j.final_mtf_confluence_pass ? 'FINAL_MTF_CONFLUENCE_PASS' : 'FINAL_MTF_CONFLUENCE_BLOCK';"

PATCH_BLOCK = """

  // === QTP_MTF_AUDIT_VISIBILITY_20260521 ===
  // When MTF blocks, tag blocked_stage so audit log shows MTF as the gate that
  // killed the signal. Without this, MTF-blocked rows look like blocked_stage=NONE,
  // hiding the real bottleneck. Preserve per-tier scores for triage.
  // SAFETY: do NOT overwrite an already-set blocked_stage (e.g., R3.2 KILL or
  // BROAD_SCANNER_BIAS_PATH must survive). Only set when no upstream gate did.
  if (!j.final_mtf_confluence_pass) {
    if (!j.blocked_stage || String(j.blocked_stage).trim() === '' || String(j.blocked_stage).toUpperCase() === 'NONE') {
      j.blocked_stage = 'MTF_CONFLUENCE_BLOCK';
    }
    j._mtf_block_reason = String(
      (Array.isArray(j.mtf_confluence_reasons) && j.mtf_confluence_reasons.length ? j.mtf_confluence_reasons.join('; ') : '') ||
      (Array.isArray(j.ai_mtf_reasons) && j.ai_mtf_reasons.length ? j.ai_mtf_reasons.join('; ') : '') ||
      `mtf_confluence_score=${num(j.mtf_confluence_score)}<65 OR ai_mtf_confluence_score=${num(j.ai_mtf_confluence_score)}<65`
    );
    // Surface per-tier scores so audit triage can see which tier failed
    j._mtf_scalp_score = num(j.scalp_confluence_score);
    j._mtf_swing_score = num(j.swing_confluence_score);
    j._mtf_long_term_score = num(j.long_term_confluence_score);
    j._mtf_deterministic_score = num(j.mtf_confluence_score);
    j._mtf_ai_score = num(j.ai_mtf_confluence_score);
    j._mtf_profile = String(j.mtf_target_profile || j.target_profile || j.profile || 'SCALP').toUpperCase();
    j._mtf_block_version = 'QTP_MTF_AUDIT_VISIBILITY_20260521';
  }
  // === END QTP_MTF_AUDIT_VISIBILITY_20260521 ==="""


def get_key() -> str:
    for path in [
        WORKSPACE / "patch_qtp_bias_filter_composite_opposition_v60.py",
        WORKSPACE / "deploy_vc_gatekeeper_v61.py",
        WORKSPACE / "patch_qtp_mtf_confluence_v59.py",
    ]:
        if not path.exists():
            continue
        txt = path.read_text(errors="ignore")
        for pat in [r"key\s*=\s*'([^']+)'", r'key\s*=\s*"([^"]+)"', r"KEY\s*=\s*'([^']+)'", r'KEY\s*=\s*"([^"]+)"']:
            m = re.search(pat, txt)
            if m:
                return m.group(1)
    raise RuntimeError("Could not find n8n API key")


KEY = get_key()


def request_json(method: str, path: str, payload=None):
    data = None if payload is None else json.dumps(payload).encode()
    headers = {"X-N8N-API-KEY": KEY} if payload is None else {"X-N8N-API-KEY": KEY, "Content-Type": "application/json"}
    req = urllib.request.Request(f"{BASE}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        (OUTPUTS / "patch_mtf_audit_visibility_error.json").write_text(body)
        raise RuntimeError(f"n8n API failed: HTTP {e.code}: {body[:4000]}") from e


def marker_counts(text: str, original: str):
    checks = {
        "QTP_MTF_AUDIT_VISIBILITY_20260521": {"expected": 3, "actual": text.count("QTP_MTF_AUDIT_VISIBILITY_20260521")},
        "j._mtf_block_version = 'QTP_MTF_AUDIT_VISIBILITY_20260521'": {"expected": 1, "actual": text.count("j._mtf_block_version = 'QTP_MTF_AUDIT_VISIBILITY_20260521'")},
        "j.blocked_stage = 'MTF_CONFLUENCE_BLOCK'": {"expected": 1, "actual": text.count("j.blocked_stage = 'MTF_CONFLUENCE_BLOCK'")},
        "j.final_mtf_confluence_decision": {"expected": original.count("j.final_mtf_confluence_decision"), "actual": text.count("j.final_mtf_confluence_decision")},
        "j.final_mtf_confluence_pass": {"expected": original.count("j.final_mtf_confluence_pass") + 1, "actual": text.count("j.final_mtf_confluence_pass")},
        "return": {"expected": original.count("return"), "actual": text.count("return")},
    }
    for v in checks.values():
        v["pass"] = v["actual"] == v["expected"]
    return checks


def main():
    ts = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
    workflow = request_json("GET", f"/workflows/{WORKFLOW_ID}")
    wf_backup = OUTPUTS / f"pre_mtf_audit_visibility_20260521_{WORKFLOW_ID}_{ts}.json"
    wf_backup.write_text(json.dumps(workflow, indent=2))

    node = next((n for n in workflow["nodes"] if n.get("name") == TARGET_NODE or n.get("id") == TARGET_NODE_ID), None)
    if not node:
        raise RuntimeError(f"Target node not found: {TARGET_NODE}")
    if node.get("id") != TARGET_NODE_ID:
        raise RuntimeError(f"Target node id mismatch: {node.get('id')}")
    if node.get("type") != "n8n-nodes-base.code":
        raise RuntimeError(f"Target node type mismatch: {node.get('type')}")

    original = node.get("parameters", {}).get("jsCode", "")
    node_backup = OUTPUTS / f"merge_mtf_ai_verdict_pre_audit_visibility_{ts}.js"
    node_backup.write_text(original)

    if original.count("QTP_MTF_AUDIT_VISIBILITY_20260521") > 0:
        raise RuntimeError("Patch marker already present; refusing duplicate insert")
    if original.count(ANCHOR) != 1:
        raise RuntimeError(f"Anchor count mismatch: {original.count(ANCHOR)}")

    new_js = original.replace(ANCHOR, ANCHOR + PATCH_BLOCK)
    patched = OUTPUTS / f"merge_mtf_ai_verdict_patched_audit_visibility_{ts}.js"
    patched.write_text(new_js)
    subprocess.run(["node", "--check", str(patched)], check=True, capture_output=True, text=True)

    local_counts = marker_counts(new_js, original)
    if not all(v["pass"] for v in local_counts.values()):
        raise RuntimeError(f"Local marker check failed: {json.dumps(local_counts, indent=2)}")

    node.setdefault("parameters", {})["jsCode"] = new_js
    payload = {
        "name": workflow["name"],
        "nodes": workflow["nodes"],
        "connections": workflow.get("connections", {}),
        "settings": {},
    }
    updated = request_json("PUT", f"/workflows/{WORKFLOW_ID}", payload)
    refreshed = request_json("GET", f"/workflows/{WORKFLOW_ID}")
    deployed_node = next(n for n in refreshed["nodes"] if n.get("id") == TARGET_NODE_ID)
    deployed = deployed_node.get("parameters", {}).get("jsCode", "")
    deployed_counts = marker_counts(deployed, original)
    if not all(v["pass"] for v in deployed_counts.values()):
        raise RuntimeError(f"Deployed marker check failed: {json.dumps(deployed_counts, indent=2)}")

    result = {
        "ok": True,
        "workflow_id": WORKFLOW_ID,
        "workflow_name": refreshed.get("name"),
        "active": refreshed.get("active"),
        "versionId_before": workflow.get("versionId"),
        "versionId_after": refreshed.get("versionId"),
        "updatedAt": refreshed.get("updatedAt"),
        "target_node": TARGET_NODE,
        "target_node_id": TARGET_NODE_ID,
        "workflow_backup": str(wf_backup),
        "node_backup": str(node_backup),
        "patched_js": str(patched),
        "local_counts": local_counts,
        "deployed_counts": deployed_counts,
    }
    out = OUTPUTS / f"patch_mtf_audit_visibility_result_{ts}.json"
    out.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
