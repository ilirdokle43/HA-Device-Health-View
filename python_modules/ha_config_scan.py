"""Blocking config-health helpers.

Plain Python (NOT pyscript) so pyscript can call it via task.executor, which
refuses interpreted functions. Does all filesystem work off the event loop.
"""

import json
import os
import re
import shutil

SCANNER_VERSION = "v5-owners"
CONFIG_DIR = "/config"
STATE_ENTITY = "pyscript.config_health"

SKIP_DIRS = {
    ".git", ".cloud", ".storage", "custom_components", "deps", "www",
    "blueprints", "themes", "tts", "image", "esphome", "zigbee2mqtt",
    "solcast_solar", "gosungrow", ".cache", "backups", "node_modules",
}
STORAGE_PREFIXES = ("core.config_entries", "lovelace")

REF_RE = re.compile(
    r"(?<![A-Za-z0-9_.])([a-z][a-z0-9_]*)\.([a-z0-9_]{2,})(?![A-Za-z0-9_])"
)
TOP_KEY_RE = re.compile(r"^([a-z_]+):")
# "trigger: switch.turned_on" and "platform: sensor.x" name a trigger or
# platform, not an entity.
KEYWORD_RE = re.compile(r"(trigger|platform|service|action)\"?\s*:\s*\"?$")


def _top_key(path):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            for line in fh:
                m = TOP_KEY_RE.match(line)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return ""


def _category(path):
    name = os.path.basename(path)
    if "lovelace" in name:
        return "dashboard"
    if name == "core.config_entries":
        return "other"
    if name == "automations.yaml":
        return "automation"
    if name == "scripts.yaml":
        return "script"
    if name == "scenes.yaml":
        return "scene"
    return {"automation": "automation", "script": "script",
            "scene": "scene"}.get(_top_key(path), "other")


def _iter_files():
    for root, dirs, files in os.walk(CONFIG_DIR):
        rel = os.path.relpath(root, CONFIG_DIR)
        if rel != "." and set(rel.split(os.sep)) & SKIP_DIRS:
            dirs[:] = []
            continue
        for name in files:
            if name.endswith((".yaml", ".yml")):
                yield os.path.join(root, name)
    storage = os.path.join(CONFIG_DIR, ".storage")
    if os.path.isdir(storage):
        for name in sorted(os.listdir(storage)):
            if name.startswith(STORAGE_PREFIXES):
                yield os.path.join(storage, name)


def _suggest(ref, ents):
    dom, obj = ref.split(".", 1)
    toks = set(obj.split("_"))
    best, score = None, 0.0
    for cand in ents:
        if not cand.startswith(dom + "."):
            continue
        other = set(cand.split(".", 1)[1].split("_"))
        if not other:
            continue
        val = len(toks & other) / max(len(toks), len(other))
        if val > score:
            best, score = cand, val
    return best, round(score, 3)


def scan_files(ents, svcs, doms):
    found = {}
    files = 0
    dynamic = 0
    for path in _iter_files():
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except Exception:
            continue
        files += 1
        cat = _category(path)
        rel = os.path.relpath(path, CONFIG_DIR)
        is_yaml = path.endswith((".yaml", ".yml"))
        for num, line in enumerate(text.split("\n"), 1):
            if is_yaml and line.lstrip().startswith("#"):
                continue
            for m in REF_RE.finditer(line):
                ref = m.group(0)
                nxt = line[m.end():m.end() + 1]
                # "light.foo_{{ x }}" / "fan.123_*" are built at runtime
                if ref.endswith("_") or nxt in ("{", "*"):
                    dynamic += 1
                    continue
                if KEYWORD_RE.search(line[:m.start()]):
                    continue
                # prose such as "switch.turned_on/turned_off" in a description
                if nxt == "/":
                    continue
                if m.group(1) not in doms or ref in ents or ref in svcs:
                    continue
                rec = found.setdefault(
                    ref,
                    {"entity_id": ref, "category": cat, "occurrences": [],
                     "malformed": nxt == "."},
                )
                if len(rec["occurrences"]) < 12:
                    rec["occurrences"].append({"file": rel, "line": num})
    return found, files, dynamic


def fix_files(targets, entity_id, replacement, stamp):
    """Blocking file rewrite; always run through task.executor."""
    changed = []
    for rel in targets:
        path = os.path.join(CONFIG_DIR, rel)
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
        if entity_id not in text:
            continue
        shutil.copy2(path, f"{path}.bak-{stamp}")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text.replace(entity_id, replacement))
        changed.append(f"{rel} x{text.count(entity_id)}")
    return changed


CONFIG_ENTRIES = os.path.join(CONFIG_DIR, ".storage", "core.config_entries")


def entry_owners(missing_ids):
    """entity id -> owning config entries. Skips unique_id, which only looks
    like an entity reference."""
    out = {}
    try:
        with open(CONFIG_ENTRIES, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return out
    for entry in data.get("data", {}).get("entries", []):
        hits = []

        def walk(node, path):
            if isinstance(node, dict):
                for k, v in node.items():
                    if k == "unique_id":
                        continue
                    walk(v, path + "." + str(k))
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, "%s[%d]" % (path, i))
            elif isinstance(node, str):
                for m in missing_ids:
                    if m in node:
                        hits.append((m, path))

        walk({"data": entry.get("data"), "options": entry.get("options")}, "")
        for m, path in hits:
            out.setdefault(m, []).append({
                "entry_id": entry.get("entry_id"),
                "domain": entry.get("domain"),
                "title": entry.get("title"),
                "field": path,
            })
    return out


def dashboard_url_path(storage_file):
    """.storage/lovelace.dashboard_energji -> dashboard-energji ; default -> None"""
    name = storage_file.split("/")[-1]
    if not name.startswith("lovelace"):
        return None
    rest = name[len("lovelace"):].lstrip(".")
    if not rest or rest == "lovelace":
        return None
    return rest.replace("dashboard_", "dashboard-", 1) if rest.startswith("dashboard_") else rest
