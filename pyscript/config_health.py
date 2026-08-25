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

import sys
import time

if "/config/python_modules" not in sys.path:
    sys.path.append("/config/python_modules")

# pyscript keeps imported python modules in sys.modules, so drop it first or a
# pyscript reload would keep running the stale scanner.
sys.modules.pop("ha_config_scan", None)

import ha_config_scan

STATE_ENTITY = "pyscript.config_health"
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


def _publish(found, files, dynamic, ents):
    items = []
    owners = ha_config_scan.entry_owners(sorted(found))
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
        items.append(rec)
    by_cat = {}
    for it in items:
        by_cat[it["category"]] = by_cat.get(it["category"], 0) + 1
    state.set(
        STATE_ENTITY,
        len(items),
        new_attributes={
            "friendly_name": "Config Health",
            "icon": "mdi:file-search-outline",
            "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "files_scanned": files,
            "scanner_version": ha_config_scan.SCANNER_VERSION,
            "dynamic_refs": dynamic,
            "by_category": by_cat,
            "missing": items,
        },
    )
    return items


@service
def config_health_rescan():
    # Rescan the HA config for broken entity references.
    started = time.time()
    ents, svcs, doms = _known()
    found, files, dynamic = task.executor(
        ha_config_scan.scan_files, ents, svcs, doms
    )
    items = _publish(found, files, dynamic, ents)
    log.info(
        f"config_health: {len(items)} missing refs in {files} files "
        f"({time.time() - started:.1f}s)"
    )


@time_trigger("startup")
@time_trigger("cron(17 4 * * *)")
def config_health_auto():
    config_health_rescan()


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
