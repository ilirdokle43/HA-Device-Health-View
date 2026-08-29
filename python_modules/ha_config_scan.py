"""Blocking config-health helpers.

Plain Python (NOT pyscript) so pyscript can call it via task.executor, which
refuses interpreted functions. Does all filesystem work off the event loop.
"""

import datetime
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
    # The device-registry label that means "leave this one alone". The card
    # writes it from its Skip button; this is only here so an install that
    # renamed it stays consistent across both halves.
    "skip_label": "skip_health_checks",
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


# Severities that can reach a phone. `execution` and `system` join the
# original two because they are the same kind of statement: something is
# wrong now and a person can do something about it. They push immediately,
# like `broken` - an add-on that has crashed or an automation whose actions
# are failing is not going to become less true if it is left for five
# minutes, and unlike `impaired` there is no flicker to wait out.
PUSHABLE = ("broken", "impaired", "execution", "system")

IMMEDIATE = ("broken", "execution", "system")


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
    actionable = [f for f in findings
                  if f.get("severity") in PUSHABLE]
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
        if f["severity"] not in IMMEDIATE:
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
    kinds = {f.get("severity") for f in fresh}
    if kinds <= {"execution"}:
        noun = "execution error"
    elif kinds <= {"system"}:
        noun = "system problem"
    elif kinds <= {"broken", "impaired"}:
        noun = "configuration problem"
    else:
        noun = "problem"
    lines = ["%d new %s%s" % (n, noun, "" if n == 1 else "s"), ""]
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
            elif f["severity"] == "execution":
                key = "failing automations"
            elif f["severity"] == "system":
                key = "system problems"
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

# Domains for which `unknown` is the resting state rather than a fault. A
# button's state is the timestamp of its last press, a scene's the last time it
# was applied; one not fired since Home Assistant started reads `unknown`
# forever. The card excludes the same domains from device health for exactly
# this reason, and the two halves have to agree or the page and the phone would
# disagree about the same entity.
#
# `unavailable` is deliberately not excluded: a button that has gone
# unavailable means the hardware has left the network, and that is news.
UNKNOWN_IS_IDLE_DOMAINS = {
    "button", "input_button", "event", "notify", "image", "scene",
    "conversation", "tts", "stt", "wake_word", "ai_task", "todo", "update",
    "person", "device_tracker", "siren", "remote", "infrared",
    "radio_frequency", "media_player",
}

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
        if state == "unknown" and entity_id.split(".", 1)[0] in UNKNOWN_IS_IDLE_DOMAINS:
            return None, None
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


# ======================================================================
# OPERATIONAL HEALTH
#
# Everything below answers a different question from the rest of this file.
# The scanner above asks "does this configuration point at something that
# exists". These ask "is the house working right now" - and the answer comes
# from Home Assistant's own structured state rather than from parsing files.
#
# The pump incident is why this exists. On 2026-08-29 a water-safety
# automation tried to switch off a running pump 94 times in 93 minutes and
# failed every time, because the Zigbee plug would not answer. Every
# reference in that automation was valid, every entity existed, the
# automation ran on schedule - and the configuration scanner had nothing to
# say, because nothing was broken. The action failed. That is a third thing,
# and it needed its own name.
# ======================================================================

# --- the log window ---------------------------------------------------
#
# `system_log` already does the hard part. Home Assistant keeps every
# WARNING and ERROR in memory, deduplicated by (logger, source line), with a
# running count and the first and last time it was seen. Ninety-four
# identical failures arrive as ONE record with count 94 - which is exactly
# the consolidation this feature needs, for free.
#
# What it does not give is a rate. `count` is cumulative since the record
# first appeared, so "three failures in the last hour" cannot be read off it.
# That is what the snapshot file is for: each poll stores (timestamp, count)
# per key, the series is trimmed to the window, and the difference between
# the newest and oldest sample in the series is the number of failures inside
# it. Poll every five minutes and the answer is accurate to five minutes,
# which is finer than any threshold here needs.
LOG_STATE_FILE = os.path.join(CONFIG_DIR, "config_health_log_state.json")

# How long "recently" means when counting failures.
LOG_WINDOW_SECONDS = 3600

# An automation or script whose actions failed this many times inside the
# window is a problem worth showing. Below it, the failure is kept as history
# and nothing is raised: a service call that failed once because a device was
# asleep is not news, and a page that says so is a page nobody reads.
EXEC_ACTIONABLE = 3

# The same, for an automation the user has labelled safety-critical. One
# failed attempt to shut off a pump is already the whole story. This applies
# only to automations carrying the label below - it is never inferred from
# what an automation is called.
EXEC_SAFETY_ACTIONABLE = 1

# No new failure for this long and the incident stops being current. It stays
# on the page as recovered for EXEC_RETAIN_SECONDS so there is a record of
# what happened, then disappears.
EXEC_RECOVER_SECONDS = 900
# Long enough that an incident at breakfast is still on the page after work.
# Six hours was the first choice and it was too short: the pump failed at
# 05:31 and had already vanished by the afternoon, which is exactly when
# someone would come looking for it.
EXEC_RETAIN_SECONDS = 24 * 3600

