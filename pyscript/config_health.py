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

import io
import json
import os
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

# The operational detectors publish on their own retained topic. Separate
# from the scan's, because they run on a different clock: the configuration
# scan is nightly plus on demand, and these follow the house every five
# minutes. One topic per cadence keeps a quiet scan from republishing a busy
# operational document and the other way round.
OPS_TOPIC = BASE + "/ops"

OPS_ENTITIES = [
    {"key": "execution_errors", "domain": "sensor", "name": "Execution errors",
     "icon": "mdi:play-box-remove-outline", "tpl": "{{ value_json.execution }}",
     "unit": "incidents", "state_class": "measurement", "attrs": "execution_attrs"},
    {"key": "system", "domain": "sensor", "name": "System",
     "icon": "mdi:server", "tpl": "{{ value_json.system }}",
     "unit": "findings", "state_class": "measurement", "attrs": "system_attrs"},
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
    for spec in OPS_ENTITIES:
        cfg = {
            "name": spec["name"],
            "object_id": BASE + "_" + spec["key"],
            "unique_id": BASE + "_" + spec["key"],
            "state_topic": OPS_TOPIC,
            "value_template": spec["tpl"],
            "icon": spec.get("icon"),
            "device": DEVICE,
            "unit_of_measurement": spec.get("unit"),
            "state_class": spec.get("state_class"),
            "json_attributes_topic": OPS_TOPIC,
            "json_attributes_template": "{{ value_json.%s | tojson }}" % spec["attrs"],
        }
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


def _publish_ops(payload):
    """The operational counters, as one retained document.

    Only the live findings are counted. A recovered execution error still
    belongs on the page as evidence of what happened, but a sensor that keeps
    reading 1 for six hours after the problem stopped is a sensor nobody can
    build an automation on.
    """
    execution = [e for e in payload["execution"]
                 if ha_config_scan.incident_is_live(e.get("status"))]
    system = [s for s in payload["system"]
              if s["severity"] in ("actionable", "critical")]
    # `pending` counts. A problem nobody has re-checked since the restart is
    # not a problem that went away, and a sensor that reads zero for it would
    # be the same lie the restart already told once.
    integrations = [i for i in payload["integrations"]
                    if ha_config_scan.incident_is_open(i.get("status"))]
    body = {
        "execution": len(execution),
        "system": len(system) + len(integrations),
        "execution_attrs": {
            "recovered": len([e for e in payload["execution"]
                              if e.get("status") == "recovered"]),
            "pending": len([e for e in payload["execution"]
                            if e.get("status") == "pending"]),
            "failures": sum([e["failures"] for e in execution]),
            "items": [e["name"] for e in execution][:6],
            "generated": payload["generated"],
        },
        "system_attrs": {
            "addons": len([s for s in system if s["kind"] == "addon"]),
            "backup": len([s for s in system if s["kind"] == "backup"]),
            "integrations": len(integrations),
            "items": [s["name"] for s in system] + [i["domain"] for i in integrations],
            "generated": payload["generated"],
        },
    }
    service.call("mqtt", "publish", retain=True, topic=OPS_TOPIC,
                 payload=json.dumps(body))


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


# ======================================================================
# OPERATIONAL HEALTH
#
# The configuration scanner answers "does this point at something that
# exists". These detectors answer "is it working", which is a different
# question with different evidence, and on 2026-08-29 the difference cost a
# morning: a water-safety automation failed to switch off a running pump 94
# times in 93 minutes while every dashboard in the house stayed green,
# because every reference in it was perfectly valid.
#
# Nothing here parses a log file. Home Assistant already keeps its own
# deduplicated error store, the supervisor already knows what its add-ons
# are doing, and the backup manager already publishes when it last
# succeeded. Reading structured state beats scraping text, and it is what
# makes "94 failures" arrive as one incident instead of ninety-four.
# ======================================================================

OPS_ENTITY = "pyscript.config_health_ops"

# The operational pass runs on this beat. Cadence learning and the staleness
# clause are both expressed in multiples of it rather than in absolute
# seconds, so changing the cron changes them together.
OPS_INTERVAL_SECONDS = 300

# How long a Home Assistant restart stays on the record for availability
# masking. Two days covers a weekend of reboots without letting the list
# grow into a log; nothing downstream looks further back than a day.
RESTART_RETAIN_SECONDS = 48 * 3600

# The label that marks an automation as safety-critical, where one failed
# attempt is already the whole story. It is read from the entity registry and
# never inferred: an automation is safety-critical because someone said so,
# not because of what it is called.
SAFETY_LABEL = "safety_critical"

# Lists are capped before they reach the state machine. A page cannot use
# forty execution incidents and the recorder should not have to store them.
OPS_LIST_CAP = 20
OPS_TEXT_CAP = 240

_OPS = {}


def _system_log_records():
    """Home Assistant's own deduplicated WARNING/ERROR store.

    `hass.data["system_log"]` is the handler the system_log websocket API
    reads, and `records.to_list()` is exactly what that API returns: one
    entry per (logger, source line), each carrying a running count and the
    first and last time it fired. It holds 50 entries and is cleared by a
    restart, so this is a "since Home Assistant started" view - which is the
    right window for "is this still happening".
    """
    try:
        handler = hass.data.get("system_log")
        return list(handler.records.to_list()) if handler else []
    except Exception as err:
        log.warning(f"config_health: system_log unavailable ({err})")
        return []


def _safety_automations():
    """Entity ids carrying the safety label, from the entity registry."""
    try:
        from homeassistant.helpers import entity_registry, label_registry
        lreg = label_registry.async_get(hass)
        wanted = set()
        for lab in lreg.async_list_labels():
            if lab.label_id == SAFETY_LABEL or lab.name.lower().replace(" ", "_") == SAFETY_LABEL:
                wanted.add(lab.label_id)
        if not wanted:
            return set()
        ereg = entity_registry.async_get(hass)
        return set([e.entity_id for e in ereg.entities.values()
                    if wanted & set(e.labels or ())])
    except Exception:
        return set()


def _repair_issues():
    """Active native Home Assistant repairs, ignoring the ignored ones.

    A repair someone has dismissed is a decision, not a finding, so it never
    reaches the count. Everything else is reported with the severity Home
    Assistant itself gave it.
    """
    try:
        from homeassistant.helpers import issue_registry
        reg = issue_registry.async_get(hass)
        out = []
        for issue in reg.issues.values():
            if issue.dismissed_version or not issue.active:
                continue
            out.append({
                "domain": issue.domain,
                "issue_id": issue.issue_id,
                "severity": issue.severity if isinstance(issue.severity, str)
                else getattr(issue.severity, "value", "warning"),
                "breaks_in": issue.breaks_in_ha_version,
                "translation_key": issue.translation_key,
                "fixable": bool(issue.is_fixable),
            })
        return out
    except Exception as err:
        log.warning(f"config_health: issue registry unavailable ({err})")
        return []


async def _supervisor(path):
    """One GET against the supervisor, or None when there is no supervisor.

    A container or core install has no SUPERVISOR_TOKEN, and that is not an
    error - it means the add-on and resolution detectors have nothing to say
    and should stay silent rather than reporting a failure.
    """
    import os
    token = os.environ.get("SUPERVISOR_TOKEN")
    if not token:
        return None
    try:
        from homeassistant.helpers.aiohttp_client import async_get_clientsession
        session = async_get_clientsession(hass)
        resp = await session.get("http://supervisor" + path,
                                 headers={"Authorization": "Bearer " + token},
                                 timeout=aiohttp_timeout())
        if resp.status != 200:
            return None
        body = await resp.json()
        return body.get("data", body)
    except Exception as err:
        log.warning(f"config_health: supervisor {path} unavailable ({err})")
        return None


def aiohttp_timeout():
    import aiohttp
    return aiohttp.ClientTimeout(total=10)


def _addons():
    try:
        from homeassistant.components.hassio import get_addons_info
        return get_addons_info(hass) or {}
    except Exception:
        return {}


def _backup_times():
    """(last success, last attempt) as epochs, from the native entities."""
    def epoch(entity_id):
        st = hass.states.get(entity_id)
        if st is None or st.state in (None, "", "unknown", "unavailable"):
            return None
        try:
            from homeassistant.util import dt as dt_util
            parsed = dt_util.parse_datetime(st.state)
            return parsed.timestamp() if parsed else None
        except Exception:
            return None
    return (epoch("sensor.backup_last_successful_automatic_backup"),
            epoch("sensor.backup_last_attempted_automatic_backup"))


def _entity_name(entity_id):
    st = hass.states.get(entity_id)
    if st is not None:
        name = (st.attributes or {}).get("friendly_name")
        if name:
            return name
    return entity_id.split(".", 1)[-1].replace("_", " ")


def _entry_titles(domain):
    """Config entry titles for an integration, so an error can name what it
    belongs to. One entry means the mapping is certain; several mean the
    error belongs to one of them and this cannot tell which."""
    try:
        entries = hass.config_entries.async_entries(domain)
        return [e.title for e in entries]
    except Exception:
        return []


def _ops_execution(incidents, now_ts, safety):
    """Execution-error incidents, one per automation or script."""
    parsed = []
    for inc in incidents:
        if inc["level"] != "ERROR":
            continue
        p = ha_config_scan.parse_execution(inc)
        if p:
            parsed.append((p, inc))
    out = []
    for item in ha_config_scan.merge_executions(parsed):
        is_safety = item["entity_id"] in safety
        sev = ha_config_scan.execution_severity(
            item["recent"], item["last"], now_ts, safety=is_safety)
        if sev == "gone":
            continue
        st = hass.states.get(item["entity_id"])
        out.append({
            "entity_id": item["entity_id"],
            "type": item["domain"],
            "name": _entity_name(item["entity_id"]),
            "where": item["where"],
            "step": item["step"],
            "error": (item["error"] or "")[:OPS_TEXT_CAP],
            "failures": item["count"],
            "recent": item["recent"],
            "first": _stamp(item["first"]),
            "last": _stamp(item["last"]),
            "quiet_for": int(max(0, now_ts - item["last"])),
            "severity": sev,
            "safety": is_safety,
            "recurring": sev == "actionable",
            "enabled": bool(st is not None and st.state == "on"),
            "fp": "exec:" + item["entity_id"],
        })
    return out[:OPS_LIST_CAP]


def _ops_integrations(incidents, now_ts, ignores=None):
    """Integrations throwing repeatedly behind a config entry that still
    claims to be loaded - the Tapo camera class, where nothing else in Home
    Assistant says anything is wrong."""
    out = []
    for inc in incidents:
        if inc["level"] != "ERROR" or ha_config_scan.log_is_noise(inc["name"]):
            continue
        if ha_config_scan.parse_execution(inc):
            continue  # an execution error, reported as one
        domain, confidence = ha_config_scan.integration_of(inc)
        if not domain:
            continue
        # Every error is folded in, even a single one. It arrives as
        # `evidence` - remembered, never shown, never notified - because a
        # record dropped here can never accumulate across a restart, and that
        # is exactly how a camera failing every ten minutes stayed invisible.
        sev = ha_config_scan.integration_status(
            inc["recent"], inc["last"], inc["first"], now_ts, inc["count"])
        titles = _entry_titles(domain)
        if ha_config_scan.is_ignored(ignores, "integration", domain, "integ:" + domain, []):
            continue
        out.append({
            "domain": domain,
            "confidence": confidence,
            # Naming the wrong device is worse than naming none, so a domain
            # with several entries reports the count instead of guessing.
            "entry": titles[0] if len(titles) == 1 else None,
            "entries": len(titles),
            "logger": inc["name"],
            "message": (inc["message"] or "")[:OPS_TEXT_CAP],
            "errors": inc["count"],
            "recent": inc["recent"],
            "first": _stamp(inc["first"]),
            "last": _stamp(inc["last"]),
            "severity": sev,
            "fp": "integ:" + domain + ":" + inc["key"],
        })
    out.sort(key=lambda x: (0 if x["severity"] == "critical" else 1, -x["recent"]))
    return out[:OPS_LIST_CAP]


async def _ops_system(now_ts):
    """The house's own machinery: add-ons, backups, repairs, supervisor.

    Every finding carries a `kind` and a `ref` so the ignore rules that
    already govern the configuration findings govern these too. An add-on
    that stops itself by design - a one-shot installer set to start on boot -
    is a true finding by the rule and a nuisance on the page, and that is
    exactly what the ignore list is for.
    """
    out = []
    for f in ha_config_scan.addon_findings(_addons()):
        out.append({
            "kind": "addon", "name": f["name"], "detail": f["message"],
            "severity": f["severity"], "state": f["state"], "ref": f["slug"],
            "url": "/hassio/addon/" + f["slug"] + "/info",
            "fp": "addon:" + f["slug"],
        })
    success, attempt = _backup_times()
    b = ha_config_scan.backup_finding(success, attempt, now_ts)
    if b:
        out.append({
            "kind": "backup", "name": "Backup", "detail": b["message"], "ref": "backup",
            "severity": b["severity"], "url": "/config/backup",
            "fp": "backup",
        })
    issues = _repair_issues()
    if issues:
        worst = "actionable" if any([i["severity"] == "critical" for i in issues]) else "warning"
        out.append({
            "kind": "repairs", "ref": "repairs", "name": "Home Assistant Repairs",
            "detail": "%d active issue%s" % (len(issues), "" if len(issues) == 1 else "s"),
            "severity": worst, "url": "/config/repairs", "count": len(issues),
            "items": [i["domain"] + ": " + (i["translation_key"] or i["issue_id"])[:60]
                      for i in issues[:6]],
            "fp": "repairs",
        })
    res = await _supervisor("/resolution/info")
    if res:
        sup_issues = res.get("issues") or []
        unsupported = res.get("unsupported") or []
        unhealthy = res.get("unhealthy") or []
        # One row per resolution issue rather than one lumped row, so a single
        # permanent one can be silenced by ref without blinding the rest.
        # Deliberately never actionable: no_current_backup is set because Home
        # Assistant's Core backup manager only ever produces partial backups,
        # which the supervisor's check does not count - it cannot clear on its
        # own and must not be allowed to shout.
        for issue in [i.get("type") for i in sup_issues if i.get("type")]:
            out.append({
                "kind": "supervisor", "ref": issue, "name": "Supervisor",
                "detail": issue, "severity": "warning",
                "url": "/config/hardware", "fp": "supervisor:" + issue,
            })
        if unsupported or unhealthy:
            out.append({
                "kind": "supervisor", "ref": "unhealthy", "name": "Supervisor",
                "detail": "unsupported or unhealthy installation",
                "severity": "critical" if unhealthy else "warning",
                "url": "/config/hardware",
                "items": (unsupported + unhealthy)[:6], "fp": "supervisor:unhealthy",
            })
    ignores = task.executor(ha_config_scan.load_ignores)
    kept = []
    hidden = 0
    for f in out:
        if ha_config_scan.is_ignored(ignores, f["kind"], f.get("ref"), f["fp"], []):
            hidden += 1
            continue
        kept.append(f)
    _OPS["system_ignored"] = hidden
    return kept


def _stamp(epoch):
    try:
        return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(float(epoch)))
    except Exception:
        return None


