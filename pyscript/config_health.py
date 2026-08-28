"""Config health scanner.

Finds entity references in the HA config that point at entities which do not
exist, and publishes them on pyscript.config_health for device-health-card.

All filesystem work lives in the plain-Python module ha_config_scan and is run
through task.executor, because pyscript refuses to run interpreted functions
there and blocking I/O must stay off the event loop.

Services:
  pyscript.config_health_rescan
  pyscript.config_health_fix  entity_id=<missing> replacement=<existing>
"""

import json
import sys
import time

if "/config/python_modules" not in sys.path:
    sys.path.append("/config/python_modules")

# pyscript keeps imported python modules in sys.modules, so drop it first or a
# pyscript reload would keep running the stale scanner.
sys.modules.pop("ha_config_scan", None)

import ha_config_scan

STATE_ENTITY = "pyscript.config_health"

# The last dependency universe, kept in memory so the five-minute runtime
# pass costs a dict walk rather than a filesystem scan.
_DEPS = {"deps": [], "generated": None}
RELOAD = {"automation": "automation", "script": "script", "scene": "scene"}


def _known():
    """Live entity ids, service names and valid domains (event loop safe)."""
    ents = set(hass.states.async_entity_ids())
    try:
        from homeassistant.helpers import entity_registry as er
        ents |= {e.entity_id for e in er.async_get(hass).entities.values()}
    except Exception as exc:
        log.warning(f"config_health: entity registry unavailable: {exc}")
    svcs = set()
    for dom, names in hass.services.async_services().items():
        for name in names:
            svcs.add(f"{dom}.{name}")
    doms = {e.split(".", 1)[0] for e in ents}
    return ents, svcs, doms


def _registry_view():
    """What the runtime classification needs, in one pass off the registries.

    Returns (in_registry, disabled, labels) keyed by entity id. Labels carry
    the device's as well as the entity's own, so a `label` ignore rule means
    the same thing here as it does on the page.
    """
    in_reg = set()
    disabled = set()
    labels = {}
    try:
        from homeassistant.helpers import entity_registry as er
        from homeassistant.helpers import device_registry as dr
        ereg = er.async_get(hass)
        dreg = dr.async_get(hass)
        dev_labels = {}
        for dev in dreg.devices.values():
            if dev.labels:
                dev_labels[dev.id] = set(dev.labels)
        for ent in ereg.entities.values():
            in_reg.add(ent.entity_id)
            if ent.disabled_by:
                disabled.add(ent.entity_id)
            own = set(ent.labels or ())
            if ent.device_id and ent.device_id in dev_labels:
                own |= dev_labels[ent.device_id]
            if own:
                labels[ent.entity_id] = own
    except Exception as exc:
        log.warning(f"config_health: registry view unavailable: {exc}")
    return in_reg, disabled, labels


def _automation_keys():
    """Numeric automation id -> the entity id the card names it by.

    An `item` ignore rule written on the Health page carries the card's key,
    `automation:automation.morning_lights`. The file scanner only ever sees
    the numeric id in `- id: '1766451627262'`, so without this map the two
    halves would disagree about which item a rule covers.
    """
    out = {}
    for eid in hass.states.async_entity_ids("automation"):
        attrs = hass.states.get(eid).attributes
        if attrs.get("id"):
            out[str(attrs["id"])] = eid
    return out


def _mark_holders(rec, used, ents_by_entry):
    """Say whether the thing holding this broken reference is itself used.

    A helper or script that nothing references and that points at something
    gone is a dead end, and safe to remove outright rather than repair. The
    answer has to come from the scan: a template helper can be referenced from
    another helper's options, which is not visible to the frontend at all.
    """
    holders = []

    for own in rec.get("owners", []):
        eid = own.get("entry_id")
        if not eid:
            continue
        mine = ents_by_entry.get(eid, [])
        holders.append({
            "kind": "helper",
            "entry_id": eid,
            "title": own.get("title"),
            "entities": mine,
            # No entities at all is not evidence of disuse - it usually means
            # the helper failed to set up - so only a real, unreferenced set
            # counts as unused.
            "unused": bool(mine) and not any([e in used for e in mine]),
        })

    for occ in rec.get("occurrences", []):
        holder = occ.get("holder")
        if not holder:
            continue
        base = occ["file"].rsplit("/", 1)[-1]
        dom = {"scripts.yaml": "script", "automations.yaml": "automation",
               "scenes.yaml": "scene"}.get(base)
        if dom != "script":
            # Only scripts are offered for deletion: an automation or scene
            # nothing calls may still be triggered by time or state.
            continue
        ent = "script." + holder
        if any([h.get("entity_id") == ent for h in holders]):
            continue
        holders.append({
            "kind": "script", "entity_id": ent, "object_id": holder,
            "title": ent, "unused": ent not in used,
        })

    rec["holders"] = holders