# An integration failing behind a config entry that still says `loaded`.
#
# The first draft of this rule was a burst rate - ten errors in an hour - and
# it was wrong. Measured against the install it was written for, the camera
# that had been rejecting every poll with HTTP 401 for four days averaged
# 6.4 errors an hour, and would have been missed by the very rule meant to
# catch it. What distinguishes that failure from a network blip is not how
# fast it fails but how long it has been failing: twenty hours and counting
# versus two errors and done.
#
# So there are two ways in. A burst inside the window, which catches an
# integration that has just fallen over; and persistence, which catches one
# that has been quietly failing since before anyone was watching. Both
# require the errors to be CURRENT - an integration that stopped throwing an
# hour ago has recovered, whatever it did before.
INTEG_ACTIONABLE = 10
INTEG_RECENT_SECONDS = 900

# Persistence: still failing, has been for this long, and has produced enough
# to rule out a handful of retries around a reboot.
INTEG_CRITICAL_SECONDS = 6 * 3600
INTEG_CRITICAL_COUNT = 20
INTEG_PERSISTENT_SECONDS = 3600
INTEG_PERSISTENT_COUNT = 10

# Backups. The schedule on this install is daily, so two missed days is the
# first moment something is actually wrong.
BACKUP_WARN_SECONDS = 48 * 3600
BACKUP_CRITICAL_SECONDS = 7 * 24 * 3600

# Loggers that are noise no matter how often they fire. Each one is here
# because it was measured, not because it looked unimportant.
LOG_IGNORE_PREFIXES = (
    # Browser-side crashes reported back by the companion app. 247 of them in
    # four days, every one "Script error. null @:0:0" - cross-origin, no
    # stack, no attribution. There is nothing a person could do with these.
    "frontend.js",
    # "We found a custom integration X which has not been tested" - one per
    # custom integration per restart, permanently.
    "homeassistant.loader",
    # Deprecation notices aimed at integration authors, not at this house.
    "homeassistant.helpers.frame",
    "homeassistant.const",
)

EXEC_LOGGER_RE = re.compile(
    r"^homeassistant\.components\.(automation|script)\.(.+)$")

# "Alias: Choose at step 3: <branch alias>: Error executing script.
#  Error for call_service at pos 2: <error>"
EXEC_STEP_RE = re.compile(
    r"Error (?:executing script\. Error )?for ([a-z_]+) at pos (\d+): (.*)$",
    re.S)
EXEC_PATH_RE = re.compile(r"^[^:]+: ((?:[A-Z][a-z]+ at step \d+.*?): )?")

# `source` is (path, line) inside Home Assistant, and for an integration
# error the path is nearly always components/<domain>/... - which maps the
# error to an integration even when the logger belongs to an upstream library
# (`kasa.smart.smartdevice` raised from components/tplink/coordinator.py).
SOURCE_DOMAIN_RE = re.compile(r"^(?:custom_)?components/([a-z0-9_]+)/")
LOGGER_DOMAIN_RE = re.compile(
    r"^(?:homeassistant|custom_components)\.components?\.([a-z0-9_]+)")
CUSTOM_DOMAIN_RE = re.compile(r"^custom_components\.([a-z0-9_]+)")


def load_log_state():
    """The per-key sample series from the previous polls. Never raises."""
    try:
        with open(LOG_STATE_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        return {}
    return data.get("keys", {}) if isinstance(data, dict) else {}


def save_log_state(keys, stamp):
    with open(LOG_STATE_FILE, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "updated": stamp, "keys": keys}, fh)
    return len(keys)


def log_key(rec):
    """Stable identity for one deduplicated log record.

    Home Assistant keys its own store on (logger, source, root cause); the
    first two are in the payload and are enough to be unique here.
    """
    src = rec.get("source") or ("", 0)
    try:
        path, line = src[0], src[1]
    except Exception:
        path, line = str(src), 0
    return "%s|%s|%s" % (rec.get("name") or "", path, line)


def fold_log_window(records, state, now_ts, window=LOG_WINDOW_SECONDS):
    """Turn cumulative counts into "how many happened inside the window".

    Returns (incidents, new_state). Each incident carries the record's own
    consolidated fields plus `recent`, the number of occurrences inside the
    window.

    A count that went DOWN means Home Assistant restarted and cleared its log
    store, so the series is started again rather than producing a negative
    rate. A key that is present for the first time contributes its whole
    count, which is right: it is new since the last poll.
    """
    out = []
    fresh = {}
    for rec in records:
        key = log_key(rec)
        count = int(rec.get("count") or 0)
        series = []
        prev = state.get(key)
        if isinstance(prev, dict) and isinstance(prev.get("series"), list):
            series = [s for s in prev["series"]
                      if isinstance(s, list) and len(s) == 2
                      and (now_ts - s[0]) <= window
                      and s[1] <= count]
        series = series + [[now_ts, count]]
        fresh[key] = {"series": series}
        base = series[0][1] if len(series) > 1 else 0
        recent = max(0, count - base)
        out.append({
            "key": key,
            "name": rec.get("name") or "",
            "level": rec.get("level") or "ERROR",
            "message": (rec.get("message") or [""])[0],
            "source": rec.get("source") or ("", 0),
            "exception": rec.get("exception") or "",
            "count": count,
            "recent": recent,
            "first": float(rec.get("first_occurred") or now_ts),
            "last": float(rec.get("timestamp") or now_ts),
        })
    return out, fresh