def _evidence_paths(domains, store):
    """The coordinator path for each integration we are watching.

    Returns {domain: {entities, stamp, stamp_ts}}. The group is worked out
    from shared `last_reported` timestamps rather than from any list of
    entity names - Home Assistant does not publish coordinator membership,
    but a coordinator writes all of its entities in one pass, so they agree
    to the microsecond and entities on their own schedule do not.

    Grouping is NOT about excluding a live stream. That rationale came from
    the cache bug described below: `camera.…_live_view` appeared to keep
    updating while six entities froze, but measured on the attribute all
    seven write together to within a millisecond, every pass. The stream is
    coordinator-written like everything else.

    What grouping is still for is an integration that owns several
    coordinators - entities on different update paths carry genuinely
    different write times, and clustering keeps a hung path from being
    masked by a healthy one. For a single-coordinator integration it simply
    returns everything, which is the right answer.
    """
    out = {}
    if not domains:
        return out
    try:
        from homeassistant.helpers import entity_registry
        ereg = entity_registry.async_get(hass)
        stamps = {}
        for ent in ereg.entities.values():
            if ent.platform not in domains or ent.disabled_by:
                continue
            st = hass.states.get(ent.entity_id)
            if st is None:
                continue
            # Freshness comes off the ATTRIBUTE. It must not be read through
            # as_dict() or the websocket, and the reason is worth keeping,
            # because the wrong version of this line survived a full test
            # suite and reported a healthy camera as a hung coordinator for
            # hours.
            #
            # `State._as_dict` is an `@under_cached_property`, built once per
            # State object. When a write produces the same state AND the same
            # attributes, `async_set_internal` takes a fast path: it mutates
            # `old_state.last_reported = now`, updates the
            # `last_reported_timestamp` cache entry, and deliberately avoids
            # building a new State object - without invalidating the cached
            # `_as_dict`. So for an entity whose value does not change, the
            # serialised form keeps reporting the moment its State object was
            # born, while the attribute advances on every write.
            #
            # Measured on one State object at one instant, fourteen minutes
            # into what looked like a coordinator freeze:
            #
            #   .last_reported             22:46:48.072   <- 0s old, correct
            #   .as_dict()[last_reported]  22:32:46.115   <- 14m stale, cached
            #   websocket get_states       22:32:46.115   <- 14m stale, cached
            #
            # The earlier note here claimed the opposite. It misread seven
            # entities carrying near-identical attribute stamps as "the time
            # of the call"; that is simply what one coordinator pass looks
            # like, and it was the correct answer all along.
            try:
                stamp = ha_config_scan.freshness_stamp(st)
                if stamp is None:
                    continue
                stamps.setdefault(ent.platform, {})[ent.entity_id] = stamp
            except Exception:
                continue
        for domain, entity_stamps in stamps.items():
            prev = ((store.get("integrations") or {}).get("integ:" + domain) or {}).get("evidence")
            members, stamp = ha_config_scan.evidence_group(entity_stamps, prev)
            ts = None
            if stamp:
                try:
                    from homeassistant.util import dt as dt_util
                    parsed = dt_util.parse_datetime(stamp)
                    ts = parsed.timestamp() if parsed else None
                except Exception:
                    ts = None
            out[domain] = {"entities": members, "stamp": stamp, "stamp_ts": ts}
    except Exception as err:
        log.warning(f"config_health: evidence path unavailable ({err})")
    return out


