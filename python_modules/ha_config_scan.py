"""Blocking config-health helpers.

Plain Python (NOT pyscript) so pyscript can call it via task.executor, which
refuses interpreted functions. Does all filesystem work off the event loop.
"""

import json
import os
import re
import shutil
import time

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

# The key a line opens, in YAML ("description:") or in the pretty-printed JSON
# Home Assistant writes into .storage ('"description":').
LINE_KEY_RE = re.compile(r"^\s*(?:-\s*)?\"?([a-z_]+)\"?\s*:")

# Keys whose value is prose, a URL or a literal event name. Home Assistant
# never resolves a reference out of any of them, so an entity id inside one is
# documentation - and this install has a real example: an automation whose
# description names a deleted sensor deliberately, to say which one NOT to use.
# A textual scan without this list reports that as a broken reference.
#
# The same list as the card's PROSE_KEYS, deliberately. Two scanners that
# disagree about what counts as a reference produce findings that appear and
# disappear depending on which one ran.
PROSE_KEYS = {
    "description", "example", "documentation", "url", "note", "comment",
    "event_type", "logger", "unique_id", "webhook_id",
}


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


# A top-level item in automations.yaml / scenes.yaml ("- id: x") or in
# scripts.yaml ("script_object_id:"). Tracking it while scanning attributes
# a hit to the automation or script that holds it, not just to a line.
HOLDER_LIST_RE = re.compile(r"^-\s*id:\s*['\"]?([^'\"\s]+)")
HOLDER_MAP_RE = re.compile(r"^([a-z0-9_]+):\s*$")


def scan_files(ents, svcs, doms):
    found = {}
    files = 0
    dynamic = 0
    prose = 0
    # Every reference that resolves. A thing named nowhere in here is used
    # by nothing, which is what makes "safe to delete" answerable.
    used = set()
    # ...and where each one is named. This is the file half of the dependency
    # universe: without it, a template sensor whose source goes unavailable is
    # invisible to the Health page, because the card only ever sees
    # automations, scripts, scenes and dashboards.
    used_at = {}
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
        base = os.path.basename(path)
        track = base in ("automations.yaml", "scripts.yaml", "scenes.yaml")
        holder = None
        # Indent of a prose key whose value is still being read. A folded
        # description runs over several lines and only the first carries the
        # key, so the branch has to be closed by indentation.
        prose_indent = None
        for num, line in enumerate(text.split("\n"), 1):
            if is_yaml and line.lstrip().startswith("#"):
                continue
            stripped = line.lstrip()
            indent = len(line) - len(stripped)
            if prose_indent is not None:
                if stripped and indent > prose_indent:
                    prose += 1
                    continue
                prose_indent = None
            m_key = LINE_KEY_RE.match(line)
            if m_key and m_key.group(1) in PROSE_KEYS:
                prose += 1
                prose_indent = indent
                continue
            if track:
                m_h = HOLDER_LIST_RE.match(line) or HOLDER_MAP_RE.match(line)
                if m_h:
                    holder = m_h.group(1)
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
                if ref in ents or ref in svcs:
                    used.add(ref)
                    if ref in ents:
                        at = used_at.setdefault(ref, [])
                        # Four places is already more than anyone reads, and one
                        # dashboard can name the same sensor thirty times. The
                        # cap is also what keeps the published payload in the
                        # low hundreds of kilobytes.
                        if len(at) < 4:
                            occ = {"file": rel, "line": num, "category": cat}
                            if holder:
                                occ["holder"] = holder
                            at.append(occ)
                    continue
                if m.group(1) not in doms:
                    continue
                rec = found.setdefault(
                    ref,
                    {"entity_id": ref, "category": cat, "occurrences": [],
                     "malformed": nxt == "."},
                )
                if len(rec["occurrences"]) < 12:
                    occ = {"file": rel, "line": num}
                    if holder:
                        occ["holder"] = holder
                    rec["occurrences"].append(occ)
    return found, files, dynamic, used, used_at, prose


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


