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
TARGET_NODE = "QTP Multi-Timeframe Confluence Engine"
TARGET_NODE_ID = "qtp-mtf-confluence-engine-v59"

OLD_SCALP_WEIGHT = "  if (profile === 'SCALP') return clamp((scalp * 0.55) + (swing * 0.30) + (longTerm * 0.15));"
NEW_SCALP_WEIGHT = """  // QTP_MTF_SCALP_REWEIGHT_v6.2_20260521: long_term tier has no weight for SCALP
  // because its inputs (quality_score, value_score, earnings_trend, etc.) are
  // fundamentals that intraday signals never carry. See audit history pre-2026-05-21:
  // 0/5969 signals ever cleared mtf_confluence_score >= 65 because long_term
  // defaulted to ~27 and consumed 15% weight.
  if (profile === 'SCALP') return clamp((scalp * 0.65) + (swing * 0.35) + (longTerm * 0.00));"""

OLD_SCALP_FLOOR = "    profile === 'SCALP' ? (scalpScore >= 60 && swingScore >= 45) :"
NEW_SCALP_FLOOR = """    // QTP_MTF_SCALP_REWEIGHT_v6.2_20260521: long_term floor dropped for SCALP; scalp/swing floors unchanged.
    profile === 'SCALP' ? (scalpScore >= 60 && swingScore >= 45) :"""

OLD_VERSION = "j.mtf_confluence_engine_v = 'QTP_MTF_CONFLUENCE_v5.9_20260519';"
NEW_VERSION = "j.mtf_confluence_engine_v = 'QTP_MTF_CONFLUENCE_v6.2_20260521';"

SWING_WEIGHT = "if (profile === 'SWING') return clamp((scalp * 0.20) + (swing * 0.55) + (longTerm * 0.25));"
LONG_WEIGHT = "return clamp((scalp * 0.10) + (swing * 0.30) + (longTerm * 0.60));"
SWING_FLOOR = "profile === 'SWING' ? (swingScore >= 60 && scalpScore >= 45) :"
LONG_FLOOR = "(longTermScore >= 60 && swingScore >= 50);"


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
        (OUTPUTS / "patch_mtf_scalp_reweight_error.json").write_text(body)
        raise RuntimeError(f"n8n API failed: HTTP {e.code}: {body[:4000]}") from e


def verify_counts(text: str):
    checks = {
        "QTP_MTF_SCALP_REWEIGHT_v6.2_20260521": {"expected": 2, "actual": text.count("QTP_MTF_SCALP_REWEIGHT_v6.2_20260521")},
        "QTP_MTF_CONFLUENCE_v6.2_20260521": {"expected": 1, "actual": text.count("QTP_MTF_CONFLUENCE_v6.2_20260521")},
        "(scalp * 0.65) + (swing * 0.35) + (longTerm * 0.00)": {"expected": 1, "actual": text.count("(scalp * 0.65) + (swing * 0.35) + (longTerm * 0.00)")},
        "(scalp * 0.55) + (swing * 0.30) + (longTerm * 0.15)": {"expected": 0, "actual": text.count("(scalp * 0.55) + (swing * 0.30) + (longTerm * 0.15)")},
        "(scalp * 0.20) + (swing * 0.55) + (longTerm * 0.25)": {"expected": 1, "actual": text.count("(scalp * 0.20) + (swing * 0.55) + (longTerm * 0.25)")},
        "(scalp * 0.10) + (swing * 0.30) + (longTerm * 0.60)": {"expected": 1, "actual": text.count("(scalp * 0.10) + (swing * 0.30) + (longTerm * 0.60)")},
    }
    for v in checks.values():
        v["pass"] = v["actual"] == v["expected"]
    return checks