def _ha_boot_marker():
    """Something that changes when, and only when, Core actually restarts.

    `@time_trigger("startup")` cannot answer this. It fires whenever
    pyscript starts, and `pyscript.reload` starts pyscript - so every
    reload was being recorded as a Home Assistant restart, appending a
    fake entry to the restart history, marking live incidents `pending`
    and opening a three-minute masking window over the unstable-device
    detector. Three of those were in the store before this was fixed, none
    of them real.

    The Core process's own start time is the marker. `/proc/self/stat`
    field 22 is the process start in clock ticks since the machine booted,
    and `/proc/uptime` says how long ago that was; together they give an
    absolute time that survives a pyscript reload untouched and changes on
    every Core restart. Measured against a real restart it read 18:51:44
    where the recorder's new run row said 18:51:47 - the three seconds
    between the process starting and the recorder opening its run.

    The recorder run is the fallback: it is Core-owned and equally correct,
    but it depends on the recorder being loaded and the process does not.
    Returns None if neither can be read, and a None marker never claims a
    restart.
    """
    try:
        fh = io.open("/proc/self/stat")
        fields = fh.read().split()
        fh.close()
        ticks = float(fields[21])
        fh = io.open("/proc/uptime")
        uptime = float(fh.read().split()[0])
        fh.close()
        hz = os.sysconf("SC_CLK_TCK")
        started = time.time() - uptime + (ticks / hz)
        # Whole seconds. The arithmetic can wobble in the last decimal
        # between passes, and a marker that changes on its own would report
        # a restart every five minutes.
        return "proc:%d" % int(started)
    except Exception:
        pass
    try:
        from homeassistant.components.recorder import get_instance
        return "recorder:%s" % get_instance(hass).recorder_runs_manager.current.start.isoformat()
    except Exception:
        return None