def entry_refs(known):
    """Every entity reference held by a config entry -> the entries holding it.

    The line scanner cannot attribute these: Home Assistant writes each config
    entry as one enormous line, so `line 21` says nothing and a `unique_id`
    that happens to concatenate two entity ids sits on the same line as the
    real references. Walking the JSON instead gives a field path and the
    entry's title, and skips the keys that only look like references.

    `known` is the set of entity ids that exist, so this returns dependencies
    rather than candidates - the missing ones already come back from
    entry_owners().
    """
    out = {}
    try:
        with open(CONFIG_ENTRIES, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return out
    for entry in data.get("data", {}).get("entries", []):
        seen = {}

        def walk(node, path):
            if isinstance(node, dict):
                for k, v in node.items():
                    if k in PROSE_KEYS:
                        continue
                    walk(v, (path + "." + str(k)) if path else str(k))
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    walk(v, "%s[%d]" % (path, i))
            elif isinstance(node, str):
                for m in REF_RE.finditer(node):
                    ref = m.group(0)
                    if ref in known and ref not in seen:
                        seen[ref] = path

        walk({"data": entry.get("data"), "options": entry.get("options")}, "")
        for ref, field in seen.items():
            out.setdefault(ref, []).append({
                "entry_id": entry.get("entry_id"),
                "domain": entry.get("domain"),
                "title": entry.get("title"),
                "field": field,
            })
    return out


DEPS_FILE = os.path.join(CONFIG_DIR, "config_health_deps.json")


# --- notification incident state --------------------------------------
#
# What the phone has already been told about. Kept beside the configuration
# rather than in a browser: the answer has to survive a restart, and it has to
# be the same answer whichever tablet or phone last looked at the page.
#
# Deliberately its own file. Mixing it into the ignore list would put machine
# bookkeeping into something the user is invited to hand-edit.
NOTIFY_STATE_FILE = os.path.join(CONFIG_DIR, "config_health_notification_state.json")

NOTIFY_STATE_EMPTY = {
    "version": 1,
    "updated": None,
    "last_scan": None,
    "last_successful_scan": None,
    "grace_until": None,
    "incidents": {},
}


def load_notify_state():
    try:
        with open(NOTIFY_STATE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return dict(NOTIFY_STATE_EMPTY, incidents={})
    if not isinstance(data, dict) or not isinstance(data.get("incidents"), dict):
        return dict(NOTIFY_STATE_EMPTY, incidents={})
    out = dict(NOTIFY_STATE_EMPTY, incidents={})
    out.update({k: v for k, v in data.items() if k in NOTIFY_STATE_EMPTY})
    out["incidents"] = data.get("incidents") or {}
    return out


IMPAIRED_STABLE_SECONDS = 300

# --- per-install options ----------------------------------------------
#
# Where to push, and where a tap should land. These are the only two settings
# that are specific to one house, so they live in a small file next to the
# configuration rather than in the source - which keeps the published code
# identical to the deployed code, and keeps one person's phone out of it.
#
# /config/config_health_options.json
#   {
#     "notify_service": "mobile_app_my_phone",
#     "notify_url": "/lovelace/health"
#   }
#
# `notify_service` is the part after `notify.` in Developer tools -> Actions.
# Leave the file out entirely and notifications simply stay off.
OPTIONS_FILE = os.path.join(CONFIG_DIR, "config_health_options.json")

DEFAULT_OPTIONS = {
    "notify_service": None,
    "notify_url": "/lovelace/0",
    "impaired_stable_seconds": IMPAIRED_STABLE_SECONDS,
}


def load_options():
    """Per-install settings, or the defaults. Never raises."""
    out = dict(DEFAULT_OPTIONS)
    try:
        with open(OPTIONS_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return out
    if isinstance(data, dict):
        for key in out:
            if data.get(key) is not None:
                out[key] = data[key]
    return out


def _epoch(stamp):
    if not stamp:
        return None
    try:
        return time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
    except Exception:
        return None


def decide_notifications(findings, state, now_ts, background,
                         stable=IMPAIRED_STABLE_SECONDS):
    """Fold the current findings into the incident store and say what is new.

    Pure, so the rules can be tested rather than hoped for. It mutates and
    returns `state["incidents"]`, and returns the findings that have earned a
    push.

    The rules, in full:

      - a fingerprint not in the store is a new incident, recorded with the
        time it was first seen and nothing sent yet
      - a BROKEN incident is pushable at once: the configuration says so
        whether or not anything is switched on
      - an IMPAIRED incident is pushable only once it has been continuously
        present for `stable` seconds, because a device blinking out for three
        seconds is not news
      - an incident already notified is never notified again
      - an incident that clears is deleted, so if it comes back it is a new
        incident and does notify again
      - warnings, ignored and unvalidated findings never appear here at all
      - a manual scan (`background=False`) updates everything and sends
        nothing, so pressing Rescan to look at the page is always quiet
      - the startup grace window has the same effect as a manual scan
    """
    now_stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now_ts))
    incidents = state.setdefault("incidents", {})
    actionable = [f for f in findings if f.get("severity") in ("broken", "impaired")]
    live = set()
    fresh = []

    for f in actionable:
        fp = f["fp"]
        live.add(fp)
        rec = incidents.get(fp)
        if rec is None:
            rec = {
                "kind": f.get("kind"), "ref": f.get("ref"), "owner": f.get("owner"),
                "name": f.get("owner_name"), "severity": f.get("severity"),
                "first_seen": now_stamp, "notified": None,
            }
            incidents[fp] = rec
        if rec.get("notified"):
            continue
        if f["severity"] == "impaired":
            seen_at = _epoch(rec.get("first_seen"))
            if seen_at is None or now_ts - seen_at < stable:
                continue
        fresh.append(f)

    for fp in [k for k in list(incidents) if k not in live]:
        del incidents[fp]

    state["updated"] = now_stamp
    grace = _epoch(state.get("grace_until"))
    if grace is not None and now_ts < grace:
        background = False
    if not background:
        return [], incidents
    for f in fresh:
        incidents[f["fp"]]["notified"] = now_stamp
    return fresh, incidents


MAX_LISTED = 6


def notification_text(fresh):
    """One message for however many problems appeared, never one each."""
    n = len(fresh)
    lines = ["%d new configuration problem%s" % (n, "" if n == 1 else "s"), ""]
    if n <= MAX_LISTED:
        for f in fresh:
            lines.append("• %s — %s"
                         % (f.get("owner_name") or "?", (f.get("problem") or "").lower()))
    else:
        buckets = {}
        for f in fresh:
            if f["severity"] == "broken":
                key = "broken %s%s" % (f.get("owner_type") or "item",
                                       "" if (f.get("owner_type") or "").endswith("s") else "s")
            else:
                key = "impaired dependencies"
            buckets[key] = buckets.get(key, 0) + 1
        for key in sorted(buckets):
            label = key
            if buckets[key] == 1 and label.endswith("s"):
                label = label[:-1]
            lines.append("• %d %s" % (buckets[key], label))
        lines.append("")
        lines.append("Tap to open Health")
    return "Home Assistant Health", "\n".join(lines).strip()


def save_notify_state(state):
    tmp = NOTIFY_STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=1, ensure_ascii=False, sort_keys=True)
    os.replace(tmp, NOTIFY_STATE_FILE)
    return os.path.getsize(NOTIFY_STATE_FILE)