def _publish(found, files, dynamic, ents, used, used_at=None, prose=0):
    items = []
    ignores = task.executor(ha_config_scan.load_ignores)
    # Both of these read files, so they belong off the event loop and want
    # doing once for the whole scan rather than once per record.
    owners = task.executor(ha_config_scan.entry_owners, sorted(found))
    entry_ids = []
    for own_list in owners.values():
        for o in own_list:
            if o.get("entry_id") and o["entry_id"] not in entry_ids:
                entry_ids.append(o["entry_id"])
    ents_by_entry = task.executor(ha_config_scan.entry_entities, entry_ids) if entry_ids else {}
    for ref in sorted(found):
        rec = found[ref]
        rec["owners"] = owners.get(ref, [])
        files_hit = [o["file"] for o in rec["occurrences"]]
        only_entries = [f for f in files_hit if f != ".storage/core.config_entries"] == []
        if only_entries and not rec["owners"]:
            # the only match was a unique_id, which merely looks like an entity
            continue
        dash = [ha_config_scan.dashboard_url_path(f) for f in files_hit
                if f.startswith(".storage/lovelace")]
        rec["dashboard"] = dash[0] if dash else None
        sug, conf = ha_config_scan._suggest(ref, ents)
        if rec.get("malformed"):
            sug, conf = None, 0.0
        rec["suggestion"] = sug if conf >= 0.5 else None
        rec["confidence"] = conf
        rec["count"] = len(rec["occurrences"])
        rec["editable"] = not any(
            [o["file"].startswith(".storage") for o in rec["occurrences"]]
        )
        _mark_holders(rec, used, ents_by_entry)
        items.append(rec)
    by_cat = {}
    for it in items:
        by_cat[it["category"]] = by_cat.get(it["category"], 0) + 1
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    dep_count = 0
    dep_bytes = 0
    if used_at is not None:
        payload = _dependencies(used_at, ents, stamp, items)
        _DEPS["deps"] = payload["deps"]
        _DEPS["missing"] = items
        _DEPS["generated"] = stamp
        dep_count = len(payload["deps"])
        dep_bytes = task.executor(ha_config_scan.save_deps, payload)
    state.set(
        STATE_ENTITY,
        len(items),
        new_attributes={
            "friendly_name": "Config Health",
            "icon": "mdi:file-search-outline",
            "generated": stamp,
            "files_scanned": files,
            "scanner_version": ha_config_scan.SCANNER_VERSION,
            "dynamic_refs": dynamic,
            "prose_skipped": prose,
            # Only the size of the dependency universe lives in the state
            # machine; the universe itself is behind config_health_deps.
            "dependencies": dep_count,
            "dependency_bytes": dep_bytes,
            "by_category": by_cat,
            "ignores": ignores,
            "missing": items,
        },
    )
    return items


# --- operational entities ---------------------------------------------
#
# Published over MQTT discovery rather than as pyscript state objects.
#
# A `pyscript.` state object is not a registry entity: it cannot be renamed,
# carries no unique_id, belongs to no device, and does not appear where Home
# Assistant expects an entity to appear. MQTT discovery gives real registry
# entities, grouped under one service device, that survive a restart because
# both the discovery and the state topic are retained - and it needs neither a
# custom integration nor a Home Assistant restart to install. The broker is
# already here for eighteen other devices.
DISC = "homeassistant"
BASE = "config_health"
STATE_TOPIC = BASE + "/state"
CMD_RESCAN = BASE + "/cmd/rescan"