def _boot_changed(store):
    """Has Core restarted since the store was last written?

    Also the place where the marker is initialised. A store that has never
    seen a marker must not invent a historical restart - we simply did not
    know before now, and claiming a restart would mask device drops that
    really happened.
    """
    marker = _ha_boot_marker()
    if not marker:
        return False
    stored = store.get("boot")
    if not stored:
        store["boot"] = marker
        return False
    if marker == stored:
        return False
    store["boot"] = marker
    return True


def _record_restart(store):
    """Remember when Home Assistant started, for the unstable-device mask.

    The card cannot ask Home Assistant when it last restarted - there is no
    entity for it and the recorder run table is not exposed - so the backend,
    which is told directly by its own startup trigger, keeps the list and
    publishes it. Four restarts inside twenty minutes is what made this
    necessary: each one drops every device, and one-minute buckets let the
    drops straddle a boundary and escape the mask.
    """
    stamps = [s for s in (store.get("restarts") or []) if isinstance(s, str)]
    stamps.append(_iso_now())
    cut = time.time() - RESTART_RETAIN_SECONDS
    keep = []
    for s in stamps[-40:]:
        try:
            from homeassistant.util import dt as dt_util
            p = dt_util.parse_datetime(s)
            if p and p.timestamp() >= cut:
                keep.append(s)
        except Exception:
            continue
    store["restarts"] = keep
    return keep