# --- the human-readable report ----------------------------------------

REPORT_FILE = os.path.join(CONFIG_DIR, "config_health_report.txt")

SECTION_TITLE = {
    "broken": "BROKEN CONFIGURATION",
    "impaired": "IMPAIRED CONFIGURATION",
    "warning": "WARNINGS",
}


def render_report(summary, findings, ignored):
    """A report a person can read, not a data dump.

    Nothing here is fetched: it renders what the scan already worked out. No
    secret can reach it because it only ever prints entity ids, friendly names
    and the file and line a reference was found on - secrets.yaml is not
    scanned, and the prose keys that could carry a URL or a token are dropped
    before a reference is ever recorded.
    """
    lines = []
    add = lines.append
    add("HOME ASSISTANT CONFIGURATION HEALTH")
    add("")
    add("Generated: %s" % summary.get("generated"))
    add("Status: %s" % str(summary.get("status", "unknown")).upper())
    if summary.get("status") == "error":
        add("Last successful scan: %s" % (summary.get("last_successful_scan") or "never"))
        add("Error: %s" % summary.get("error"))
    add("")
    add("BROKEN:   %d" % summary.get("broken", 0))
    add("IMPAIRED: %d" % summary.get("impaired", 0))
    add("WARNINGS: %d" % summary.get("warnings", 0))
    add("IGNORED:  %d" % len(ignored or ()))
    add("")

    for severity in ("broken", "impaired", "warning"):
        rows = [f for f in findings if f["severity"] == severity]
        add(SECTION_TITLE[severity])
        if not rows:
            add("  None")
            add("")
            continue
        rows.sort(key=lambda f: (f.get("owner_name") or "", f.get("ref") or ""))
        for f in rows:
            add("  %s  (%s)" % (f.get("owner_name") or "?", f.get("owner_type") or "?"))
            detail = "    %s: %s" % (f.get("problem"), f.get("ref"))
            if severity == "impaired" and f.get("for"):
                detail += "  -  for %s" % f["for"]
            add(detail)
            if f.get("where"):
                add("    at %s" % f["where"])
        add("")

    if ignored:
        add("IGNORED (not counted above)")
        for rule, hits in sorted(ignored.items()):
            add("  %s  -  %d hidden" % (rule, hits))
        add("")

    add("Scanned %s files, %s dependencies tracked, %s prose lines skipped,"
        % (summary.get("files"), summary.get("dependencies"), summary.get("prose_skipped")))
    add("%s dynamic references could not be checked statically."
        % summary.get("dynamic_refs"))
    return "\n".join(lines) + "\n"