def log_is_noise(name):
    return any(str(name).startswith(p) for p in LOG_IGNORE_PREFIXES)


# --- surviving a restart ----------------------------------------------
#
# `system_log` is memory. A Home Assistant restart empties it, and every
# incident derived from it vanishes with it - which is how a camera that had
# been failing for four days silently became "healthy" the moment Home
# Assistant was restarted for an unrelated reason, and how a water pump's
# ninety-four failed shutdowns stopped being on the record.
#
# Absence of evidence is not evidence of absence. After a restart there is no
# evidence either way, and the honest answer is neither "broken" nor "fine"
# but "this was broken and nobody has checked since". That is what `pending`
# means below, and it is deliberately not green.
INCIDENT_FILE = os.path.join(CONFIG_DIR, "config_health_incidents.json")

# How long a quiet incident stays on the page before it is forgotten. Matches
# the execution retention: an incident from breakfast should still be visible
# after work, and gone the next day.
INCIDENT_RETAIN_SECONDS = 24 * 3600

# Consecutive scans of healthy, advancing telemetry before a `pending`
# integration incident is called recovered. At the five-minute operational
# cadence three passes is a quarter of an hour of proof, which is enough to
# distinguish "working again" from "answered once and hung" - the exact
# failure this system has watched a camera do three times.
INCIDENT_HEAL_PASSES = 3