def _ops_signature(payload):
    """What has to change before the state machine is written again.

    The counts and the identities matter; the ever-advancing "last seen"
    timestamp does not. Without this the entity would be rewritten every five
    minutes forever, and the recorder would carry a few megabytes a day of a
    document that mostly says the same thing.
    """
    def sig(items, *keys):
        return [[str(i.get(k)) for k in keys] for i in items]
    # Every field the page actually renders has to be in here. `safety` was
    # not, so labelling an automation safety-critical changed the payload,
    # left the signature identical, and the corrected document was never
    # published - the page kept showing the old answer with no way to tell.
    return json.dumps([
        sig(payload["execution"], "fp", "status", "failures", "safety"),
        sig(payload["integrations"], "fp", "status", "errors"),
        sig(payload["system"], "fp", "severity", "detail"),
        payload.get("ignored", 0),
    ], sort_keys=True)


async def _ops_scan(background=True):
    """One pass over every operational detector. Returns the payload."""
    started = time.time()
    now_ts = time.time()
    records = _system_log_records()
    prev = task.executor(ha_config_scan.load_log_state)
    incidents, fresh_state = ha_config_scan.fold_log_window(records, prev, now_ts)
    task.executor(ha_config_scan.save_log_state, fresh_state, _now())
    safety = _safety_automations()
    ignores = task.executor(ha_config_scan.load_ignores)
    live_exec = _ops_execution(incidents, now_ts, safety)
    live_integ = _ops_integrations(incidents, now_ts, ignores)
    system = await _ops_system(now_ts)

    # Fold this scan's evidence into what survived the last restart.
    store = task.executor(ha_config_scan.load_incidents)
    # A restart is what the Core process says it is. The startup trigger
    # is not consulted: it fires on `pyscript.reload` too, and treating
    # that as a restart is what filled the history with entries for
    # reloads that had dropped nothing.
    restarted = _boot_changed(store)
    if restarted:
        _record_restart(store)
    # Every integration we already know something about, plus anything that
    # threw this pass - those are the only paths worth watching.
    watched = set()
    for rec in store["integrations"].values():
        if rec.get("domain"):
            watched.add(rec["domain"])
    for item in live_integ:
        if item.get("domain"):
            watched.add(item["domain"])
    paths = _evidence_paths(watched, store)
    execution, integrations, store = ha_config_scan.reconcile_incidents(
        store, live_exec, live_integ, now_ts, restarted, paths, OPS_INTERVAL_SECONDS)
    store["updated"] = _now()
    task.executor(ha_config_scan.save_incidents, store)

    payload = {
        "generated": _now(),
        "execution": execution,
        "integrations": integrations,
        "system": system,
        "log_records": len(records),
        "restarted": restarted,
        "restarts": store.get("restarts") or [],
        "ignored": _OPS.get("system_ignored", 0),
        "scan_seconds": round(time.time() - started, 3),
    }
    _OPS["payload"] = payload
    signature = _ops_signature(payload)
    if _OPS.get("signature") != signature:
        _OPS["signature"] = signature
        exec_live = [e for e in payload["execution"] if e["severity"] == "actionable"]
        sys_live = [s for s in payload["system"]
                    if s["severity"] in ("actionable", "critical")]
        integ_live = [i for i in payload["integrations"] if i["severity"] == "critical"]
        state.set(
            OPS_ENTITY,
            len(exec_live) + len(sys_live) + len(integ_live),
            new_attributes={
                "friendly_name": "Config Health Operations",
                "icon": "mdi:pulse",
                "generated": payload["generated"],
                "execution": payload["execution"],
                "integrations": payload["integrations"],
                "system": payload["system"],
                "log_records": payload["log_records"],
                "restarts": payload["restarts"],
                "ignored": payload["ignored"],
                "scan_seconds": payload["scan_seconds"],
            },
        )
    _publish_ops(payload)
    return payload