def write_report(text):
    tmp = REPORT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.replace(tmp, REPORT_FILE)
    return os.path.getsize(REPORT_FILE)


def save_deps(payload):
    """Write the dependency universe next to the configuration.

    Not a state attribute: several hundred edges is far more than belongs in
    the state machine, where every one of them would be recorded, replicated to
    every browser on every change, and counted against the attribute size the
    recorder is willing to carry. The card asks for it by service call instead,
    and this file is what that service answers from - so it also survives a
    restart without waiting for the startup scan.
    """
    tmp = DEPS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))
    os.replace(tmp, DEPS_FILE)
    return os.path.getsize(DEPS_FILE)


def load_deps():
    try:
        with open(DEPS_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {"generated": None, "deps": []}


def dashboard_url_path(storage_file):
    """.storage/lovelace.dashboard_energy -> dashboard-energy ; default -> None"""
    name = storage_file.split("/")[-1]
    if not name.startswith("lovelace"):
        return None
    rest = name[len("lovelace"):].lstrip(".")
    if not rest or rest == "lovelace":
        return None
    return rest.replace("dashboard_", "dashboard-", 1) if rest.startswith("dashboard_") else rest


ENTITY_REGISTRY = os.path.join(CONFIG_DIR, ".storage", "core.entity_registry")


def entry_entities(entry_ids):
    """{config_entry_id: [entity_id, ...]} for the given entries.

    config_entry_id only exists in the entity registry, so the mapping cannot
    be had from the state machine. Reading the file directly keeps this with
    the rest of the blocking work.
    """
    want = set(entry_ids or ())
    out = {e: [] for e in want}
    if not want:
        return out
    try:
        with open(ENTITY_REGISTRY, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return out
    for ent in data.get("data", {}).get("entities", []):
        cid = ent.get("config_entry_id")
        if cid in want:
            out[cid].append(ent.get("entity_id"))
    return out


# --- ignore rules -------------------------------------------------------
#
# Findings the user has reviewed and accepted. Kept in a plain file next to the
# configuration rather than in the browser, because the same answer has to hold
# on every tablet and survive a restart. Small, hand-editable, and outside
# .storage so Home Assistant never rewrites it underneath us.

# --- one classification, shared by everything -------------------------
#
# The card decides missing / disabled / unavailable / unknown for the
# references it can see; this decides it for the references only the file
# scanner can see, and for the health entities, which have to keep answering
# when no browser is open. Two implementations of the same ladder is how they
# start disagreeing, so the ladder lives here as one pure function and the
# test suite asserts both halves agree on the same fixture.
#
# Precedence is fixed and total:
#
#   missing      in neither the state machine nor the registry  -> BROKEN
#   disabled     in the registry, disabled_by set               -> WARNING
#   unavailable  exists, enabled, state is "unavailable"        -> IMPAIRED
#   unknown      exists, enabled, state is "unknown"            -> IMPAIRED
#   healthy      anything else                                  -> nothing
#
# "off", "closed", "idle", "standby", "not_home" and every other real state
# are a working entity doing its job.
IMPAIRED_STATES = {"unavailable": "entity-unavailable", "unknown": "entity-unknown"}

SEVERITY_OF_KIND = {
    "entity": "broken",
    "device": "broken",
    "area": "broken",
    "service": "broken",
    "entity-unavailable": "impaired",
    "entity-unknown": "impaired",
    "entity-disabled": "warning",
}

# Worst first. The overall status is the worst severity present.
STATUS_ORDER = ["broken", "impaired", "warning", "healthy"]


def classify(entity_id, state, in_registry, disabled):
    """(kind, severity) for one referenced entity, or (None, None) if healthy."""
    if state is None and not in_registry:
        return "entity", "broken"
    if disabled:
        return "entity-disabled", "warning"
    kind = IMPAIRED_STATES.get(state)
    if kind:
        return kind, "impaired"
    return None, None


def worst(severities):
    for level in STATUS_ORDER:
        if level in severities:
            return level
    return "healthy"


# --- ignore matching ---------------------------------------------------
#
# The same six scopes the card applies, applied again here so a rule the user
# wrote on the Health page also quiets the sensor and the phone. A finding
# hidden on the page that still pushed a notification would be worse than no
# ignore system at all.


def glob_to_re(pattern):
    """`*` and `?` only; everything else is a literal."""
    out = ["^"]
    for ch in str(pattern):
        if ch == "*":
            out.append(".*")
        elif ch == "?":
            out.append(".")
        else:
            out.append(re.escape(ch))
    out.append("$")
    return re.compile("".join(out))


def ignore_matches(rule, kind, ref, item_key, labels):
    scope = rule.get("scope")
    value = rule.get("value")
    if scope == "ref":
        return ref == value
    if scope == "pattern":
        try:
            return bool(ref) and bool(glob_to_re(value).match(ref))
        except Exception:
            return False
    if scope == "item":
        return item_key == value
    if scope == "kind":
        if kind != value:
            return False
        return not rule.get("item") or rule["item"] == item_key
    if scope == "label":
        return value in (labels or ())
    return False


def is_ignored(rules, kind, ref, item_key, labels):
    for rule in rules or ():
        if ignore_matches(rule, kind, ref, item_key, labels):
            return rule.get("id") or "%s:%s" % (rule.get("scope"), rule.get("value"))
    return None


IGNORE_FILE = os.path.join(CONFIG_DIR, "config_health_ignores.json")
IGNORE_SCOPES = ("ref", "pattern", "item", "kind", "label")


def load_ignores():
    """The stored rules, or an empty set. Never raises: a corrupt file must not
    take the scan down with it."""
    try:
        with open(IGNORE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return []
    except Exception:
        return []
    rules = data.get("rules") if isinstance(data, dict) else data
    if not isinstance(rules, list):
        return []
    out = []
    for r in rules:
        if not isinstance(r, dict):
            continue
        if r.get("scope") not in IGNORE_SCOPES or not r.get("value"):
            continue
        out.append({
            "id": r.get("id") or "",
            "scope": r["scope"],
            "value": str(r["value"]),
            "item": r.get("item") or None,
            "kind": r.get("kind") or None,
            "note": r.get("note") or None,
            "added": r.get("added") or None,
        })
    return out


def save_ignores(rules, stamp):
    with open(IGNORE_FILE, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "updated": stamp, "rules": rules}, fh, indent=2)
    return len(rules)