def load_incidents():
    """The persisted operational incidents. Never raises."""
    try:
        with open(INCIDENT_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    return {
        "version": 1,
        "updated": data.get("updated"),
        "boot": data.get("boot"),
        "execution": data.get("execution") if isinstance(data.get("execution"), dict) else {},
        "integrations": data.get("integrations") if isinstance(data.get("integrations"), dict) else {},
        # Carried explicitly. This dict is rebuilt key by key rather than
        # copied, so anything not named here is silently dropped on load -
        # which is exactly what happened to the restart history: it was
        # written, saved, and thrown away again on the very next pass.
        "restarts": data.get("restarts") if isinstance(data.get("restarts"), list) else [],
    }


def save_incidents(store):
    tmp = INCIDENT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(store, fh, indent=1, ensure_ascii=False, sort_keys=True)
    os.replace(tmp, INCIDENT_FILE)
    return os.path.getsize(INCIDENT_FILE)


# Fields that are allowed to reach the store. Everything else - stack traces,
# raw log lines, exception bodies, anything an integration chose to put in a
# message - is dropped rather than filtered, because a deny-list is a promise
# you cannot keep and this file sits next to the configuration.
EXEC_PERSIST_KEYS = ("fp", "entity_id", "type", "name", "where", "step", "error",
                     "failures", "first", "last", "safety", "status", "notified",
                     "healthy_passes")
INTEG_PERSIST_KEYS = ("fp", "domain", "entry", "entries", "confidence", "message",
                      "errors", "first", "last", "severity", "status", "notified",
                      "healthy_passes", "observed", "seen", "evidence",
                      "evidence_stamp", "cadence", "reason")

# One line, not a log. Long enough to say what failed, short enough that no
# stack trace, URL or token survives being put through it.
SUMMARY_CAP = 160

_SECRETISH = re.compile(
    r"(?i)(pass(word|wd)?|secret|token|api[_-]?key|appkey|key|credential|auth"
    r"|bearer|cookie|session)\s*[=:]\s*\S+")


def incident_summary(text):
    """A one-line, secret-free summary of an error.

    Anything that looks like a credential is removed rather than truncated
    around, and the result is capped hard. This is the only free text that
    reaches the store.
    """
    if not text:
        return ""
    one = " ".join(str(text).split())
    one = _SECRETISH.sub(lambda m: m.group(0).split("=")[0].split(":")[0] + "=<redacted>", one)
    return one[:SUMMARY_CAP]


def _persist_only(record, keys):
    out = {}
    for k in keys:
        if k in record:
            out[k] = record[k]
    for k in ("error", "message"):
        if k in out:
            out[k] = incident_summary(out[k])
    return out


# --- the evidence path ------------------------------------------------
#
# An integration must be judged healthy on the same data path that failed.
#
# The first version of this asked "is the newest entity of this integration
# fresh?", and a camera taught it better. When the TP-Link coordinator hangs,
# five switches and a signal sensor freeze together while
# `camera.…_live_view` carries on updating from its own stream: the newest
# entity is two minutes old and everything that actually broke is twenty.
# "Newest" would have called that recovered.
#
# So recovery evidence is the group of entities the coordinator writes
# TOGETHER. Home Assistant does not publish coordinator membership, but it
# does not need to: a coordinator writes all its entities in one pass, so
# they share a `last_reported` timestamp to the microsecond. Entities on
# their own schedule never do.

# An evidence group has to be at least this big before shared timestamps mean
# anything. Two entities agreeing by chance is possible; it is also harmless,
# because the group is refined by intersection over successive passes.
EVIDENCE_MIN_GROUP = 2

# How far apart two writes can be and still count as one coordinator pass.
# The observed spread across a six-entity group is ~2 ms; the smallest gap
# between independently scheduled entities is seconds. 250 ms sits two orders
# of magnitude clear of both.
EVIDENCE_TOLERANCE_MS = 250

# How many passes of cadence history to keep. Twelve at the five-minute
# operational cadence is an hour - long enough to establish a habit, short
# enough to notice when one changes.
CADENCE_WINDOW = 12

# Of those, how many must have advanced before the integration counts as
# having demonstrated a cadence faster than the operational pass.
CADENCE_FAST_RATIO = 0.8

# How many missed observation intervals make a demonstrated-fast evidence
# group abnormally stale. Three passes is fifteen minutes: far outside any
# cadence that was advancing on four passes out of five, and comfortably
# outside a single slow poll.
STALE_INTERVALS = 3


def _iso_epoch(stamp):
    """Epoch seconds from an ISO-8601 `last_reported`, or None.

    Separate from `_epoch`, which parses the "%Y-%m-%d %H:%M:%S" form the
    log records use. Entity timestamps carry microseconds and an offset.
    """
    if not stamp:
        return None
    try:
        text = str(stamp).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return datetime.datetime.fromisoformat(text).timestamp()
    except Exception:
        return None


def evidence_group(entity_stamps, previous=None, tolerance_ms=EVIDENCE_TOLERANCE_MS):
    """The entities an integration's coordinator writes together.

    `entity_stamps` is {entity_id: last_reported string}. Returns
    (entity_ids, shared_stamp) for the largest set written together, or the
    single entity when the integration only has one.

    Members are found by clustering timestamps within a tolerance, NOT by
    string equality. The first version of this compared the stamps exactly,
    on the assumption that a coordinator writing its entities in one pass
    gives them one timestamp. It does not. Home Assistant stamps each state
    write as it makes it, so the six entities of a TP-Link camera came back

        ...19.491683  ...19.492881  ...19.493198
        ...19.493438  ...19.493683  ...19.493912

    - agreeing to about two milliseconds and to nothing at all as strings.
    Exact matching found no group, so the evidence path was empty for every
    multi-entity integration, and both recovery and the staleness clause
    quietly had nothing to work with. The tests all passed the same string
    to every member and so could never have caught it.

    The tolerance is what separates "written together" from "written on
    their own schedules", and those two are orders of magnitude apart: a
    coordinator's writes land inside a few milliseconds, while independent
    entities are seconds or minutes apart. Anything in that gap works.
    """
    if not entity_stamps:
        return [], None
    parsed = {}
    for entity_id, stamp in entity_stamps.items():
        ts = _iso_epoch(stamp)
        if ts is not None:
            parsed[entity_id] = ts
    if not parsed:
        return [], None

    # Cluster around each entity in turn and keep the biggest. Anchoring on
    # real observations rather than on fixed buckets is deliberate: a bucket
    # boundary falling between two writes would split a group, which is the
    # same way fixed buckets once let device drops escape the restart mask.
    tol = float(tolerance_ms) / 1000.0
    best, best_ts = [], None
    for anchor_id in sorted(parsed):
        anchor = parsed[anchor_id]
        members = sorted([e for e in parsed if abs(parsed[e] - anchor) <= tol])
        newest = max([parsed[e] for e in members])
        # Bigger group wins; on a tie the older one does, so a group is not
        # traded for an equally sized one that merely reported later.
        if len(members) > len(best) or (len(members) == len(best)
                                        and best_ts is not None and newest < best_ts):
            best, best_ts = members, newest

    def _stamp_of(members):
        newest_id = members[0]
        for e in members:
            if parsed[e] > parsed[newest_id]:
                newest_id = e
        return entity_stamps[newest_id]

    if len(best) < EVIDENCE_MIN_GROUP:
        # A single-entity integration is its own evidence. Nothing to
        # cross-check it against, but it is still the right path to watch.
        if len(parsed) == 1:
            only = sorted(parsed)[0]
            return [only], entity_stamps[only]
        return [], None

    if previous:
        keep = sorted(set(best) & set(previous))
        if keep:
            # The remembered group still exists; narrow to it and report the
            # stamp those members actually share.
            return keep, _stamp_of(keep)
    return best, _stamp_of(best)


def cadence_note(history, advanced, window=CADENCE_WINDOW):
    """Append one observation to the cadence history, oldest dropped."""
    hist = [1 if x else 0 for x in (history or [])]
    hist.append(1 if advanced else 0)
    return hist[-window:]


def cadence_is_fast(history, window=CADENCE_WINDOW, ratio=CADENCE_FAST_RATIO):
    """Has this evidence group demonstrated a cadence faster than the pass?

    Only a full window counts. An integration that has been watched three
    times has not demonstrated anything, and letting a short history qualify
    is how a slow integration would get escalated on its first quiet spell.
    """
    hist = [1 if x else 0 for x in (history or [])]
    if len(hist) < window:
        return False
    return (sum(hist) / float(len(hist))) >= ratio


# --- path B: the integration that was already broken when we arrived ---
#
# Path A escalates on a learned cadence: an evidence group that has been
# seen advancing faster than we sample, and then stops. That is the right
# rule for something that fails while we are watching it.
#
# It cannot fire for something that was already frozen when observation
# began, because a frozen group never advances and so never demonstrates a
# cadence. The camera proved this the hard way: two real errors, a
# coordinator that had not written for twenty-six minutes, and a cadence
# gate that could only ever count downwards. Path A was not wrong; it was
# structurally inapplicable, and it was the only path there was.
#
# Path B needs no cadence history. It rests on repeated REAL errors and an
# evidence group that is demonstrably not moving. Both halves are required:
# staleness alone never reaches this code, so a slow integration that is
# not throwing errors is never evaluated here. This is deliberately not
# general stale-telemetry monitoring.

# Two errors is the smallest number that distinguishes a fault from an
# incident. One is transient and stays evidence.
FROZEN_MIN_ERRORS = 2

# ...and they have to be spread out. Two errors a second apart is one event
# retried; two errors ten minutes apart is a condition.
FROZEN_MIN_SPAN_SECONDS = 600

# How long the evidence group must have been still. Ten minutes is two
# operational passes plus margin, and comfortably longer than any single
# slow poll this system has been observed to make.
FROZEN_MIN_STALE_SECONDS = 600

# Critical wants more of everything: more errors, over a longer span, with
# the group still not moving.
FROZEN_CRITICAL_ERRORS = 3
FROZEN_CRITICAL_SPAN_SECONDS = 1800

# Entities whose freshness is driven by something other than the polling
# coordinator - a stream, a pushed image. They can sit in the evidence
# group while the coordinator is healthy, because they are written in the
# same pass, but they are not evidence that the coordinator is alive. A
# group made only of these cannot support Path B at all.
PROXY_DOMAINS = ("camera", "image", "media_player")


def evidence_has_coordinator_entity(members, proxy_domains=PROXY_DOMAINS):
    """Does the group contain something a coordinator actually polls?

    `camera.…_live_view` kept updating from its own stream for the whole
    time the TP-Link coordinator was hung. A group holding nothing but
    entities like that says nothing about the coordinator either way.
    """
    for entity_id in (members or []):
        if str(entity_id).split(".", 1)[0] not in proxy_domains:
            return True
    return False


def frozen_escalation(observed, first_ts, last_ts, stamp_ts, now_ts, members,
                      min_errors=FROZEN_MIN_ERRORS,
                      min_span=FROZEN_MIN_SPAN_SECONDS,
                      min_stale=FROZEN_MIN_STALE_SECONDS,
                      critical_errors=FROZEN_CRITICAL_ERRORS,
                      critical_span=FROZEN_CRITICAL_SPAN_SECONDS):
    """Path B. Returns None, "warning" or "critical".

    `observed` is the cumulative real-error count for this fingerprint -
    the one that survives a restart, not system_log's resettable counter.
    `stamp_ts` is the evidence group's own last write.

    Every clause is required. In particular there is no route through here
    that does not involve real, repeated, spread-out errors.
    """
    if not members or not evidence_has_coordinator_entity(members):
        return None
    if stamp_ts is None or first_ts is None or last_ts is None:
        return None
    if int(observed or 0) < min_errors:
        return None
    if (last_ts - first_ts) < min_span:
        return None
    stale_for = now_ts - stamp_ts
    if stale_for < min_stale:
        return None
    if int(observed or 0) >= critical_errors and             (last_ts - first_ts) >= critical_span:
        return "critical"
    return "warning"


def evidence_is_stale(stamp_ts, now_ts, interval_seconds, intervals=STALE_INTERVALS):
    """Is the evidence group abnormally stale for something this fast?"""
    if stamp_ts is None:
        return False
    return (now_ts - stamp_ts) >= (intervals * interval_seconds)


# How the operational statuses order when one has to win, so that an
# escalation path can raise an incident but never walk it back down.
_RANK = {"recovered": 0, "evidence": 1, "pending": 2, "warning": 3,
         "critical": 4, "actionable": 4}


def reconcile_incidents(store, live_exec, live_integ, now_ts, restarted,
                        evidence=None, interval_seconds=300,
                        retain=INCIDENT_RETAIN_SECONDS,
                        heal_passes=INCIDENT_HEAL_PASSES):
    """Fold this scan's evidence into the persisted incidents.

    `evidence` is {domain: {"entities": [...], "stamp": iso, "stamp_ts": float}}
    describing the coordinator path for each integration we are watching -
    see `evidence_group`. It is what recovery and staleness are judged on,
    never the newest entity the integration happens to own.

    Returns (execution, integrations, store).

    The rules:

      - every observed error contributes to the persisted record immediately,
        at status `evidence`. That is not a finding and never notifies; it
        exists so that error-restart-error-restart-error accumulates into one
        incident instead of looking like three clean boots
      - an incident with live evidence is updated; its status comes from the
        live severity, or from the staleness clause below
      - an incident with no live evidence is not deleted. If Home Assistant
        restarted since it was last seen it becomes `pending` - it was real,
        and nothing has checked since. Otherwise it is `recovered`
      - a `pending` integration recovers only on its own coordinator path
        advancing, on `heal_passes` consecutive passes. Silence never counts,
        and neither does an unrelated entity of the same integration
      - anything quiet beyond the retention window is forgotten
      - `notified` is carried across, so a restart cannot repeat a push
    """
    evidence = evidence or {}
    execution, integrations = [], {}

    # --- execution -----------------------------------------------------
    keep_exec = {}
    live_by_fp = {}
    for item in live_exec:
        live_by_fp[item["fp"]] = item
    for fp, item in live_by_fp.items():
        prev = store["execution"].get(fp) or {}
        rec = _persist_only(item, EXEC_PERSIST_KEYS)
        if prev.get("first") and (not rec.get("first") or prev["first"] < rec["first"]):
            rec["first"] = prev["first"]
        if prev.get("failures") and item.get("status") != "actionable":
            rec["failures"] = max(int(prev.get("failures") or 0), int(rec.get("failures") or 0))
        rec["notified"] = prev.get("notified")
        rec["healthy_passes"] = 0
        keep_exec[fp] = rec
        execution.append(dict(rec, verified=True))
    for fp, prev in store["execution"].items():
        if fp in live_by_fp:
            continue
        last = _epoch(prev.get("last")) or 0
        if now_ts - last > retain:
            continue
        rec = dict(prev)
        rec["status"] = "pending" if restarted and prev.get("status") == "actionable" else "recovered"
        keep_exec[fp] = rec
        execution.append(dict(rec, verified=False))

    # --- integrations --------------------------------------------------
    keep_integ = {}
    seen_live = set()
    for item in live_integ:
        fp = item["fp"]
        seen_live.add(fp)
        prev = store["integrations"].get(fp) or {}
        rec = _persist_only(item, INTEG_PERSIST_KEYS)
        for key in ("evidence", "evidence_stamp", "cadence"):
            if key in prev:
                rec[key] = prev[key]
        if prev.get("first") and (not rec.get("first") or prev["first"] < rec["first"]):
            rec["first"] = prev["first"]
        # Cumulative across restarts: system_log's counter resets, this does
        # not. `observed` is the number this incident has ever been credited
        # with, and it only ever grows while the incident lives.
        seen_now = int(rec.get("errors") or 0)
        prev_seen = int(prev.get("seen") or 0)
        rec["observed"] = int(prev.get("observed") or 0) + max(0, seen_now - prev_seen) \
            if seen_now >= prev_seen else int(prev.get("observed") or 0) + seen_now
        rec["seen"] = seen_now
        rec["errors"] = max(rec["observed"], seen_now)
        rec["notified"] = prev.get("notified")
        rec["status"] = item.get("severity")
        keep_integ[fp] = rec
    # Records with no live errors this pass still get their evidence updated.
    for fp, prev in store["integrations"].items():
        if fp in keep_integ:
            continue
        last = _epoch(prev.get("last")) or 0
        if now_ts - last > retain:
            continue
        rec = dict(prev)
        rec["seen"] = 0  # system_log no longer carries it; cumulative stands
        was_open = prev.get("status") in ("critical", "warning", "pending")
        if restarted and was_open:
            rec["status"] = "pending"
            rec["healthy_passes"] = 0
        elif prev.get("status") in ("pending", "evidence"):
            rec["status"] = prev.get("status")
        elif was_open:
            # An open incident whose errors merely STOPPED is not recovered.
            # Errors stop for two reasons - the integration started working,
            # or it stopped being asked - and a hung coordinator produces the
            # second while looking exactly like the first. So it drops to
            # `pending` and has to earn its way out on the evidence path,
            # the same as an incident that survived a restart.
            rec["status"] = "pending"
            rec["healthy_passes"] = int(prev.get("healthy_passes") or 0)
        else:
            rec["status"] = "recovered"
        keep_integ[fp] = rec

    # --- evidence path: recovery, and the staleness clause -------------
    for fp, rec in keep_integ.items():
        ev = evidence.get(rec.get("domain")) or {}
        members = ev.get("entities") or []
        stamp = ev.get("stamp")
        stamp_ts = ev.get("stamp_ts")
        if members:
            rec["evidence"] = members
        advanced = bool(stamp and rec.get("evidence_stamp") and stamp != rec["evidence_stamp"])
        if stamp:
            rec["evidence_stamp"] = stamp
        # Cadence is only observed while we have a path to observe.
        if members:
            rec["cadence"] = cadence_note(rec.get("cadence"), advanced)
        fast = cadence_is_fast(rec.get("cadence"))
        stale = evidence_is_stale(stamp_ts, now_ts, interval_seconds)

        if rec.get("status") == "pending":
            if advanced and not stale:
                rec["healthy_passes"] = int(rec.get("healthy_passes") or 0) + 1
                if rec["healthy_passes"] >= heal_passes:
                    rec["status"] = "recovered"
            else:
                rec["healthy_passes"] = 0
        elif rec.get("status") in ("evidence", "warning", "critical"):
            # Path A - the scoped clause. An integration that has thrown
            # errors and whose own coordinator path has stopped moving -
            # when that path has demonstrably been moving faster than we
            # sample - is failing now, whatever the error counter says.
            # This is the difference between noticing a hung camera in
            # fifteen minutes and noticing it in two hours.
            fresh_enough = bool(_epoch(rec.get("last"))) and \
                (now_ts - _epoch(rec["last"])) <= retain
            if fast and stale and fresh_enough:
                rec["status"] = "critical"
                rec["reason"] = "coordinator path stale"
            else:
                # Path B - no cadence history required. For an integration
                # that was already frozen when we started watching, Path A
                # can never become true, because a group that never moves
                # never demonstrates a cadence. Repeated real errors against
                # a motionless evidence group have to carry it alone.
                level = frozen_escalation(
                    rec.get("observed"), _epoch(rec.get("first")),
                    _epoch(rec.get("last")), stamp_ts, now_ts, members)
                # Only ever raises. A pass that no longer qualifies must
                # not quietly walk an incident back down - recovery is the
                # evidence path's job, and it has its own proof requirement.
                if level and _RANK.get(level, 0) > _RANK.get(rec.get("status"), 0):
                    rec["status"] = level
                    rec["reason"] = "repeated errors, coordinator data stale"

    for fp, rec in keep_integ.items():
        integrations[fp] = dict(rec, verified=fp in seen_live)

    store["execution"] = keep_exec
    store["integrations"] = keep_integ
    order = {"actionable": 0, "critical": 0, "pending": 1, "warning": 2,
             "evidence": 3, "recovered": 4}
    execution.sort(key=lambda x: (order.get(x.get("status"), 5), -(int(x.get("failures") or 0))))
    integ_list = sorted(integrations.values(),
                        key=lambda x: (order.get(x.get("status"), 5), -(int(x.get("errors") or 0))))
    return execution, integ_list, store


def integration_status(recent, last_ts, first_ts, now_ts, count=None,
                       actionable=INTEG_ACTIONABLE):
    """The status a live log record should be folded in at.

    `integration_severity` answers "is this worth reporting", and the answer
    for a single error is no. But "not worth reporting" is not the same as
    "not worth remembering": system_log is memory and also evicts, so an
    error that is discarded here can never accumulate, and
    error-restart-error-restart-error looks like three clean boots forever.

    So a quiet record becomes `evidence` - persisted, invisible, silent -
    rather than being dropped. This wrapper exists so that distinction is
    testable without a running Home Assistant.
    """
    sev = integration_severity(recent, last_ts, first_ts, now_ts, count, actionable)
    return "evidence" if sev == "quiet" else sev


def incident_is_live(status):
    """Statuses that mean "happening now", as opposed to remembered."""
    return status in ("actionable", "critical")


def incident_is_open(status):
    """Statuses that must not read as healthy. `pending` is here on purpose:
    a problem nobody has re-checked is not a problem that went away.

    `evidence` is deliberately absent. A single error is remembered so it can
    accumulate across restarts, but one error is not a finding and showing it
    as one would fill the page with noise the moment anything hiccuped.
    """
    return status in ("actionable", "critical", "warning", "pending")


def incident_is_evidence(status):
    """Remembered, below the reporting bar, and silent."""
    return status == "evidence"


# --- execution errors -------------------------------------------------

def parse_execution(inc):
    """Pull the automation/script identity and the failing step out of a log
    record, or None if this is not an execution failure.

    Two shapes reach this logger. The detailed one names the branch and the
    action position; the summary one only says the automation failed. The
    detailed one is preferred when both are present for the same item, which
    is why `detail` is scored here rather than at the call site.
    """
    m = EXEC_LOGGER_RE.match(inc.get("name") or "")
    if not m:
        return None
    domain, object_id = m.group(1), m.group(2)
    msg = inc.get("message") or ""
    step = None
    error = msg
    sm = EXEC_STEP_RE.search(msg)
    if sm:
        step = "%s at position %s" % (sm.group(1).replace("_", " "), sm.group(2))
        error = sm.group(3).strip()
    where = None
    pm = re.search(r": ((?:Choose|Repeat|If|Parallel|Sequence) at step \d+[^:]*)", msg)
    if pm:
        where = pm.group(1).strip()
    return {
        "domain": domain,
        "object_id": object_id,
        "entity_id": "%s.%s" % (domain, object_id),
        "step": step,
        "where": where,
        "error": error.strip(),
        "detail": 1 if sm else 0,
    }


def execution_severity(recent, last_ts, now_ts, safety=False,
                       actionable=EXEC_ACTIONABLE,
                       safety_actionable=EXEC_SAFETY_ACTIONABLE):
    """One of actionable / recovered / diagnostic / gone.

    `actionable` needs both a rate and a pulse: enough failures inside the
    window AND one recently enough that it is still happening. An incident
    that has stopped becomes `recovered` for a while - a red row that never
    goes away teaches people to ignore red rows - and then `gone`.
    """
    quiet = now_ts - last_ts
    threshold = safety_actionable if safety else actionable
    if recent >= threshold and quiet <= EXEC_RECOVER_SECONDS:
        return "actionable"
    if quiet > EXEC_RETAIN_SECONDS:
        return "gone"
    if recent >= threshold or quiet <= EXEC_RECOVER_SECONDS:
        return "recovered" if quiet > EXEC_RECOVER_SECONDS else "diagnostic"
    return "recovered"


def merge_executions(parsed):
    """One incident per automation, not one per distinct log line.

    A single failing automation routinely produces two records - the detailed
    "Choose at step 1 ... call_service at pos 1" line and the summary "Error
    while executing automation" line - and an automation with two failing
    branches produces four. Showing four rows for one broken thing is the
    behaviour this whole feature exists to avoid, so they fold into one
    incident keyed on the automation, keeping the most detailed step text and
    the widest time span.
    """
    by_item = {}
    for p, inc in parsed:
        key = p["entity_id"]
        cur = by_item.get(key)
        if cur is None:
            cur = {
                "entity_id": p["entity_id"],
                "domain": p["domain"],
                "object_id": p["object_id"],
                "step": p["step"],
                "where": p["where"],
                "error": p["error"],
                "detail": p["detail"],
                "count": 0,
                "recent": 0,
                "first": inc["first"],
                "last": inc["last"],
                "keys": [],
            }
            by_item[key] = cur
        # The summary line and the detailed line describe the same failures,
        # so counting both would double every incident. The detailed record
        # wins on both text and count; a summary-only item still counts.
        if p["detail"] >= cur["detail"]:
            if p["detail"] > cur["detail"]:
                cur["count"] = 0
                cur["recent"] = 0
            cur["step"] = p["step"] or cur["step"]
            cur["where"] = p["where"] or cur["where"]
            cur["error"] = p["error"] or cur["error"]
            cur["detail"] = p["detail"]
            cur["count"] += inc["count"]
            cur["recent"] += inc["recent"]
        cur["first"] = min(cur["first"], inc["first"])
        cur["last"] = max(cur["last"], inc["last"])
        cur["keys"].append(inc["key"])
    return sorted(by_item.values(), key=lambda x: (-x["recent"], -x["last"]))


# --- integration errors -----------------------------------------------

def integration_of(inc):
    """(domain, confidence) for the integration behind a log record.

    The source file is the strongest signal and the logger name is the
    weakest, because a library logger says nothing about which integration
    invoked it: the Tapo camera's failures arrive under `kasa.smart.
    smartdevice` but from `components/tplink/coordinator.py`, and only the
    second one names an integration this install has.
    """
    src = inc.get("source") or ("", 0)
    path = src[0] if isinstance(src, (list, tuple)) and src else str(src)
    m = SOURCE_DOMAIN_RE.match(str(path))
    if m:
        return m.group(1), "high"
    name = inc.get("name") or ""
    m = LOGGER_DOMAIN_RE.match(name)
    if m:
        return m.group(1), "high"
    m = CUSTOM_DOMAIN_RE.match(name)
    if m:
        return m.group(1), "medium"
    return None, "none"


def integration_severity(recent, last_ts, first_ts, now_ts, count=None,
                         actionable=INTEG_ACTIONABLE):
    """warning / critical / quiet.

    `count` is the record's lifetime total and `recent` is how much of it
    landed inside the window. Persistence is judged on the total and the
    span, a burst on the window - and nothing is judged at all unless the
    integration is still failing right now.

    Critical is the only integration state allowed to reach the main
    dashboard, and it means "still failing, and has been for hours".
    """
    if (now_ts - last_ts) > INTEG_RECENT_SECONDS:
        return "quiet"
    span = last_ts - first_ts
    total = count if count is not None else recent
    if span >= INTEG_CRITICAL_SECONDS and total >= INTEG_CRITICAL_COUNT:
        return "critical"
    if recent >= actionable:
        return "warning"
    if span >= INTEG_PERSISTENT_SECONDS and total >= INTEG_PERSISTENT_COUNT:
        return "warning"
    return "quiet"


# --- add-ons ----------------------------------------------------------

def addon_findings(addons):
    """Add-ons that are not doing what they were configured to do.

    Two states matter and nothing else does. `error` is the supervisor
    saying the add-on failed. `boot: auto` with anything other than
    `started` means it was meant to come up and did not. An add-on set to
    start manually and currently stopped is working exactly as configured
    and must never appear here.
    """
    out = []
    for slug, info in sorted((addons or {}).items()):
        state = info.get("state")
        name = info.get("name") or slug
        if state == "error":
            out.append({"slug": slug, "name": name, "state": state,
                        "severity": "actionable",
                        "message": "Add-on is in an error state"})
        elif info.get("boot") == "auto" and state != "started":
            out.append({"slug": slug, "name": name, "state": state,
                        "severity": "warning",
                        "message": "Set to start on boot but is %s" % (state or "not running")})
    return out


# --- backups ----------------------------------------------------------

def backup_finding(last_success_ts, last_attempt_ts, now_ts,
                   warn=BACKUP_WARN_SECONDS, critical=BACKUP_CRITICAL_SECONDS):
    """Age of the last successful automatic backup, and whether the last
    attempt beat it.

    An attempt newer than the last success is a failed run, and that is worth
    saying immediately rather than waiting for the age threshold: the backup
    is not just old, it is broken.
    """
    if last_success_ts is None:
        return {"severity": "warning", "age": None,
                "message": "No successful automatic backup on record"}
    age = now_ts - last_success_ts
    if last_attempt_ts is not None and last_attempt_ts > last_success_ts + 60:
        return {"severity": "actionable", "age": age, "failed": True,
                "message": "The last automatic backup attempt did not complete"}
    if age >= critical:
        return {"severity": "critical", "age": age,
                "message": "No successful backup in %s" % duration_words(age)}
    if age >= warn:
        return {"severity": "actionable", "age": age,
                "message": "Last successful backup %s ago" % duration_words(age)}
    return None


def duration_words(seconds):
    """`2d 4h`, `6h 19m`, `14m`. Two units is always enough to act on."""
    seconds = int(max(0, seconds))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    mins = rem // 60
    if days:
        return "%dd %dh" % (days, hours)
    if hours:
        return "%dh %dm" % (hours, mins)
    return "%dm" % mins