def _ops_notify(payload, state_store, background):
    """New actionable operational problems, folded into the same incident
    store the configuration findings use, so one thing that has already been
    reported is never reported twice."""
    findings = []
    for e in payload["execution"]:
        # `pending` is deliberately silent. It means nobody has checked since
        # the restart, which is a thing to show and not a thing to buzz about.
        if not ha_config_scan.incident_is_live(e.get("status")):
            continue
        findings.append({
            "fp": e["fp"], "severity": "execution", "kind": "execution",
            "ref": e["entity_id"], "owner": e["entity_id"],
            "owner_name": e["name"], "owner_type": e["type"],
            "problem": "%d failed action%s, latest %s"
                       % (e["failures"], "" if e["failures"] == 1 else "s",
                          (e.get("last") or "")[11:16]),
        })
    for s in payload["system"]:
        if s["severity"] not in ("actionable", "critical"):
            continue
        findings.append({
            "fp": s["fp"], "severity": "system", "kind": s["kind"],
            "ref": s["fp"], "owner": s["fp"], "owner_name": s["name"],
            "owner_type": s["kind"], "problem": s["detail"],
        })
    for i in payload["integrations"]:
        if not ha_config_scan.incident_is_live(i.get("status")):
            continue
        findings.append({
            "fp": i["fp"], "severity": "system", "kind": "integration",
            "ref": i["domain"], "owner": i["domain"],
            "owner_name": i["entry"] or i["domain"],
            "owner_type": "integration",
            "problem": "%d errors, still failing" % i["errors"],
        })
    return findings