DEVICE = {
    "identifiers": [BASE],
    "name": "Home Assistant Health",
    "manufacturer": "Local",
    "model": "Configuration Inspector",
}

ENTITIES = [
    {"key": "status", "domain": "sensor", "name": "Status", "icon": "mdi:heart-pulse",
     "tpl": "{{ value_json.status }}", "attrs": "status_attrs",
     "options": ["healthy", "warning", "impaired", "broken", "error"]},
    {"key": "broken", "domain": "sensor", "name": "Broken", "icon": "mdi:link-variant-off",
     "tpl": "{{ value_json.broken }}", "unit": "items", "state_class": "measurement",
     "attrs": "broken_attrs"},
    {"key": "impaired", "domain": "sensor", "name": "Impaired", "icon": "mdi:link-variant",
     "tpl": "{{ value_json.impaired }}", "unit": "items", "state_class": "measurement",
     "attrs": "impaired_attrs"},
    {"key": "warnings", "domain": "sensor", "name": "Warnings", "icon": "mdi:alert-outline",
     "tpl": "{{ value_json.warnings }}", "unit": "findings", "state_class": "measurement"},
    {"key": "last_scan", "domain": "sensor", "name": "Last scan", "icon": "mdi:clock-outline",
     "tpl": "{{ value_json.last_scan }}", "device_class": "timestamp"},
]


def _publish_discovery():
    """Announce the entities. Retained, so a restart finds them already there."""
    for spec in ENTITIES:
        cfg = {
            "name": spec["name"],
            "object_id": BASE + "_" + spec["key"],
            "unique_id": BASE + "_" + spec["key"],
            "state_topic": STATE_TOPIC,
            "value_template": spec["tpl"],
            "icon": spec.get("icon"),
            "device": DEVICE,
            "availability_topic": STATE_TOPIC,
            "availability_template": "{{ 'online' if value_json.status else 'offline' }}",
        }
        for extra in ("unit_of_measurement", "state_class", "device_class"):
            short = {"unit_of_measurement": "unit"}.get(extra, extra)
            if spec.get(short):
                cfg[extra] = spec[short]
        if spec.get("options"):
            cfg["device_class"] = "enum"
            cfg["options"] = spec["options"]
        if spec.get("attrs"):
            cfg["json_attributes_topic"] = STATE_TOPIC
            cfg["json_attributes_template"] = "{{ value_json.%s | tojson }}" % spec["attrs"]
        service.call("mqtt", "publish", retain=True,
                     topic=f"{DISC}/{spec['domain']}/{BASE}/{spec['key']}/config",
                     payload=json.dumps(cfg))
    service.call("mqtt", "publish", retain=True,
                 topic=f"{DISC}/button/{BASE}/rescan/config",
                 payload=json.dumps({
                     "name": "Rescan",
                     "object_id": BASE + "_rescan",
                     "unique_id": BASE + "_rescan",
                     "command_topic": CMD_RESCAN,
                     "payload_press": "press",
                     "icon": "mdi:refresh",
                     "entity_category": "config",
                     "device": DEVICE,
                 }))


def _publish_state(summary):
    """One retained JSON document; every entity reads a field out of it."""
    payload = {
        "status": summary.get("status"),
        "broken": summary.get("broken", 0),
        "impaired": summary.get("impaired", 0),
        "warnings": summary.get("warnings", 0),
        "last_scan": summary.get("last_scan_iso"),
        "status_attrs": {
            "last_successful_scan": summary.get("last_successful_scan"),
            "next_scheduled_scan": summary.get("next_scan"),
            "ignored": summary.get("ignored", 0),
            "files_scanned": summary.get("files"),
            "dependencies": summary.get("dependencies"),
            "scan_seconds": summary.get("scan_seconds"),
            "error": summary.get("error"),
        },
        "broken_attrs": dict(summary.get("broken_by_type") or {},
                             references=summary.get("broken_refs", 0)),
        "impaired_attrs": dict(summary.get("impaired_by_type") or {},
                               references=summary.get("impaired_refs", 0)),
    }
    service.call("mqtt", "publish", retain=True, topic=STATE_TOPIC,
                 payload=json.dumps(payload))