def main():
    ts = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%SZ")
    workflow = request_json("GET", f"/workflows/{WORKFLOW_ID}")
    wf_backup = OUTPUTS / f"pre_mtf_scalp_reweight_v62_20260521_{WORKFLOW_ID}_{ts}.json"
    wf_backup.write_text(json.dumps(workflow, indent=2))
    node = next((n for n in workflow["nodes"] if n.get("name") == TARGET_NODE or n.get("id") == TARGET_NODE_ID), None)
    if not node:
        raise RuntimeError(f"Target node not found: {TARGET_NODE}")
    if node.get("id") != TARGET_NODE_ID:
        raise RuntimeError(f"Target node id mismatch: {node.get('id')}")
    if node.get("type") != "n8n-nodes-base.code":
        raise RuntimeError(f"Target node type mismatch: {node.get('type')}")

    original = node.get("parameters", {}).get("jsCode", "")
    node_backup = OUTPUTS / f"mtf_confluence_engine_pre_scalp_reweight_{ts}.js"
    node_backup.write_text(original)

    pre_assertions = {
        "old_scalp_weight": original.count(OLD_SCALP_WEIGHT),
        "old_scalp_floor": original.count(OLD_SCALP_FLOOR),
        "old_version": original.count(OLD_VERSION),
        "swing_weight": original.count(SWING_WEIGHT),
        "long_weight": original.count(LONG_WEIGHT),
        "swing_floor": original.count(SWING_FLOOR),
        "long_floor": original.count(LONG_FLOOR),
        "existing_v62_marker": original.count("QTP_MTF_SCALP_REWEIGHT_v6.2_20260521"),
    }
    expected_pre = {
        "old_scalp_weight": 1,
        "old_scalp_floor": 1,
        "old_version": 1,
        "swing_weight": 1,
        "long_weight": 1,
        "swing_floor": 1,
        "long_floor": 1,
        "existing_v62_marker": 0,
    }
    if pre_assertions != expected_pre:
        raise RuntimeError(f"Precondition mismatch: {json.dumps({'actual': pre_assertions, 'expected': expected_pre}, indent=2)}")

    new_js = original.replace(OLD_SCALP_WEIGHT, NEW_SCALP_WEIGHT)
    new_js = new_js.replace(OLD_SCALP_FLOOR, NEW_SCALP_FLOOR)
    new_js = new_js.replace(OLD_VERSION, NEW_VERSION)

    patched = OUTPUTS / f"mtf_confluence_engine_scalp_reweight_v62_{ts}.js"
    patched.write_text(new_js)
    subprocess.run(["node", "--check", str(patched)], check=True, capture_output=True, text=True)
    counts = verify_counts(new_js)
    if not all(v["pass"] for v in counts.values()):
        raise RuntimeError(f"Local marker check failed: {json.dumps(counts, indent=2)}")

    byte_identical = {
        "swing_weight_preserved": SWING_WEIGHT in new_js and new_js.count(SWING_WEIGHT) == original.count(SWING_WEIGHT),
        "long_weight_preserved": LONG_WEIGHT in new_js and new_js.count(LONG_WEIGHT) == original.count(LONG_WEIGHT),
        "swing_floor_preserved": SWING_FLOOR in new_js and new_js.count(SWING_FLOOR) == original.count(SWING_FLOOR),
        "long_floor_preserved": LONG_FLOOR in new_js and new_js.count(LONG_FLOOR) == original.count(LONG_FLOOR),
    }
    if not all(byte_identical.values()):
        raise RuntimeError(f"SWING/LONG preservation failed: {json.dumps(byte_identical, indent=2)}")

    node.setdefault("parameters", {})["jsCode"] = new_js
    payload = {
        "name": workflow["name"],
        "nodes": workflow["nodes"],
        "connections": workflow.get("connections", {}),
        "settings": {},
    }
    request_json("PUT", f"/workflows/{WORKFLOW_ID}", payload)
    refreshed = request_json("GET", f"/workflows/{WORKFLOW_ID}")
    deployed = next(n for n in refreshed["nodes"] if n.get("id") == TARGET_NODE_ID).get("parameters", {}).get("jsCode", "")
    deployed_counts = verify_counts(deployed)
    if not all(v["pass"] for v in deployed_counts.values()):
        raise RuntimeError(f"Deployed marker check failed: {json.dumps(deployed_counts, indent=2)}")

    deployed_file = OUTPUTS / f"mtf_confluence_engine_deployed_scalp_reweight_v62_{ts}.js"
    deployed_file.write_text(deployed)

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
        "deployed_js": str(deployed_file),
        "byte_identical_preservation": byte_identical,
        "local_counts": counts,
        "deployed_counts": deployed_counts,
    }
    out = OUTPUTS / f"patch_mtf_scalp_reweight_v62_result_{ts}.json"
    out.write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