@service(supports_response="optional")
async def config_health_rescan(manual=True):
    """Rescan the configuration. Read-only: it parses, it never repairs.

    Answers with the summary an automation would want - status and the three
    counts - so a script can act on the result without reading an entity back.
    The dependency universe stays behind config_health_deps; nobody wants
    eighty kilobytes of edges as the reply to "is anything broken?".
    """
    summary = _run_scan(bool(manual))
    # Pressing Rescan should refresh the whole page, not the half of it that
    # comes from files.
    ops = await _ops_scan()
    summary["execution_errors"] = len([e for e in ops["execution"]
                                       if e["severity"] == "actionable"])
    summary["system_findings"] = len([f for f in ops["system"]
                                      if f["severity"] in ("actionable", "critical")])
    summary["integration_errors"] = len([i for i in ops["integrations"]
                                         if i["severity"] == "critical"])
    return summary


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
    options = task.executor(ha_config_scan.load_options)
    findings, hidden = _findings(deps, items, ignores, options["skip_label"])
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


def _findings(deps, missing, ignores, skip_label="skip_health_checks"):
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
        # A skipped device is skipped everywhere. Only the runtime verdicts go
        # quiet: a reference to an entity that has actually been deleted is a
        # broken configuration whether or not the device is skipped.
        if severity != "broken" and skip_label in (labels.get(ref) or ()):
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
async def config_health_startup():
    """First scan after a restart, and a quiet window around it.

    Everything is briefly unavailable while Home Assistant comes up, so the
    grace window stops a restart from being reported as a house full of new
    problems. State and the page update throughout; only the phone waits.
    """
    state = task.executor(ha_config_scan.load_notify_state)
    state["grace_until"] = time.strftime(
        "%Y-%m-%d %H:%M:%S", time.localtime(time.time() + STARTUP_GRACE_SECONDS))
    task.executor(ha_config_scan.save_notify_state, state)
    # Note what is NOT set here. This trigger used to raise a "restarted"
    # flag for the next operational pass, but it fires on `pyscript.reload`
    # as well as on Core startup and cannot tell the two apart. The pass
    # asks the Core process directly instead - see `_boot_changed`.
    _publish_discovery()
    _run_scan(manual=True)
    await _ops_scan()


@time_trigger("cron(17 4 * * *)")
def config_health_auto():
    """The nightly scan - the one allowed to reach the phone."""
    _run_scan(manual=False)


@time_trigger("cron(*/5 * * * *)")
async def config_health_runtime():
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
    options = task.executor(ha_config_scan.load_options)
    findings, hidden = _findings(deps, missing, ignores, options["skip_label"])
    summary = _summarise(findings, hidden, {
        "generated": _now(), "last_scan_iso": _iso_now(),
        "files": None, "dependencies": len(deps), "next_scan": _next_scan(),
        "last_successful_scan": state.get("last_successful_scan"),
        "scan_seconds": round(time.time() - started, 3), "error": None,
    })
    # The operational detectors run on the same five-minute beat and share the
    # incident store, so one pass decides what the phone hears about and the
    # two halves can never notify about the same minute separately.
    ops = await _ops_scan()
    fresh, message = _notify_pass(findings + _ops_notify(ops, state, True), True, state)
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