# --- notifications ------------------------------------------------------
#
# One rule: tell me about a problem the first time it appears, and never
# again until it has gone away and come back.
#
# BROKEN findings are structural - the configuration says so whether or not
# anything is switched on - so they notify as soon as a background scan sees
# them. IMPAIRED findings depend on an entity being quiet right now, and a
# Wi-Fi device blinking out for three seconds is not news, so they have to
# have been continuously impaired for IMPAIRED_STABLE_SECONDS before the
# phone hears about it. The Health page shows both immediately.
#
# The notify action and the tap target are the only two settings specific to
# one house, so they come from /config/config_health_options.json rather than
# from here - see ha_config_scan.DEFAULT_OPTIONS. Without that file there is
# no notify action configured and notifications simply stay off.
IMPAIRED_STABLE_SECONDS = 300
STARTUP_GRACE_SECONDS = 600
def _now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _iso_now():
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    return stamp[:-2] + ":" + stamp[-2:] if len(stamp) > 5 else stamp


def _notify_pass(findings, background, state):
    """Decide what is new, then push it. The deciding is not done here.

    `ha_config_scan.decide_notifications` owns the rules, so they can be tested
    against a clock rather than waited out. All this adds is the sending.
    """
    options = task.executor(ha_config_scan.load_options)
    fresh, _incidents = ha_config_scan.decide_notifications(
        findings, state, time.time(), background,
        options["impaired_stable_seconds"])
    if not fresh:
        return [], None
    target = options["notify_service"]
    if not target:
        # Nothing configured to notify: the incident is still recorded, the
        # page and the sensors still say so, the phone simply stays quiet.
        return fresh, None
    title, message = ha_config_scan.notification_text(fresh)
    service.call("notify", target, title=title, message=message,
                 data={"clickAction": options["notify_url"], "tag": "config-health",
                       "channel": "Home Assistant Health"})
    return fresh, message


@service(supports_response="optional")
def config_health_rescan(manual=True):
    """Rescan the configuration. Read-only: it parses, it never repairs.

    Answers with the summary an automation would want - status and the three
    counts - so a script can act on the result without reading an entity back.
    The dependency universe stays behind config_health_deps; nobody wants
    eighty kilobytes of edges as the reply to "is anything broken?".
    """
    return _run_scan(bool(manual))


def _run_scan(manual):
    started = time.time()
    state = task.executor(ha_config_scan.load_notify_state)
    state["last_scan"] = _now()
    try:
        ents, svcs, doms = _known()
        found, files, dynamic, used, used_at, prose = task.executor(
            ha_config_scan.scan_files, ents, svcs, doms
        )
        items = _publish(found, files, dynamic, ents, used, used_at, prose)
    except Exception as exc:
        # A failed parse must never be reported as a clean bill of health.
        log.error(f"config_health: scan failed: {exc}")
        summary = {
            "status": "error", "error": str(exc)[:200],
            "broken": state.get("last_broken", 0), "impaired": state.get("last_impaired", 0),
            "warnings": state.get("last_warnings", 0), "ignored": 0,
            "generated": _now(), "last_scan_iso": _iso_now(),
            "last_successful_scan": state.get("last_successful_scan"),
            "next_scan": _next_scan(), "scan_seconds": round(time.time() - started, 2),
        }
        _publish_state(summary)
        task.executor(ha_config_scan.save_notify_state, state)
        return summary

    deps = _DEPS.get("deps") or []
    ignores = task.executor(ha_config_scan.load_ignores)
    findings, hidden = _findings(deps, items, ignores)
    stamp = _now()
    summary = _summarise(findings, hidden, {
        "generated": stamp, "last_scan_iso": _iso_now(),
        "files": files, "dynamic_refs": dynamic, "prose_skipped": prose,
        "dependencies": len(deps), "next_scan": _next_scan(),
        "scan_seconds": round(time.time() - started, 2), "error": None,
    })
    state["last_successful_scan"] = stamp
    summary["last_successful_scan"] = stamp
    state["last_broken"] = summary["broken"]
    state["last_impaired"] = summary["impaired"]
    state["last_warnings"] = summary["warnings"]

    fresh, message = _notify_pass(findings, not manual, state)
    task.executor(ha_config_scan.save_notify_state, state)
    _publish_state(summary)
    size = task.executor(ha_config_scan.write_report,
                         ha_config_scan.render_report(summary, findings, hidden))

    log.info(
        f"config_health: {summary['status']} - {summary['broken']} broken, "
        f"{summary['impaired']} impaired, {summary['warnings']} warnings, "
        f"{summary['ignored']} ignored; {len(fresh)} new"
        f"{' (notified)' if message else ''}; report {size}B; "
        f"{time.time() - started:.1f}s"
    )
    return summary


def _next_scan():
    """The nightly job, as a plain timestamp the page can print."""
    now = time.localtime()
    day = time.time() + (0 if (now.tm_hour, now.tm_min) < (4, 17) else 86400)
    return time.strftime("%Y-%m-%d 04:17", time.localtime(day))


def _dependencies(used_at, ents, stamp, missing=None):
    """The file half of the dependency universe, in the card's shape.

    Every reference here resolved, so none of them is a finding. What they are
    is the answer to "if this entity stops answering, what stops working?" -
    for the two thirds of the configuration the browser never reads: YAML
    packages, templates.yaml, sensors.yaml and every helper's config entry.

    Runtime state is deliberately NOT decided here. The card owns that, using
    the same existence index it uses for its own references, so `unavailable`,
    `unknown`, `disabled` and `missing` mean exactly one thing across both
    scanners rather than two things that drift.
    """
    refs = task.executor(ha_config_scan.entry_refs, ents)
    deps = []
    for ref in sorted(used_at):
        owners = []
        for occ in used_at[ref]:
            f = occ["file"]
            if f == ".storage/core.config_entries":
                # attributed by the JSON walk below, not by line number
                continue
            own = {"f": f, "l": occ["line"]}
            if occ.get("holder"):
                base = f.rsplit("/", 1)[-1]
                kind = {"automations.yaml": "automation", "scripts.yaml": "script",
                        "scenes.yaml": "scene"}.get(base)
                if kind:
                    own["k"] = kind
                    own["i"] = occ["holder"]
            if "k" not in own:
                dash = ha_config_scan.dashboard_url_path(f)
                if dash:
                    own["k"] = "dashboard"
                    own["i"] = dash
                else:
                    own["k"] = "file"
                    own["i"] = f
            owners.append(own)
        for hit in refs.get(ref, []):
            owners.append({
                "k": "entry", "i": hit["entry_id"], "t": hit["title"],
                "d": hit["domain"], "f": ".storage/core.config_entries",
                "p": hit["field"],
            })
        if owners:
            deps.append({"e": ref, "o": owners})
    # The broken references ride along, so the five-minute runtime pass and a
    # restart both have the structural half of the picture without needing a
    # file scan of their own. It is the same short list the state entity
    # already carries.
    return {"generated": stamp, "scanner": ha_config_scan.SCANNER_VERSION,
            "deps": deps, "missing": missing or []}


OWNER_TYPE_WORD = {
    "automation": "automation", "script": "script", "scene": "scene",
    "dashboard": "dashboard", "file": "YAML file", "entry": "helper",
}


def _owner_identity(own, auto_keys):
    """(item_key, friendly name, type word) for one file-side owner.

    The item key is deliberately the *card's* key. Both halves have to name an
    item the same way or an ignore rule scoped to one item would quiet the page
    and not the phone.
    """
    kind = own.get("k")
    ident = own.get("i")
    if kind == "automation":
        eid = auto_keys.get(str(ident))
        if not eid:
            return "automation:" + str(ident), "automation " + str(ident), "automation"
        return "automation:" + eid, _friendly(eid), "automation"
    if kind in ("script", "scene"):
        eid = kind + "." + str(ident)
        return kind + ":" + eid, _friendly(eid), kind
    if kind == "dashboard":
        return "dashboard:" + str(ident), str(ident), "dashboard"
    if kind == "entry":
        return "entry:" + str(ident), own.get("t") or str(ident), "helper"
    return "file:" + str(ident), str(ident).split("/")[-1], "YAML file"


def _friendly(entity_id):
    st = hass.states.get(entity_id)
    if st and st.attributes.get("friendly_name"):
        return st.attributes["friendly_name"]
    return entity_id


def _where(own):
    if own.get("p"):
        return own["p"]
    if own.get("f") and own.get("l"):
        return "%s:%s" % (own["f"], own["l"])
    return own.get("f") or ""


def _age_words(iso):
    """"2 days", "4h 12m", "35s" - the phrasing the card already uses."""
    if not iso:
        return None
    try:
        from homeassistant.util import dt as dt_util
        delta = dt_util.utcnow() - dt_util.parse_datetime(iso)
        secs = int(delta.total_seconds())
    except Exception:
        return None
    if secs < 0:
        return None
    if secs < 90:
        return "%ds" % secs
    mins = secs // 60
    if mins < 60:
        return "%dm" % mins
    hours = mins // 60
    if hours < 48:
        return "%dh %dm" % (hours, mins % 60)
    return "%d days" % (hours // 24)


def _missing_owners(rec):
    """The owners of a broken reference, in the same wire shape as a dependency."""
    owners = []
    for occ in rec.get("occurrences", []):
        f = occ.get("file") or ""
        if f == ".storage/core.config_entries":
            continue
        base = f.rsplit("/", 1)[-1]
        kind = {"automations.yaml": "automation", "scripts.yaml": "script",
                "scenes.yaml": "scene"}.get(base)
        if occ.get("holder") and kind:
            owners.append({"k": kind, "i": occ["holder"], "f": f, "l": occ.get("line")})
        elif rec.get("dashboard"):
            owners.append({"k": "dashboard", "i": rec["dashboard"], "f": f, "l": occ.get("line")})
        else:
            owners.append({"k": "file", "i": f, "f": f, "l": occ.get("line")})
    for own in rec.get("owners", []):
        owners.append({"k": "entry", "i": own.get("entry_id"), "t": own.get("title"),
                       "d": own.get("domain"), "f": ".storage/core.config_entries",
                       "p": own.get("field")})
    if not owners:
        owners.append({"k": "file", "i": "configuration", "f": "configuration"})
    return owners


PROBLEM_WORD = {
    "entity": "Missing entity",
    "entity-unavailable": "Referenced entity is unavailable",
    "entity-unknown": "Referenced entity has never reported a value",
    "entity-disabled": "Referenced entity is disabled",
}


def _findings(deps, missing, ignores):
    """Every actionable finding the backend can see, classified and de-ignored.

    One row per (owner, reference): an automation naming the same silent sensor
    in five conditions is one thing to go and look at, not five.
    """
    in_reg, disabled, labels = _registry_view()
    auto_keys = _automation_keys()
    out = []
    hidden = {}
    seen = set()

    def emit(ref, kind, severity, own, since=None):
        item_key, name, type_word = _owner_identity(own, auto_keys)
        fp = "%s|%s|%s" % (kind, ref, item_key)
        if fp in seen:
            return
        rule = ha_config_scan.is_ignored(ignores, kind, ref, item_key, labels.get(ref))
        if rule:
            hidden[rule] = hidden.get(rule, 0) + 1
            return
        seen.add(fp)
        out.append({
            "fp": fp, "kind": kind, "severity": severity, "ref": ref,
            "owner": item_key, "owner_name": name, "owner_type": type_word,
            "problem": PROBLEM_WORD.get(kind, kind), "where": _where(own),
            "since": since, "for": _age_words(since),
        })

    for rec in missing or ():
        ref = rec.get("entity_id")
        if not ref:
            continue
        for own in _missing_owners(rec):
            emit(ref, "entity", "broken", own)

    for dep in deps or ():
        ref = dep.get("e")
        if not ref:
            continue
        st = hass.states.get(ref)
        kind, severity = ha_config_scan.classify(
            ref, st.state if st else None, ref in in_reg, ref in disabled)
        if not kind:
            continue
        since = None
        if severity == "impaired" and st is not None:
            since = st.last_changed.isoformat()
        for own in dep.get("o", []):
            emit(ref, kind, severity, own, since)

    return out, hidden


def _summarise(findings, hidden, base):
    """Counts the health entities publish. Items for the two that matter."""
    broken_items = {f["owner"] for f in findings if f["severity"] == "broken"}
    impaired_items = {f["owner"] for f in findings if f["severity"] == "impaired"} - broken_items
    warnings = [f for f in findings if f["severity"] == "warning"]

    def by_type(rows):
        counts = {}
        for owner in rows:
            counts[owner.split(":", 1)[0]] = counts.get(owner.split(":", 1)[0], 0) + 1
        return counts

    severities = {f["severity"] for f in findings}
    if not broken_items:
        severities.discard("broken")
    summary = dict(base)
    summary.update({
        "status": ha_config_scan.worst(severities),
        "broken": len(broken_items),
        "impaired": len(impaired_items),
        "warnings": len(warnings),
        "ignored": sum(hidden.values()),
        "broken_by_type": by_type(broken_items),
        "impaired_by_type": by_type(impaired_items),
        "broken_refs": len({f["ref"] for f in findings if f["severity"] == "broken"}),
        "impaired_refs": len({f["ref"] for f in findings if f["severity"] == "impaired"}),
    })
    return summary


@service(supports_response="only")
def config_health_deps():
    """Hand the card the full dependency universe.

    A service response rather than a state attribute: this is hundreds of
    edges, and the state machine is the wrong place to keep something that
    large, that structural and that uninteresting to every other consumer.
    """
    return task.executor(ha_config_scan.load_deps)


@time_trigger("startup")
def config_health_startup():
    """First scan after a restart, and a quiet window around it.

    Everything is briefly unavailable while Home Assistant comes up, so the
    grace window stops a restart from being reported as a house full of new
    problems. State and the page update throughout; only the phone waits.
    """
    state = task.executor(ha_config_scan.load_notify_state)
    state["grace_until"] = time.strftime(
        "%Y-%m-%d %H:%M:%S", time.localtime(time.time() + STARTUP_GRACE_SECONDS))
    task.executor(ha_config_scan.save_notify_state, state)
    _publish_discovery()
    _run_scan(manual=True)


@time_trigger("cron(17 4 * * *)")
def config_health_auto():
    """The nightly scan - the one allowed to reach the phone."""
    _run_scan(manual=False)


@time_trigger("cron(*/5 * * * *)")
def config_health_runtime():
    """Runtime-only re-evaluation, every five minutes.

    A reference breaking is a configuration event and needs a file scan; a
    reference going quiet is a runtime event and needs nothing but the state
    machine. This walks the dependency universe already in memory, so the page
    and the sensors follow the house within five minutes without the nightly
    scan being the only thing that ever updates them.

    It is also what makes the impaired stability rule work: a dependency has to
    still be impaired on a later pass, at least IMPAIRED_STABLE_SECONDS after
    it was first seen, before the phone hears about it.
    """
    deps = _DEPS.get("deps")
    if not deps:
        loaded = task.executor(ha_config_scan.load_deps)
        _DEPS["deps"] = loaded.get("deps") or []
        _DEPS["missing"] = loaded.get("missing") or []
        deps = _DEPS["deps"]
        if not deps:
            return
    started = time.time()
    state = task.executor(ha_config_scan.load_notify_state)
    ignores = task.executor(ha_config_scan.load_ignores)
    missing = _DEPS.get("missing") or []
    findings, hidden = _findings(deps, missing, ignores)
    summary = _summarise(findings, hidden, {
        "generated": _now(), "last_scan_iso": _iso_now(),
        "files": None, "dependencies": len(deps), "next_scan": _next_scan(),
        "last_successful_scan": state.get("last_successful_scan"),
        "scan_seconds": round(time.time() - started, 3), "error": None,
    })
    fresh, message = _notify_pass(findings, True, state)
    # All three, so a scan that later fails has a real last-known figure to
    # hold rather than falling back to zero and reading as healthy.
    state["last_broken"] = summary["broken"]
    state["last_impaired"] = summary["impaired"]
    state["last_warnings"] = summary["warnings"]
    task.executor(ha_config_scan.save_notify_state, state)
    _publish_state(summary)
    if fresh:
        log.info(f"config_health runtime: {len(fresh)} new"
                 f"{' (notified)' if message else ''} in {time.time() - started:.2f}s")


@mqtt_trigger(CMD_RESCAN)
def config_health_button():
    """The Rescan button. Same operation as the card's, and just as read-only."""
    log.info("config_health: rescan requested from the button")
    _run_scan(manual=True)


@service
def config_health_fix(entity_id=None, replacement=None):
    # Replace a missing entity reference with an existing entity.
    if not entity_id or not replacement:
        log.error("config_health_fix: entity_id and replacement are required")
        return
    if replacement not in set(hass.states.async_entity_ids()):
        log.error(f"config_health_fix: {replacement} does not exist")
        return
    items = state.getattr(STATE_ENTITY).get("missing", [])
    matches = [r for r in items if r["entity_id"] == entity_id]
    rec = matches[0] if matches else None
    if rec is None:
        log.error(f"config_health_fix: {entity_id} not in the last scan")
        return
    targets = sorted({o["file"] for o in rec["occurrences"]})
    blocked = [f for f in targets if f.startswith(".storage")]
    if blocked:
        log.error(
            f"config_health_fix: {entity_id} lives in {blocked}; HA owns those "
            "files at runtime and would overwrite the edit. Fix it in the UI."
        )
        return
    stamp = time.strftime("%Y%m%d-%H%M%S")
    changed = task.executor(
        ha_config_scan.fix_files, targets, entity_id, replacement, stamp
    )
    if not changed:
        log.warning(f"config_health_fix: nothing to change for {entity_id}")
        return
    log.warning(f"config_health_fix: {entity_id} -> {replacement} in {changed}")
    dom = RELOAD.get(rec.get("category"))
    if dom:
        service.call(dom, "reload")
    config_health_rescan()


@service
def config_health_ignore(scope=None, value=None, item=None, kind=None, note=None):
    """Accept a finding, so it stops being reported.

    Scopes:
      ref      one exact reference, e.g. sensor.old_thing
      pattern  a glob over references, e.g. sensor.*_battery
      item     a whole configuration item, e.g. automation.morning
      kind     one finding kind, optionally only within one item
      label    anything carrying a Home Assistant label
    """
    if scope not in ha_config_scan.IGNORE_SCOPES or not value:
        log.error(
            f"config_health_ignore: scope must be one of "
            f"{ha_config_scan.IGNORE_SCOPES} and value is required"
        )
        return
    rules = task.executor(ha_config_scan.load_ignores)
    rid = f"{scope}:{value}:{item or ''}:{kind or ''}"
    for r in rules:
        if r["id"] == rid:
            log.info(f"config_health_ignore: {rid} already ignored")
            return
    rules.append({
        "id": rid, "scope": scope, "value": str(value),
        "item": item or None, "kind": kind or None, "note": note or None,
        "added": time.strftime("%Y-%m-%d %H:%M:%S"),
    })
    task.executor(ha_config_scan.save_ignores, rules, time.strftime("%Y-%m-%d %H:%M:%S"))
    log.warning(f"config_health_ignore: added {rid} ({len(rules)} rules)")
    config_health_rescan()


@service
def config_health_unignore(rule_id=None, all_rules=False):
    """Removes one ignore rule, or every rule when all_rules is set."""
    if all_rules:
        task.executor(ha_config_scan.save_ignores, [], time.strftime("%Y-%m-%d %H:%M:%S"))
        log.warning("config_health_unignore: cleared every rule")
        config_health_rescan()
        return
    if not rule_id:
        log.error("config_health_unignore: rule_id is required")
        return
    rules = task.executor(ha_config_scan.load_ignores)
    keep = [r for r in rules if r["id"] != rule_id]
    if len(keep) == len(rules):
        log.warning(f"config_health_unignore: no rule {rule_id}")
        return
    task.executor(ha_config_scan.save_ignores, keep, time.strftime("%Y-%m-%d %H:%M:%S"))
    log.warning(f"config_health_unignore: removed {rule_id} ({len(keep)} left)")
    config_health_rescan()
