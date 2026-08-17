/**
 * HA Health Card
 * --------------
 * One Lovelace card that answers two questions about a Home Assistant
 * installation and keeps them strictly apart:
 *
 *   RUNTIME        is anything unhealthy right now - unreachable, silent,
 *                  disconnected, or running out of battery?
 *   CONFIGURATION  does everything the configuration points at still exist -
 *                  the entities, devices, areas, scripts, scenes, helpers and
 *                  actions named by automations, scripts, scenes and
 *                  dashboards?
 *
 * A sensor that exists but reads `unavailable` is a runtime problem. An
 * automation naming a sensor that was deleted months ago is a configuration
 * problem. They never share a card, a counter or a section.
 *
 * Everything comes from Home Assistant's own APIs and nothing else. The
 * runtime half is discovered at render time from the registries the frontend
 * already keeps in memory:
 *
 *   hass.states    -> the live state of every entity
 *   hass.entities  -> device_id, area override, platform, disabled/hidden
 *   hass.devices   -> the physical device, its name, area, model and parent
 *   hass.areas     -> the area name
 *
 * The configuration half runs once per page and asks Home Assistant for what
 * the frontend does not hold: `automation/config`, `script/config`, the scene
 * editor endpoint, `lovelace/config` for every dashboard, `lovelace/resources`
 * and the full `config/entity_registry/list`. It is strictly read-only - it
 * diagnoses and never repairs, rewrites or deletes anything.
 *
 * Nothing in this file names a specific device, entity, room or integration of
 * any particular install, and no third-party integration is required, queried
 * or read for any of it.
 *
 * The file is split into four layers:
 *
 *   1. SIGNALS   - independent runtime detectors, each turning a device's
 *                  entity set into an issue or nothing. Adding "stale sensor"
 *                  or "low link quality" later means adding one entry to
 *                  HEALTH_SIGNALS.
 *   2. ANALYSIS  - pure functions: registries in, a plain model out. No DOM.
 *   3. INSPECTOR - pure functions: raw configuration plus an existence index
 *                  in, findings out. No DOM, no writes, no network.
 *   4. RENDER    - the model to HTML. No knowledge of how anything was decided.
 *
 * Layout is CSS-driven and container-query based, so every section reflows off
 * the width the card is actually given rather than the viewport.
 *
 * No build step. Plain custom element + Shadow DOM.
 *
 * @version 2026.8.17.3
 * @license MIT
 */

(function () {
  'use strict';

  const CARD_VERSION = '2026.8.18';
  const STORE_KEY = 'device-health-card:v1';

  /* ================================================================== *
   * CONFIGURATION DEFAULTS
   * ================================================================== */

  /**
   * Domains whose state is not a health signal.
   *
   * Every entry here is a domain where a "bad looking" state is the normal
   * resting state, so including it would fill the page with false positives:
   *
   *   button, event, notify, image, scene, conversation, tts, stt,
   *   wake_word, ai_task, todo
   *       The state is a timestamp of the last activation. `unknown` means
   *       "never used", not "broken".
   *   update
   *       Firmware entities sit at `unknown` until the OTA source reports, and
   *       at `unavailable` for the placeholder devices that add-ons and
   *       frontend repositories register.
   *   person, device_tracker
   *       Presence semantics. `not_home`/`unknown` is a location, not a fault.
   *   siren, remote, infrared, radio_frequency
   *       Command surfaces that read `unknown` while idle.
   *   media_player
   *       A TV or speaker leaves the network when it is switched off, so
   *       `unavailable` there is a power state rather than a failure.
   */
  const DEFAULT_IGNORED_DOMAINS = [
    'button', 'event', 'notify', 'image', 'scene', 'conversation', 'tts', 'stt',
    'wake_word', 'ai_task', 'todo', 'update', 'person', 'device_tracker',
    'siren', 'remote', 'infrared', 'radio_frequency', 'media_player',
  ];

  /**
   * Integrations whose devices are intermittent by design, so "not currently
   * reachable" is their normal condition rather than a fault. Bluetooth
   * beacons are the classic case: a key fob out of range is not a broken
   * device. Override with `exclude_integrations: []` to see them.
   */
  const DEFAULT_EXCLUDED_INTEGRATIONS = ['ibeacon'];

  /** Battery percentage at or below which a device wants attention. */
  const DEFAULT_BATTERY_THRESHOLD = 20;

  /**
   * A device is only called DEGRADED when at least this share of its runtime
   * entities is unavailable. Below it, a lone unavailable diagnostic sensor on
   * an otherwise working device is treated as noise.
   */
  const DEFAULT_DEGRADED_RATIO = 0.5;

  /**
   * Integration-wide failure clustering.
   *
   *   window   how close two device failures must be to count as one event
   *   min      how many devices of one integration make it a pattern
   *   global   how many distinct integrations inside one window mean the cause
   *            is Home Assistant itself rather than any single integration
   */
  const DEFAULT_CLUSTER = { window_minutes: 10, min_devices: 3, global_integrations: 4 };

  /** How long a recovered device stays on the page. */
  const DEFAULT_RECOVERY_MINUTES = 120;

  /* Page order: the two summaries first, then the sections in the order a
     person would work through them - what is probably one shared fault, what
     needs a hand now, what is misconfigured, then the quieter registers. */
  /**
   * Where both compact tiles send you when tapped. There is no sensible
   * default: the Health view lives at whatever path its dashboard gives it, so
   * an unset `navigation_path` makes the tiles report without being tappable
   * rather than navigating somewhere that does not exist.
   */
  const COMPACT_NAV = null;

  /**
   * The three presentations of the same two models. `full` is the Health view;
   * the two compact modes are alert tiles for a main dashboard that show
   * nothing at all when there is nothing wrong.
   */
  const MODES = ['full', 'device-compact', 'configuration-compact'];
  const isCompact = (mode) => mode !== 'full';

  const DEFAULT_SECTIONS = [
    'house', 'summary', 'config_summary', 'clusters', 'attention', 'config',
    'battery', 'integrations', 'recovered', 'deleted', 'orphans',
  ];

  /* States that carry no usable reading. */
  const UNAVAILABLE = 'unavailable';
  const UNKNOWN = 'unknown';

  /**
   * State strings whose meaning is explicitly "not connected". Kept narrow on
   * purpose: `not_home`, `idle`, `standby`, `paused`, `closed` and `off` are
   * deliberately absent, because none of them means a device has failed.
   */
  const OFFLINE_WORDS = new Set([
    'offline', 'disconnected', 'unreachable', 'not_connected', 'not_responding', 'no_connection',
  ]);

  /* ================================================================== *
   * 1. SIGNALS
   *
   * A signal looks at one device's already-assembled entity buckets and
   * returns an issue or null. They are tried in order and the first match
   * wins, so the list doubles as the severity ordering.
   *
   * Each device passed in has:
   *   runtime   [{entityId, state, lastChanged, category, domain, name}]
   *   bad       runtime entities in `unavailable`
   *   unsure    runtime entities in `unknown`
   *   conn      connectivity binary sensors owned by the device
   *   explicit  runtime entities whose state literally means "disconnected"
   * ================================================================== */

  const SEVERITY = { offline: 3, disconnected: 3, degraded: 2, unknown: 1, battery: 1 };

  const HEALTH_SIGNALS = [
    {
      id: 'disconnected',
      label: 'Disconnected',
      icon: 'mdi:lan-disconnect',
      band: 'critical',
      /* An integration saying so outright beats anything inferred. A
         connectivity binary sensor is the one device class where `off` is
         defined by Home Assistant to mean disconnected. */
      evaluate(d) {
        const off = d.conn.filter((e) => e.state === 'off');
        const words = d.explicit;
        if (!off.length && !words.length) return null;
        const cause = off.concat(words);
        return { detail: 'Reported disconnected', cause };
      },
    },
    {
      id: 'offline',
      label: 'Offline',
      icon: 'mdi:lan-disconnect',
      band: 'critical',
      /* Every single runtime entity is unavailable: the device itself is gone,
         not one of its features. */
      evaluate(d) {
        if (!d.runtime.length || d.bad.length !== d.runtime.length) return null;
        return { detail: 'Unavailable', cause: d.bad };
      },
    },
    {
      id: 'degraded',
      label: 'Partly unavailable',
      icon: 'mdi:alert-circle-outline',
      band: 'warn',
      /* Some of the device answers and some does not. Requires a real share of
         it to be gone, so a single unavailable diagnostic does not raise a
         card on an otherwise working device. */
      evaluate(d, cfg) {
        if (!d.bad.length || d.bad.length === d.runtime.length) return null;
        if (d.bad.length / d.runtime.length < cfg.degraded_ratio) return null;
        return { detail: d.bad.length + ' of ' + d.runtime.length + ' unavailable', cause: d.bad };
      },
    },
    {
      id: 'unknown',
      label: 'Unknown',
      icon: 'mdi:help-circle-outline',
      band: 'unknown',
      /* Total loss of information: nothing the device owns has a usable value
         and at least one entity is `unknown` rather than `unavailable`.
         Requiring the whole device is what keeps integrations that park
         optional features at `unknown` out of the list. */
      evaluate(d) {
        if (!d.runtime.length || !d.unsure.length) return null;
        if (d.bad.length + d.unsure.length !== d.runtime.length) return null;
        if (d.bad.length > d.unsure.length) return null;
        return { detail: 'No usable state', cause: d.unsure.concat(d.bad) };
      },
    },
  ];

  /* ================================================================== *
   * 2. ANALYSIS
   * ================================================================== */

  const domainOf = (id) => id.slice(0, id.indexOf('.'));
  const numeric = (v) => {
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  };
  const toRegex = (list) => (list || []).map((p) => (p instanceof RegExp ? p : new RegExp(p)));

  /** Milliseconds since an ISO timestamp, or null when it cannot be read. */
  function ageOf(iso, now) {
    const t = Date.parse(iso);
    return isFinite(t) ? Math.max(0, now - t) : null;
  }

  /**
   * Human duration with no meaningless precision: seconds under a minute,
   * whole minutes under an hour, hours and minutes under a day, then days and
   * hours.
   */
  function durationText(ms) {
    if (ms === null || ms === undefined) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
    const d = Math.floor(h / 24);
    return d + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
  }

  function batteryIcon(level, charging) {
    if (level === null || !isFinite(level)) return charging ? 'mdi:battery-charging' : 'mdi:battery-unknown';
    const rounded = Math.round(Math.max(0, Math.min(100, level)) / 10) * 10;
    if (charging) return level >= 10 ? 'mdi:battery-charging-' + rounded : 'mdi:battery-charging-outline';
    if (level <= 5) return 'mdi:battery-alert-variant-outline';
    if (rounded >= 100) return 'mdi:battery';
    return 'mdi:battery-' + rounded;
  }

  /**
   * Transport is worked out from the registry, not from a list of product
   * names: Zigbee devices are the ones a Zigbee coordinator or bridge owns
   * (through `via_device_id`) or that the ZHA platform provides, and cloud
   * devices are the ones whose integration manifest declares a cloud
   * `iot_class`. Everything else local falls under IP/Wi-Fi.
   */
  const ZIGBEE_PLATFORMS = new Set(['zha', 'zigbee2mqtt', 'deconz', 'zigpy']);
  const ZIGBEE_HINT = /zigbee|zha\b|z2m|conbee|slzb|sonoff.?zb|coordinator/i;

  function transportOf(device, platform, hubName, manifest) {
    if (ZIGBEE_PLATFORMS.has(platform)) return 'zigbee';
    if (hubName && ZIGBEE_HINT.test(hubName)) return 'zigbee';
    const cls = manifest && manifest.iot_class;
    if (cls && cls.indexOf('cloud') === 0) return 'cloud';
    if (cls && cls.indexOf('local') === 0) return 'ip';
    return null;
  }

  function integrationName(domain, manifests) {
    const m = manifests && manifests[domain];
    if (m && m.name) return m.name;
    return String(domain || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Reduces the whole install to one row per physical device.
   *
   * The grouping key is the device registry id, so a Zigbee sensor exposing
   * motion, battery, illuminance and temperature is one row no matter how many
   * of its entities are broken. Entities with no device keep their own
   * identity and are collected separately.
   */
  function analyse(hass, cfg, now) {
    const states = hass.states || {};
    const entities = hass.entities || {};
    const devices = hass.devices || {};
    const areas = hass.areas || {};
    const manifests = cfg.manifests || {};

    const ignoredDomains = new Set(cfg.ignored_domains);
    const excludedIntegrations = new Set(cfg.exclude_integrations);
    const excludes = toRegex(cfg.exclude);

    /* ---- pass 1: bucket every usable entity onto its device ---------- */
    const byDevice = new Map();
    const orphanProblems = [];
    const batteryRows = [];

    for (const entityId in states) {
      const st = states[entityId];
      if (!st) continue;
      const reg = entities[entityId];
      const domain = domainOf(entityId);
      const state = String(st.state);

      /* Registry entries that are switched off must never reach the page:
         disabled entities keep a stale state object, and hidden ones were
         deliberately taken out of the UI. Entities with no registry entry at
         all belong to YAML platforms that predate the registry. */
      if (reg && (reg.disabled_by || reg.hidden_by || reg.hidden)) continue;
      if (excludes.some((re) => re.test(entityId))) continue;

      const platform = (reg && reg.platform) || domain;
      const deviceId = (reg && reg.device_id) || null;

      /* Battery discovery is deliberately identical to the Battery view's:
         any sensor carrying device_class battery and a percentage. */
      const attrs = st.attributes || {};
      if (domain === 'sensor' && attrs.device_class === 'battery' &&
          (attrs.unit_of_measurement === '%' || attrs.unit_of_measurement === undefined)) {
        batteryRows.push({ entityId, deviceId, platform, level: numeric(state), state, attrs });
      }

      const isBad = state === UNAVAILABLE;
      const isUnsure = state === UNKNOWN;
      const isExplicit = OFFLINE_WORDS.has(state.toLowerCase());
      const isConn = domain === 'binary_sensor' && attrs.device_class === 'connectivity';

      if (!deviceId) {
        /* Device-less entities are not devices and must not inflate the device
           counters, but they are not thrown away either. */
        if ((isBad || isUnsure || isExplicit) && !ignoredDomains.has(domain)) {
          orphanProblems.push({
            entityId, platform, state,
            name: attrs.friendly_name || entityId,
            lastChanged: st.last_changed,
          });
        }
        continue;
      }

      if (!byDevice.has(deviceId)) {
        byDevice.set(deviceId, { runtime: [], bad: [], unsure: [], conn: [], explicit: [], platforms: new Set() });
      }
      const bucket = byDevice.get(deviceId);
      bucket.platforms.add(platform);

      /* Connectivity sensors are collected even when their domain is otherwise
         in play, because they are read as an explicit signal rather than as
         part of the runtime population. */
      const row = {
        entityId, domain, state,
        name: attrs.friendly_name || entityId,
        category: (reg && reg.entity_category) || null,
        lastChanged: st.last_changed,
        deviceClass: attrs.device_class || null,
      };
      if (isConn) bucket.conn.push(row);
      if (ignoredDomains.has(domain)) continue;

      bucket.runtime.push(row);
      if (isBad) bucket.bad.push(row);
      else if (isUnsure) bucket.unsure.push(row);
      if (isExplicit) bucket.explicit.push(row);
    }

    /* ---- pass 2: classify each device -------------------------------- */
    const population = [];
    const problems = [];

    for (const [deviceId, bucket] of byDevice) {
      const device = devices[deviceId];
      if (!device || device.disabled_by) continue;
      /* A device with no runtime entities is a registry placeholder - an
         add-on, a frontend repository, a service shim - not a thing that can
         be online or offline. */
      if (!bucket.runtime.length) continue;

      const platform = pickPlatform(bucket.platforms, device, entities);
      if (excludedIntegrations.has(platform)) continue;

      const hub = device.via_device_id ? devices[device.via_device_id] : null;
      const hubName = hub ? hub.name_by_user || hub.name : null;
      const areaId = device.area_id || null;
      const entry = {
        key: deviceId,
        deviceId,
        name: device.name_by_user || device.name || deviceId,
        model: device.model || null,
        manufacturer: device.manufacturer || null,
        area: (areaId && areas[areaId] && areas[areaId].name) || null,
        platform,
        integration: integrationName(platform, manifests),
        transport: transportOf(device, platform, hubName, manifests[platform]),
        hubName,
        runtime: bucket.runtime,
        bad: bucket.bad,
        unsure: bucket.unsure,
        conn: bucket.conn,
        explicit: bucket.explicit,
      };
      population.push(entry);

      for (const signal of HEALTH_SIGNALS) {
        const issue = signal.evaluate(entry, cfg);
        if (!issue) continue;
        entry.issue = { id: signal.id, label: signal.label, icon: signal.icon, band: signal.band, ...issue };
        /* The problem started when the earliest entity responsible for it
           last changed - a device that lost one entity an hour ago and the
           rest a minute ago has been in trouble for an hour. */
        entry.since = issue.cause.map((e) => e.lastChanged).filter(Boolean).sort()[0] || null;
        entry.age = entry.since ? ageOf(entry.since, now) : null;
        problems.push(entry);
        break;
      }
    }

    /* ---- batteries ---------------------------------------------------- */
    const batteries = buildBatteries(batteryRows, devices, areas, states, entities, cfg, excludedIntegrations, manifests);
    const lowBatteries = batteries.filter((b) => b.level !== null && b.level <= cfg.battery_threshold);

    /* ---- fold sub-devices into their parent ---------------------------- */
    foldSubDevices(problems, devices);
    disambiguate(problems);

    /* ---- integrations -------------------------------------------------- */
    const integrations = buildIntegrations(population, problems, manifests);

    /* ---- orphans grouped by platform ----------------------------------- */
    const orphans = groupOrphans(orphanProblems, now, manifests);

    /* ---- clusters ------------------------------------------------------ */
    const clusters = findClusters(problems, orphanProblems, cfg, manifests);

    const counts = {
      population: population.length,
      offline: problems.filter((p) => p.issue.id === 'offline' || p.issue.id === 'disconnected').length,
      degraded: problems.filter((p) => p.issue.id === 'degraded').length,
      unknown: problems.filter((p) => p.issue.id === 'unknown').length,
      lowBattery: lowBatteries.length,
    };
    counts.online = population.length - problems.length;

    problems.sort(byUrgency);
    return {
      counts, population, problems, integrations, clusters, batteries, lowBatteries, orphans,
      /* Recovery tracking needs to tell "this device came back" from "this
         device was deleted", and the device registry is the only thing that
         knows the difference. */
      deviceIds: new Set(Object.keys(devices)),
    };
  }

  /**
   * Some integrations model one physical thing as a parent device plus
   * sub-devices - a printer and its spool, a hub and its radio. When a child
   * and its parent are broken in the same way they are one problem, so the
   * child is folded in rather than raising a second card.
   *
   * This is safe for the hub case that looks similar: Zigbee devices point at
   * their coordinator through the same field, but a working coordinator is not
   * in the problem list, so nothing is ever folded into it.
   */
  function foldSubDevices(problems, devices) {
    const byId = new Map(problems.map((p) => [p.deviceId, p]));
    for (let i = problems.length - 1; i >= 0; i--) {
      const child = problems[i];
      const device = devices[child.deviceId];
      const parent = device && device.via_device_id ? byId.get(device.via_device_id) : null;
      if (!parent || parent === child) continue;
      if (parent.issue.id !== child.issue.id) continue;
      parent.runtime = parent.runtime.concat(child.runtime);
      parent.issue.cause = parent.issue.cause.concat(child.issue.cause);
      parent.subDevices = (parent.subDevices || 0) + 1;
      if (child.since && (!parent.since || child.since < parent.since)) parent.since = child.since;
      problems.splice(i, 1);
      byId.delete(child.deviceId);
    }
  }

  /**
   * Two identical products in one house share a device name. Left alone the
   * page shows the same title twice with no way to tell which one is broken,
   * so colliding names get the shortest distinguishing detail available.
   */
  function disambiguate(problems) {
    const byName = new Map();
    for (const p of problems) {
      if (!byName.has(p.name)) byName.set(p.name, []);
      byName.get(p.name).push(p);
    }
    for (const [, list] of byName) {
      if (list.length < 2) continue;
      for (const p of list) {
        const areaUnique = p.area && list.filter((o) => o.area === p.area).length === 1;
        p.name = p.name + ' (' + (areaUnique ? p.area : p.deviceId.slice(-4)) + ')';
      }
    }
  }

  /**
   * Which integration owns a device. `primary_config_entry` is an entry id and
   * the frontend has no entry table, so the platform recorded on the device's
   * own entities is the reliable answer; the most common one wins when a
   * device carries entities from several.
   */
  function pickPlatform(platforms, device, entities) {
    if (platforms.size === 1) return [...platforms][0];
    const counts = new Map();
    for (const id in entities) {
      if (entities[id].device_id !== device.id) continue;
      const p = entities[id].platform;
      if (p) counts.set(p, (counts.get(p) || 0) + 1);
    }
    let best = null;
    let bestN = -1;
    for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
    return best || [...platforms][0];
  }

  /** Problems first by severity, then longest-running, then by name. */
  function byUrgency(a, b) {
    const sa = SEVERITY[a.issue.id] || 0;
    const sb = SEVERITY[b.issue.id] || 0;
    if (sa !== sb) return sb - sa;
    if (a.age !== b.age) return (b.age || 0) - (a.age || 0);
    return a.name.localeCompare(b.name);
  }

  /**
   * One row per battery device, reusing the Battery view's discovery: the
   * percentage sensor identifies the device, and a sibling charging flag is
   * folded in when the device exposes one.
   */
  function buildBatteries(rows, devices, areas, states, entities, cfg, excluded, manifests) {
    const out = new Map();
    for (const r of rows) {
      const device = r.deviceId ? devices[r.deviceId] : null;
      if (device && device.disabled_by) continue;
      const platform = r.platform;
      if (excluded.has(platform)) continue;
      const key = r.deviceId || r.entityId;
      const areaId = (device && device.area_id) || null;

      let charging = null;
      if (r.deviceId) {
        for (const id in entities) {
          if (entities[id].device_id !== r.deviceId) continue;
          const st = states[id];
          if (!st) continue;
          const dc = (st.attributes || {}).device_class;
          if (id.startsWith('binary_sensor.') && (dc === 'battery_charging' || dc === 'plug')) {
            if (charging === null || dc === 'battery_charging') charging = st.state === 'on';
          } else if (id.startsWith('sensor.') && /_battery_state$|_charging_state$/.test(id)) {
            const v = String(st.state).toLowerCase();
            if (v === 'charging' || v === 'full' || v === 'plugged' || v === 'plugged_in') charging = true;
          }
        }
      }

      const row = {
        key,
        entityId: r.entityId,
        deviceId: r.deviceId,
        name: (device && (device.name_by_user || device.name)) ||
          String(r.attrs.friendly_name || r.entityId).replace(/\s+battery(\s+level)?$/i, ''),
        area: (areaId && areas[areaId] && areas[areaId].name) || null,
        level: r.level,
        state: r.state,
        charging,
        platform,
        integration: integrationName(platform, manifests),
      };
      const prev = out.get(key);
      if (!prev || (prev.level === null && row.level !== null)) out.set(key, row);
    }
    return [...out.values()].sort((a, b) => {
      if ((a.level === null) !== (b.level === null)) return a.level === null ? 1 : -1;
      return (a.level - b.level) || a.name.localeCompare(b.name);
    });
  }

  /** Every integration that owns at least one real device, with its problem count. */
  function buildIntegrations(population, problems, manifests) {
    const map = new Map();
    for (const d of population) {
      if (!map.has(d.platform)) {
        map.set(d.platform, { platform: d.platform, name: integrationName(d.platform, manifests), devices: 0, problems: 0, worst: 0 });
      }
      map.get(d.platform).devices++;
    }
    for (const p of problems) {
      const e = map.get(p.platform);
      if (!e) continue;
      e.problems++;
      e.worst = Math.max(e.worst, SEVERITY[p.issue.id] || 0);
    }
    return [...map.values()].sort(
      (a, b) => b.problems - a.problems || b.worst - a.worst || b.devices - a.devices || a.name.localeCompare(b.name)
    );
  }

  /**
   * Probable shared causes.
   *
   * Devices that fail together usually failed for one reason. Each unhealthy
   * device carries the moment its trouble started, so the onsets are sorted
   * per integration and any run of `min_devices` falling inside a
   * `window_minutes` window is reported as a possible integration-wide
   * problem - never as a certainty, because the same shape is produced by a
   * reload as by a dead coordinator.
   *
   * The window is then re-checked across integrations. When one window holds
   * failures from `global_integrations` different integrations, blaming any
   * one of them would be wrong: that is the signature of Home Assistant or its
   * host restarting, and it is reported as such instead.
   *
   * Device-less entities are counted as evidence in that second check only.
   * They are the part that separates the two shapes: a restart takes the
   * helpers, templates and YAML entities down with the hardware, while a dead
   * coordinator or a stopped add-on leaves them untouched.
   */
  function findClusters(problems, orphanProblems, cfg, manifests) {
    const windowMs = cfg.cluster.window_minutes * 60000;
    const dated = problems.filter((p) => p.since);
    if (!dated.length) return [];
    const witnesses = dated.concat(
      (orphanProblems || []).filter((o) => o.lastChanged).map((o) => ({ platform: o.platform, since: o.lastChanged }))
    );

    const byPlatform = new Map();
    for (const p of dated) {
      if (!byPlatform.has(p.platform)) byPlatform.set(p.platform, []);
      byPlatform.get(p.platform).push(p);
    }

    const candidates = [];
    for (const [platform, list] of byPlatform) {
      list.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
      let i = 0;
      while (i < list.length) {
        const start = Date.parse(list[i].since);
        let j = i;
        while (j + 1 < list.length && Date.parse(list[j + 1].since) - start <= windowMs) j++;
        const group = list.slice(i, j + 1);
        if (group.length >= cfg.cluster.min_devices) {
          candidates.push({ platform, name: integrationName(platform, manifests), devices: group, from: start, to: Date.parse(group[group.length - 1].since) });
        }
        i = j + 1;
      }
    }
    if (!candidates.length) return [];

    /* Was the whole install affected in the same window? */
    const out = [];
    const claimed = new Set();
    for (const c of candidates) {
      if (claimed.has(c.platform)) continue;
      const inWindow = (t) => t >= c.from - windowMs && t <= c.to + windowMs;
      const overlapping = dated.filter((p) => inWindow(Date.parse(p.since)));
      const platforms = new Set(witnesses.filter((w) => inWindow(Date.parse(w.since))).map((w) => w.platform));
      if (platforms.size >= cfg.cluster.global_integrations) {
        for (const p of new Set(overlapping.map((o) => o.platform))) claimed.add(p);
        /* Name the device-owning integrations and how many each lost: that is
           what the reader has to go and check afterwards. */
        const perInteg = new Map();
        for (const p of overlapping) perInteg.set(p.platform, (perInteg.get(p.platform) || 0) + 1);
        out.push({
          scope: 'global',
          title: 'Possible Home Assistant restart or host-level event',
          detail:
            overlapping.length + ' devices stopped responding together with helper and template entities: ' +
            [...perInteg.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([p, n]) => integrationName(p, manifests) + ' (' + n + ')')
              .join(', '),
          devices: overlapping.length,
          platforms: [...perInteg.keys()].map((p) => integrationName(p, manifests)).sort(),
          at: c.from,
        });
      } else {
        claimed.add(c.platform);
        out.push({
          scope: 'integration',
          title: 'Possible ' + c.name + ' issue',
          detail: c.devices.length + ' devices affected',
          devices: c.devices.length,
          platforms: [c.name],
          at: c.from,
        });
      }
    }
    /* One global card is enough however many integrations triggered it. */
    const seen = new Set();
    return out.filter((c) => {
      const k = c.scope + '|' + c.title;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).sort((a, b) => b.devices - a.devices);
  }

  /** Device-less problem entities, folded into one row per integration. */
  function groupOrphans(list, now, manifests) {
    const map = new Map();
    for (const o of list) {
      if (!map.has(o.platform)) {
        map.set(o.platform, { platform: o.platform, name: integrationName(o.platform, manifests), entities: [], since: null });
      }
      const g = map.get(o.platform);
      g.entities.push(o);
      if (!g.since || (o.lastChanged && o.lastChanged < g.since)) g.since = o.lastChanged;
    }
    return [...map.values()].map((g) => {
      g.entities.sort((a, b) => a.entityId.localeCompare(b.entityId));
      g.unavailable = g.entities.filter((e) => e.state === UNAVAILABLE).length;
      g.unknown = g.entities.filter((e) => e.state === UNKNOWN).length;
      g.age = g.since ? ageOf(g.since, now) : null;
      return g;
    }).sort((a, b) => b.entities.length - a.entities.length);
  }

  /* ================================================================== *
   * 3. CONFIGURATION INSPECTOR
   *
   * A separate concern from everything above. The runtime engine asks "is this
   * device answering right now?"; this asks "does everything the configuration
   * points at still exist?". The two must never be mixed: a sensor that exists
   * but reads `unavailable` is a device problem, and an automation naming a
   * sensor that was deleted months ago is a configuration problem.
   *
   * The inspector is pure and read-only. It is handed the raw configuration of
   * every automation, script, scene and dashboard plus an existence index built
   * from the registries, and returns findings. It never writes anything back,
   * and nothing here can repair, rewrite or delete.
   *
   * FALSE POSITIVES ARE THE ENEMY. An inspector that reports two hundred
   * problems because it grepped for strings shaped like entity ids is worse
   * than no inspector, so every finding carries a confidence:
   *
   *   verified     the reference sits in a slot that can only hold an object of
   *                that kind, the value is static, and the object is in none of
   *                the registries. This is what the red counters count.
   *   warning      something is suspicious but a legitimate explanation exists
   *                - the object is disabled rather than gone, or its
   *                integration is simply not loaded right now.
   *   unvalidated  the slot holds a template or a runtime variable. Recorded so
   *                the coverage is honest, never counted as broken.
   * ================================================================== */

  /** Singular nouns for the configuration kinds, used in grouped headlines. */
  const CONFIG_TYPE_WORD = {
    automation: 'automation', script: 'script', scene: 'scene',
    dashboard: 'dashboard', other: 'item',
  };

  const ENTITY_ID_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
  /** Device- and entity-registry ids as they appear inside device automations. */
  const REGISTRY_ID_RE = /^[0-9a-f]{32}$/;
  const TEMPLATE_RE = /\{\{|\{%/;

  /** Values that are legal in an entity_id slot without naming an entity. */
  const ENTITY_SLOT_LITERALS = new Set(['all', 'none', '']);

  /**
   * Domains worth naming explicitly in a finding. "Missing button:" tells the
   * user where to look in a way that "Missing entity:" does not.
   */
  const DOMAIN_NOUN = {
    script: 'script',
    scene: 'scene',
    button: 'button',
    automation: 'automation',
    input_boolean: 'helper', input_number: 'helper', input_select: 'helper',
    input_text: 'helper', input_datetime: 'helper', input_button: 'helper',
    counter: 'helper', timer: 'helper', schedule: 'helper', todo: 'helper',
    zone: 'zone', person: 'person', group: 'group',
  };

  /**
   * Template helpers whose first argument is an entity id. Anything not on this
   * list is left alone: guessing at arbitrary Jinja is how an inspector starts
   * inventing problems.
   */
  const TEMPLATE_ENTITY_FN =
    /\b(?:states|is_state|state_attr|is_state_attr|has_value|expand|state_translated|device_id|area_id|area_name|device_attr|is_device_attr|label_id|labels|integration_entities)\s*\(\s*(['"])([a-z][a-z0-9_]*\.[a-z0-9_]+)\1/g;
  /** The dotted form, `states.sensor.foo.state`. */
  const TEMPLATE_DOTTED_RE = /\bstates\.([a-z][a-z0-9_]*)\.([a-z0-9_]+)\b/g;
  /** A quoted domain prefix glued to something else - deliberately unresolvable. */
  const TEMPLATE_DYNAMIC_RE = /(['"])[a-z][a-z0-9_]*\.\1\s*[~+]|[~+]\s*(['"])\.[a-z0-9_]*\2|states\s*\[/;

  /**
   * Keys whose value is a reference, and to what. This is the whole reason the
   * inspector is structural rather than textual: a string only becomes a
   * reference because of the slot it sits in, so `example: "switch.foo"` in a
   * script's field documentation is never mistaken for a call.
   */
  const REF_KEYS = {
    entity_id: 'entity',
    device_id: 'device',
    area_id: 'area',
    floor_id: 'floor',
    label_id: 'label',
    zone: 'entity',
    /* Lovelace spellings. `entities:` is a list of ids or of row objects on a
       card, and a map of id to desired state in a scene; both are handled. */
    entity: 'entity',
    entities: 'entity',
    camera_image: 'entity',
    /* `scene:` inside script/automation shorthand, `snapshot_entities` in
       scene.create. */
    scene: 'entity',
    snapshot_entities: 'entity',
  };

  /**
   * Blocks that make up an automation or script, and the label each one gets in
   * a finding's location. Both the pre-2024.10 singular keys and the current
   * plural ones are accepted, because Home Assistant still stores whichever
   * spelling the item was written with.
   */
  const AUTOMATION_BLOCKS = [
    { keys: ['triggers', 'trigger'], label: 'Trigger' },
    { keys: ['conditions', 'condition'], label: 'Condition' },
    { keys: ['actions', 'action'], label: 'Action' },
  ];

  /** Sub-sequences inside an action, and how each reads in a location string. */
  const SEQUENCE_KEYS = {
    sequence: 'Action',
    then: 'then',
    else: 'else',
    default: 'default',
    parallel: 'parallel',
    actions: 'Action',
  };

  /**
   * The existence index. Everything the inspector asks about an object goes
   * through here, so the definition of "missing" lives in exactly one place.
   *
   * An entity is not missing merely because the state machine has no value for
   * it: an integration that failed to load leaves its entities in the registry,
   * and calling those "deleted" would blame the configuration for a runtime
   * fault. Only an object that is in neither the state machine nor any registry
   * is a candidate for missing.
   */
  function buildIndex(hass, extra) {
    const states = hass.states || {};
    const display = hass.entities || {};
    const devices = hass.devices || {};
    const areas = hass.areas || {};
    const services = hass.services || {};
    const ex = extra || {};

    /* The full entity registry is an admin-only call and is optional. Without
       it the inspector still works - it just cannot tell a disabled entity from
       a deleted one, and says so by downgrading those findings. */
    const registry = ex.registry || null;
    const disabled = new Set();
    const registryIds = new Map();
    const registered = new Set();
    if (registry) {
      for (const e of registry) {
        registered.add(e.entity_id);
        if (e.id) registryIds.set(e.id, e.entity_id);
        if (e.disabled_by) disabled.add(e.entity_id);
      }
    }

    const domains = new Set();
    for (const id in states) domains.add(domainOf(id));
    for (const id in display) domains.add(domainOf(id));
    for (const id of registered) domains.add(domainOf(id));
    for (const d in services) domains.add(d);

    return {
      hasRegistry: !!registry,
      manifests: ex.manifests || {},
      domains,
      /** 'exists' | 'disabled' | 'missing' */
      entity(id) {
        if (states[id] || display[id] || registered.has(id)) {
          return disabled.has(id) ? 'disabled' : 'exists';
        }
        return 'missing';
      },
      device: (id) => !!devices[id],
      area: (id) => !!areas[id],
      /* An empty or absent floor/label registry means the frontend never sent
         one, not that every reference is dangling - so the check is skipped
         rather than answered wrongly. */
      hasFloors: !!(hass.floors && Object.keys(hass.floors).length),
      hasLabels: !!(hass.labels && Object.keys(hass.labels).length),
      floor: (id) => !!(hass.floors && hass.floors[id]),
      label: (id) => !!(hass.labels && hass.labels[id]),
      /** Entity-registry entry id, as device triggers store it. */
      registryEntry: (id) => registryIds.get(id) || null,
      knownRegistryIds: registryIds.size > 0,
      /**
       * The one rename inference worth making. When Home Assistant re-creates
       * an entity whose id is already taken it appends `_2`, `_3` and so on, so
       * `sensor.x` gone while `sensor.x_2` exists is documented evidence that
       * the same thing was re-paired rather than a guess at similar spelling.
       * Nothing looser than this is attempted, and it never repairs anything.
       */
      renameHint(id) {
        for (let n = 2; n <= 9; n++) {
          const candidate = id + '_' + n;
          if (states[candidate] || display[candidate] || registered.has(candidate)) return candidate;
        }
        return null;
      },
      service(domain, name) {
        const d = services[domain];
        if (d && d[name]) return 'exists';
        /* A domain Home Assistant has never heard of cannot come back; one it
           knows but has not loaded is a different, softer problem. */
        if (!d && (ex.manifests || {})[domain]) return 'not_loaded';
        return 'missing';
      },
    };
  }

  /**
   * Walks one configuration tree and yields every reference it can justify.
   *
   * `emit(ref)` receives { kind, value, location, dynamic }. Locations are
   * built up as the walk descends, so a reference buried in the second option
   * of a choose inside the fifth action reports where it actually lives.
   */
  function walkRefs(node, path, emit, opts) {
    const o = opts || {};
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) walkRefs(node[i], path, emit, o);
      return;
    }
    if (typeof node !== 'object') return;

    /* Home Assistant lets a single trigger, condition or action be switched off
       in place. A switched-off block cannot break anything, so what it points
       at is still worth reporting - it is stale configuration - but never as a
       live fault. The subtree is re-walked with the flag set, with `enabled`
       blanked so the check does not fire again on the way in. */
    if (node.enabled === false) {
      const marked = (ref) => emit({ ...ref, disabledBlock: true });
      walkRefs({ ...node, enabled: undefined }, path, marked, { ...o, disabled: true });
      return;
    }

    for (const key in node) {
      const value = node[key];

      /* `choose` is the one block whose index means something to the user, so
         it is named rather than being swallowed by the generic recursion. */
      if (key === 'choose' && Array.isArray(value)) {
        value.forEach((opt, i) => walkRefs(opt, path.concat('choose #' + (i + 1)), emit, o));
        continue;
      }
      if (key === 'repeat' && value && typeof value === 'object') {
        walkRefs(value, path.concat('repeat'), emit, o);
        continue;
      }
      /* A nested condition list - the `conditions:` of a choose option, or an
         and/or/not block. Indexing it is what turns "somewhere in choose #3"
         into a place the user can actually open. */
      if ((key === 'conditions' || key === 'condition') && Array.isArray(value)) {
        value.forEach((c, i) => walkRefs(c, path.concat('Condition #' + (i + 1)), emit, o));
        continue;
      }
      if (SEQUENCE_KEYS[key] && Array.isArray(value)) {
        const label = SEQUENCE_KEYS[key];
        value.forEach((step, i) => {
          walkRefs(step, path.concat(label + ' #' + (i + 1)), emit, o);
        });
        continue;
      }

      /* A service call. `action:` replaced `service:` in 2024.8 and both are
         still stored, but `action:` is also the name of an automation's action
         block - the string test is what tells a call from a sequence. */
      if ((key === 'service' || key === 'action') && typeof value === 'string') {
        emitValue('service', value, path, emit);
        continue;
      }

      const kind = REF_KEYS[key];
      if (kind) {
        emitSlot(kind, value, path, emit, key);
        continue;
      }

      /* Everything else is only interesting for the templates it may contain
         and for the structure underneath it. */
      if (typeof value === 'string') {
        if (TEMPLATE_RE.test(value)) emitTemplate(value, path, emit);
        continue;
      }
      walkRefs(value, path, emit, o);
    }
  }

  /** An entity_id-style slot: a string, a list, or a map keyed by entity id. */
  function emitSlot(kind, value, path, emit, key) {
    if (typeof value === 'string') return emitValue(kind, value, path, emit);
    if (Array.isArray(value)) {
      for (const v of value) {
        if (typeof v === 'string') emitValue(kind, v, path, emit);
        /* Lovelace entity rows: { entity: ..., name: ... }. */
        else if (v && typeof v === 'object') walkRefs(v, path, emit, {});
      }
      return;
    }
    if (value && typeof value === 'object') {
      /* A scene's `entities:` is a map of entity id to the state to apply. */
      if (key === 'entities' || kind === 'entity') {
        for (const k in value) if (ENTITY_ID_RE.test(k)) emitValue('entity', k, path, emit);
      }
      walkRefs(value, path, emit, {});
    }
  }

  function emitValue(kind, raw, path, emit) {
    const value = String(raw).trim();
    if (TEMPLATE_RE.test(value)) {
      emit({ kind, value, location: locationOf(path), dynamic: true });
      return;
    }
    if (ENTITY_SLOT_LITERALS.has(value)) return;
    emit({ kind, value, location: locationOf(path), dynamic: false });
  }

  /**
   * Static entity references inside a template. Only the documented helpers are
   * read, and a template that builds its entity id at runtime is reported as
   * unvalidated rather than guessed at.
   */
  function emitTemplate(text, path, emit) {
    const location = locationOf(path);
    let found = false;
    let m;
    TEMPLATE_ENTITY_FN.lastIndex = 0;
    while ((m = TEMPLATE_ENTITY_FN.exec(text))) {
      emit({ kind: 'entity', value: m[2], location, dynamic: false, viaTemplate: true });
      found = true;
    }
    TEMPLATE_DOTTED_RE.lastIndex = 0;
    while ((m = TEMPLATE_DOTTED_RE.exec(text))) {
      emit({ kind: 'entity', value: m[1] + '.' + m[2], location, dynamic: false, viaTemplate: true });
      found = true;
    }
    if (TEMPLATE_DYNAMIC_RE.test(text)) {
      emit({ kind: 'entity', value: null, location, dynamic: true, viaTemplate: true });
      found = true;
    }
    return found;
  }

  function locationOf(path) {
    return path.length ? path.join(' → ') : 'Configuration';
  }

  /**
   * Turns one raw reference into a finding, or into nothing at all. This is
   * where the conservatism lives.
   */
  function judge(ref, index) {
    const finding = judgeRef(ref, index);
    if (!finding) return null;
    /* Whatever the finding is, a block the user has switched off is not a
       live fault. It is downgraded rather than dropped so the stale reference
       is still visible and still fixable. */
    if (ref.disabledBlock && finding.confidence === 'verified') {
      finding.confidence = 'warning';
      finding.message += ' (in a disabled block)';
    }
    return finding;
  }

  function judgeRef(ref, index) {
    if (ref.dynamic) {
      return {
        confidence: 'unvalidated',
        kind: ref.kind,
        ref: ref.value,
        location: ref.location,
        message: ref.value
          ? 'Unable to validate dynamic reference'
          : 'Unable to validate dynamic ' + (ref.viaTemplate ? 'template' : 'action'),
      };
    }

    if (ref.kind === 'service') {
      const value = ref.value;
      if (!ENTITY_ID_RE.test(value)) return null;
      const dot = value.indexOf('.');
      const domain = value.slice(0, dot);
      const name = value.slice(dot + 1);
      /* `script.my_script` is both a service and an entity: Home Assistant
         registers one service per script, so the entity is the thing to check
         and it gives a far clearer message. */
      if (domain === 'script' && !['turn_on', 'turn_off', 'toggle', 'reload'].includes(name)) {
        return judgeEntity({ ...ref, kind: 'entity' }, index, 'script');
      }
      const verdict = index.service(domain, name);
      if (verdict === 'exists') return null;
      if (verdict === 'not_loaded') {
        return {
          confidence: 'warning', kind: 'service', ref: value, location: ref.location,
          message: 'Action’s integration is not loaded: ' + value,
        };
      }
      return {
        confidence: 'verified', kind: 'service', ref: value, location: ref.location,
        message: 'Missing action: ' + value,
      };
    }

    if (ref.kind === 'entity') return judgeEntity(ref, index, null);

    if (ref.kind === 'device') {
      if (!REGISTRY_ID_RE.test(ref.value)) return null;
      if (index.device(ref.value)) return null;
      return {
        confidence: 'verified', kind: 'device', ref: ref.value, location: ref.location,
        message: 'Missing device',
      };
    }

    if (ref.kind === 'area') {
      if (index.area(ref.value)) return null;
      return {
        confidence: 'verified', kind: 'area', ref: ref.value, location: ref.location,
        message: 'Missing area: ' + ref.value,
      };
    }

    /* Floors and labels are newer and thinly used; a reference to one that is
       gone is real but never worth a red counter on its own. */
    if (ref.kind === 'floor' && index.hasFloors && !index.floor(ref.value)) {
      return { confidence: 'warning', kind: 'floor', ref: ref.value, location: ref.location, message: 'Missing floor: ' + ref.value };
    }
    if (ref.kind === 'label' && index.hasLabels && !index.label(ref.value)) {
      return { confidence: 'warning', kind: 'label', ref: ref.value, location: ref.location, message: 'Missing label: ' + ref.value };
    }
    return null;
  }

  function judgeEntity(ref, index, forceNoun) {
    const value = ref.value;

    /* Device automations store the entity registry's own id here, not an
       entity id. It is only checkable when the full registry was available. */
    if (REGISTRY_ID_RE.test(value)) {
      if (!index.knownRegistryIds) return null;
      if (index.registryEntry(value)) return null;
      return {
        confidence: 'verified', kind: 'entity', ref: value, location: ref.location,
        message: 'Missing entity (device automation)',
      };
    }

    if (!ENTITY_ID_RE.test(value)) return null;
    const domain = value.slice(0, value.indexOf('.'));
    /* A domain this installation has never seen is far more likely to be a
       string that merely looks like an entity id than a deleted entity. */
    if (!index.domains.has(domain)) return null;

    const verdict = index.entity(value);
    const noun = forceNoun || DOMAIN_NOUN[domain] || 'entity';

    if (verdict === 'exists') {
      /* The entity is in the registry, so it is not missing - but if it is one
         of the automations or scripts this same scan found unloaded, calling it
         is a no-op. That happens when the YAML defining it is deleted and the
         registry entry outlives it, which nothing else on the page would
         reveal. A warning, not a break: the registry entry is real. */
      if (index.notLoaded && index.notLoaded.has(value)) {
        return {
          confidence: 'warning', kind: 'not_loaded', ref: value, location: ref.location,
          message: 'Referenced ' + noun + ' is not loaded: ' + value,
        };
      }
      return null;
    }

    if (verdict === 'disabled') {
      return {
        confidence: 'warning', kind: 'entity-disabled', ref: value, location: ref.location,
        message: 'Referenced ' + noun + ' is disabled: ' + value,
      };
    }
    return {
      confidence: index.hasRegistry ? 'verified' : 'warning',
      kind: 'entity', ref: value, location: ref.location,
      message: 'Missing ' + noun + ': ' + value,
      renamedTo: index.renameHint ? index.renameHint(value) : null,
      /* Without the full registry the state machine is the only source, and an
         integration that is merely unloaded would look like a deletion. */
      note: index.hasRegistry ? null : 'entity registry unavailable',
    };
  }

  /** Collects, judges and de-duplicates the findings of one configuration item. */
  function findingsOf(walk, index) {
    const raw = [];
    walk((ref) => raw.push(ref));
    const out = [];
    const seen = new Set();
    for (const ref of raw) {
      const f = judge(ref, index);
      if (!f) continue;
      /* The same missing entity named in three actions is three findings, but
         the same one named twice in the same place is one. */
      const key = f.confidence + '|' + f.kind + '|' + f.ref + '|' + f.location;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  }

  const CONFIDENCE_ORDER = { verified: 0, warning: 1, unvalidated: 2 };

  function summariseItem(item) {
    item.issues.sort((a, b) => {
      const c = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
      return c || String(a.location).localeCompare(String(b.location));
    });
    item.verified = item.issues.filter((i) => i.confidence === 'verified').length;
    item.warnings = item.issues.filter((i) => i.confidence === 'warning').length;
    item.unvalidated = item.issues.filter((i) => i.confidence === 'unvalidated').length;
    item.band = item.verified ? 'critical' : item.warnings ? 'warn' : 'unknown';
    return item;
  }

  /**
   * An automation or a script. Both are the same shape once the block names are
   * known, so one function walks either.
   */
  function inspectScriptLike(entry, index, type) {
    const cfg = entry.config;
    const item = {
      type,
      key: type + ':' + entry.entityId,
      entityId: entry.entityId,
      id: entry.id || null,
      name: entry.name,
      issues: [],
      inspected: false,
    };

    /* An item whose entity is unavailable never finished setting up, so there
       is no configuration to read. That is itself a problem worth reporting,
       and reporting it as "not inspected" is what stops the page implying the
       item is clean. */
    if (!cfg || typeof cfg !== 'object') {
      item.issues.push({
        confidence: entry.state === UNAVAILABLE ? 'verified' : 'warning',
        kind: 'not_loaded',
        ref: entry.entityId,
        location: 'Setup',
        message: entry.state === UNAVAILABLE
          ? 'Not loaded — its configuration failed to set up'
          : 'Configuration could not be read',
      });
      return summariseItem(item);
    }

    item.inspected = true;
    item.name = cfg.alias || entry.name;

    item.issues = findingsOf((emit) => {
      if (cfg.use_blueprint) {
        /* A blueprint's inputs are arbitrary keys whose meaning lives in the
           blueprint, so the slot cannot be trusted the way `entity_id:` can.
           Only values that are shaped like an entity id in a domain this
           install actually has are looked at. */
        const inputs = cfg.use_blueprint.input || {};
        for (const k in inputs) emitSlot('entity', inputs[k], ['Blueprint input “' + k + '”'], emit, k);
        return;
      }
      if (type === 'script') {
        const seq = cfg.sequence;
        if (Array.isArray(seq)) seq.forEach((step, i) => walkRefs(step, ['Action #' + (i + 1)], emit, {}));
        else walkRefs(seq, [], emit, {});
        return;
      }
      for (const block of AUTOMATION_BLOCKS) {
        const key = block.keys.find((k) => cfg[k] !== undefined);
        if (!key) continue;
        const value = cfg[key];
        const list = Array.isArray(value) ? value : [value];
        list.forEach((step, i) => walkRefs(step, [block.label + ' #' + (i + 1)], emit, {}));
      }
    }, index);

    return summariseItem(item);
  }

  /**
   * A scene is a flat map of entity to desired state, so the only question is
   * whether each entity still exists. An entity that exists but is currently
   * unavailable is explicitly not a scene problem - that belongs to the device
   * half of the page.
   */
  function inspectScene(entry, index) {
    const cfg = entry.config;
    const item = {
      type: 'scene',
      key: 'scene:' + entry.entityId,
      entityId: entry.entityId,
      id: entry.id || null,
      name: entry.name,
      issues: [],
      inspected: false,
    };
    if (!cfg || typeof cfg !== 'object') {
      item.issues.push({
        confidence: 'warning', kind: 'not_loaded', ref: entry.entityId, location: 'Setup',
        message: 'Configuration could not be read',
      });
      return summariseItem(item);
    }
    item.inspected = true;
    item.name = cfg.name || entry.name;
    item.issues = findingsOf((emit) => {
      emitSlot('entity', cfg.entities || {}, ['Entities'], emit, 'entities');
    }, index);
    return summariseItem(item);
  }

  /**
   * A Lovelace dashboard. Cards nest without limit and every custom card
   * invents its own option names, so the walk is the same structural one used
   * for automations - a string is only a reference because of the key above it.
   */
  function inspectDashboard(entry, index, opts) {
    const cfg = entry.config;
    const item = {
      type: 'dashboard',
      key: 'dashboard:' + entry.urlPath,
      urlPath: entry.urlPath,
      name: entry.title || entry.urlPath,
      issues: [],
      inspected: false,
      views: 0,
      cards: 0,
    };
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.views)) return summariseItem(item);

    item.inspected = true;
    const customTags = new Set();
    let cards = 0;

    /* Inspected a view at a time rather than all at once, so every finding can
       carry the view it came from. That is what lets the page offer to open the
       exact view rather than dropping the user on the dashboard's first tab to
       hunt for the card themselves. */
    cfg.views.forEach((view, vi) => {
      item.views++;
      const viewName = view.title || view.path || '#' + (vi + 1);
      /* Home Assistant routes a view by its `path` when it has one and by its
         index when it does not, and both are valid in the URL. */
      const viewPath = entry.urlPath + '/' + (view.path || vi);

      const found = findingsOf((emit) => {
        const base = ['View “' + viewName + '”'];
        const containers = [
          { list: view.badges, label: 'Badge' },
          { list: view.cards, label: 'Card' },
        ];
        (view.sections || []).forEach((section, si) => {
          containers.push({ list: section.cards, label: 'Card', prefix: 'Section #' + (si + 1) });
        });
        for (const c of containers) {
          if (!Array.isArray(c.list)) continue;
          c.list.forEach((card, ci) => {
            cards++;
            const seg = (c.prefix ? [c.prefix] : []).concat(c.label + ' #' + (ci + 1));
            collectCustomTags(card, customTags);
            walkRefs(card, base.concat(seg), emit, {});
          });
        }
      }, index);

      for (const f of found) {
        f.viewName = viewName;
        f.viewPath = viewPath;
      }
      item.issues = item.issues.concat(found);
    });

    item.cards = cards;
    item.customTags = [...customTags];

    /* A card whose element was never registered will render as a red error
       box. The check is deliberately a warning: resources are loaded
       asynchronously and a card type can legitimately be defined by an
       integration rather than by a Lovelace resource. */
    if (opts && typeof opts.isDefined === 'function') {
      for (const tag of customTags) {
        if (opts.isDefined(tag)) continue;
        item.issues.push({
          confidence: 'warning', kind: 'resource', ref: 'custom:' + tag,
          location: 'Dashboard', message: 'Custom card not registered: custom:' + tag,
        });
      }
    }

    return summariseItem(item);
  }

  /** Every `type: custom:x` in a card tree, however deeply nested. */
  function collectCustomTags(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) collectCustomTags(n, out);
      return;
    }
    if (typeof node.type === 'string' && node.type.startsWith('custom:')) {
      out.add(node.type.slice('custom:'.length));
    }
    for (const k in node) if (node[k] && typeof node[k] === 'object') collectCustomTags(node[k], out);
  }

  /**
   * Problems that belong to no single automation, script or dashboard.
   * Currently: Lovelace resources registered more than once, which makes the
   * frontend fetch and evaluate the same module twice.
   */
  function inspectResources(resources) {
    const items = [];
    const byUrl = new Map();
    for (const r of resources || []) {
      const url = String(r.url || '').split('?')[0];
      if (!url) continue;
      byUrl.set(url, (byUrl.get(url) || 0) + 1);
    }
    for (const [url, n] of byUrl) {
      if (n < 2) continue;
      items.push(summariseItem({
        type: 'other',
        key: 'resource:' + url,
        name: url.split('/').pop(),
        issues: [{
          confidence: 'warning', kind: 'resource', ref: url, location: 'Lovelace resources',
          message: 'Registered ' + n + ' times',
        }],
        inspected: true,
      }));
    }
    return items;
  }

  /**
   * Runs every inspection and reduces it to the model the page renders.
   *
   * The counters follow the rule the summary needs: one configuration item with
   * five missing references is one broken automation, not five.
   */
  function inspectConfiguration(sources, index, opts) {
    const items = [];
    const scanned = { automation: 0, script: 0, scene: 0, dashboard: 0, views: 0, cards: 0 };

    /* Worked out before anything is inspected, so an automation that calls a
       script defined later in the list is judged the same as one that calls a
       script defined earlier. */
    index.notLoaded = new Set(
      []
        .concat(sources.automations || [], sources.scripts || [], sources.scenes || [])
        .filter((e) => e && e.state === UNAVAILABLE && (!e.config || typeof e.config !== 'object'))
        .map((e) => e.entityId)
    );

    for (const entry of sources.automations || []) {
      scanned.automation++;
      items.push(inspectScriptLike(entry, index, 'automation'));
    }
    for (const entry of sources.scripts || []) {
      scanned.script++;
      items.push(inspectScriptLike(entry, index, 'script'));
    }
    for (const entry of sources.scenes || []) {
      scanned.scene++;
      items.push(inspectScene(entry, index));
    }
    for (const entry of sources.dashboards || []) {
      scanned.dashboard++;
      const item = inspectDashboard(entry, index, opts);
      scanned.views += item.views;
      scanned.cards += item.cards;
      items.push(item);
    }
    items.push(...inspectResources(sources.resources));

    /* An item whose only findings are unvalidated is not a problem: a script
       full of templated service calls is normal, well-written configuration.
       Those findings are still counted, so the coverage note stays honest, but
       they never put a card on the page. */
    const flagged = items.filter((i) => i.issues.length);
    const problems = flagged.filter((i) => i.verified || i.warnings);
    const broken = problems.filter((i) => i.verified);
    const byType = (t) => broken.filter((i) => i.type === t).length;

    /* Every finding, flattened, for the reference-level counters. */
    const all = [];
    for (const item of flagged) for (const issue of item.issues) all.push({ item, issue });
    const countRefs = (pred) => new Set(all.filter(pred).map((x) => x.issue.kind + '|' + x.issue.ref)).size;
    const verified = all.filter((x) => x.issue.confidence === 'verified');

    const counts = {
      scanned,
      brokenAutomations: byType('automation'),
      brokenScripts: byType('script'),
      brokenScenes: byType('scene'),
      dashboardProblems: byType('dashboard'),
      /* "Other" collects the problems that belong to no single automation,
         script or dashboard, and counts them whether verified or only
         suspected - there is no separate warning counter for them. */
      other: problems.filter((i) => i.type === 'other').length,
      verifiedIssues: verified.length,
      warnings: all.filter((x) => x.issue.confidence === 'warning').length,
      unvalidated: all.filter((x) => x.issue.confidence === 'unvalidated').length,
      missingEntities: countRefs((x) => x.issue.confidence === 'verified' && x.issue.kind === 'entity'),
      missingDevices: countRefs((x) => x.issue.confidence === 'verified' && x.issue.kind === 'device'),
      missingAreas: countRefs((x) => x.issue.confidence === 'verified' && x.issue.kind === 'area'),
      missingServices: countRefs((x) => x.issue.confidence === 'verified' && x.issue.kind === 'service'),
      notLoaded: problems.filter((i) => i.issues.some((s) => s.kind === 'not_loaded')).length,
    };
    counts.brokenTotal =
      counts.brokenAutomations + counts.brokenScripts + counts.brokenScenes + counts.dashboardProblems;
    /* Every configuration item with at least one verified finding, whatever its
       kind. `brokenTotal` deliberately leaves out the "other" bucket because
       the page counts that separately; the compact tile wants the whole set. */
    counts.brokenItems = items.filter((i) => i.verified).length;

    /* One dead YAML package can leave forty automations unloaded, and forty
       cards all saying the same sentence bury the two findings that actually
       need reading. They are folded into one card per type - counted
       individually above, listed individually inside. */
    const display = groupNotLoaded(problems);

    display.sort((a, b) => {
      if (a.verified !== b.verified) return b.verified - a.verified;
      if (a.warnings !== b.warnings) return b.warnings - a.warnings;
      return String(a.name).localeCompare(String(b.name));
    });

    return { items, problems: display, counts, healthy: counts.brokenTotal === 0 && counts.other === 0 };
  }

  /** Below this many, the individual cards are still the clearer answer. */
  const GROUP_NOT_LOADED_AT = 3;

  function groupNotLoaded(problems) {
    const pure = problems.filter((p) => p.issues.length === 1 && p.issues[0].kind === 'not_loaded');
    const rest = problems.filter((p) => !pure.includes(p));
    const byType = new Map();
    for (const p of pure) {
      if (!byType.has(p.type)) byType.set(p.type, []);
      byType.get(p.type).push(p);
    }
    const out = rest.slice();
    for (const [type, list] of byType) {
      if (list.length < GROUP_NOT_LOADED_AT) {
        out.push(...list);
        continue;
      }
      const label = CONFIG_TYPE_WORD[type] || type;
      const worst = list.some((p) => p.verified) ? 'verified' : 'warning';
      out.push(summariseItem({
        type,
        key: 'notloaded:' + type,
        name: list.length + ' ' + label + 's failed to load',
        grouped: true,
        members: list.map((p) => ({ name: p.name, entityId: p.entityId, state: p.issues[0].message })).sort((a, b) => a.name.localeCompare(b.name)),
        issues: [{
          confidence: worst, kind: 'not_loaded', ref: null, location: 'Setup',
          message: 'Their configuration never finished setting up, so nothing in them runs',
        }],
        inspected: false,
      }));
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Fetching what the inspector inspects.
   *
   * All of it comes from Home Assistant's own APIs, and none of it is cheap
   * enough to redo on every state change: a mid-sized install is a couple of
   * hundred round trips. So the scan runs once after the page has painted, is
   * shared by every card instance on the page, and is repeated only when the
   * user asks for it or when the set of automations, scripts or scenes changes.
   * ------------------------------------------------------------------ */

  /** Small concurrency limiter - a wall tablet should not open 200 sockets. */
  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i], i);
        } catch (e) {
          out[i] = null;
        }
      }
    });
    await Promise.all(workers);
    return out;
  }

  const friendlyName = (hass, entityId) => {
    const st = hass.states[entityId];
    return (st && st.attributes && st.attributes.friendly_name) || entityId;
  };

  const entitiesIn = (hass, domain) =>
    Object.keys(hass.states).filter((id) => id.startsWith(domain + '.')).sort();

  /**
   * `automation/config` and `script/config` are the commands the automation
   * editor itself uses. They answer for YAML-defined items as well as
   * UI-defined ones, but only while the entity is loaded - so an item that
   * failed to set up returns an error, which the inspector reports as exactly
   * that rather than as a clean bill of health.
   */
  async function fetchScriptLike(hass, domain, wsType) {
    const ids = entitiesIn(hass, domain);
    return mapLimit(ids, 8, async (entityId) => {
      const st = hass.states[entityId];
      const base = {
        entityId,
        id: (st.attributes && st.attributes.id) || null,
        state: st.state,
        name: friendlyName(hass, entityId),
        config: null,
      };
      try {
        const res = await hass.callWS({ type: wsType, entity_id: entityId });
        base.config = (res && res.config) || null;
      } catch (e) {
        base.config = null;
      }
      return base;
    });
  }

  /** Scenes have no websocket config command; the REST editor endpoint is it. */
  async function fetchScenes(hass) {
    const ids = entitiesIn(hass, 'scene');
    return mapLimit(ids, 8, async (entityId) => {
      const st = hass.states[entityId];
      const id = st.attributes && st.attributes.id;
      const base = { entityId, id: id || null, state: st.state, name: friendlyName(hass, entityId), config: null };
      if (!id) return base;
      try {
        base.config = await hass.callApi('GET', 'config/scene/config/' + id);
      } catch (e) {
        base.config = null;
      }
      return base;
    });
  }

  /**
   * Every dashboard the user has, including the default one. A dashboard still
   * in auto-generated mode has no stored configuration and answers
   * `config_not_found`; that is not a problem, so it is dropped rather than
   * reported.
   */
  async function fetchDashboards(hass) {
    let list = [];
    try {
      list = await hass.callWS({ type: 'lovelace/dashboards/list' });
    } catch (e) {
      list = [];
    }
    const targets = [{ url_path: null, title: 'Overview' }].concat(list || []);
    const out = await mapLimit(targets, 4, async (d) => {
      try {
        const config = await hass.callWS({ type: 'lovelace/config', url_path: d.url_path || null });
        if (!config) return null;
        return { urlPath: d.url_path || 'lovelace', title: d.title || d.url_path || 'Overview', config };
      } catch (e) {
        return null;
      }
    });
    return out.filter(Boolean);
  }

  /**
   * Gathers everything and runs the inspection. The full entity registry is
   * fetched here rather than reused from `hass.entities`, because the
   * frontend's copy is the display registry and has disabled entities removed -
   * which is precisely the distinction the inspector needs to make.
   */
  async function scanConfiguration(hass, cfg) {
    const [registry, resources, automations, scripts, scenes, dashboards] = await Promise.all([
      hass.callWS({ type: 'config/entity_registry/list' }).catch(() => null),
      hass.callWS({ type: 'lovelace/resources' }).catch(() => []),
      fetchScriptLike(hass, 'automation', 'automation/config'),
      fetchScriptLike(hass, 'script', 'script/config'),
      fetchScenes(hass),
      fetchDashboards(hass),
    ]);

    const index = buildIndex(hass, { registry, manifests: cfg.manifests });
    const model = inspectConfiguration(
      { automations, scripts, scenes, dashboards, resources },
      index,
      { isDefined: (tag) => !!window.customElements.get(tag) }
    );
    model.hasRegistry = !!registry;
    model.scannedAt = Date.now();
    return model;
  }

  /* ================================================================== *
   * RECOVERY TRACKING
   *
   * Home Assistant's frontend has no "was this device broken an hour ago?"
   * question to ask - state history would mean fetching a window for every
   * candidate entity on every load. Instead the card remembers the set of
   * unhealthy devices between renders and treats a device leaving that set as
   * a recovery. The set is mirrored into localStorage so the list survives a
   * reload or a walk through other views.
   *
   * The one thing that would make this lie is a stale snapshot: if the
   * dashboard has not been open for a day, everything that healed in the
   * meantime would be stamped "just recovered". So a snapshot older than the
   * recovery window is re-seeded instead of being diffed.
   * ================================================================== */

  function readStore() {
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function writeStore(data) {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch (e) {
      /* Private mode or a full quota: recovery tracking degrades to
         in-session only, which is not worth breaking the page over. */
    }
  }

  function trackRecoveries(model, cfg, now) {
    const windowMs = cfg.recovery_minutes * 60000;
    const store = readStore() || { savedAt: 0, unhealthy: {}, recovered: [], deleted: [] };
    const current = {};
    for (const p of model.problems) current[p.key] = { name: p.name, integration: p.integration, label: p.issue.label };

    let recovered = Array.isArray(store.recovered) ? store.recovered : [];
    let deleted = Array.isArray(store.deleted) ? store.deleted : [];
    const fresh = store.savedAt && now - store.savedAt <= windowMs;

    /* A device leaving the problem set means one of two very different things.
       If it is still in the device registry it started answering again. If it
       is gone from the registry it was deleted, and calling that a recovery
       reads as good news about something the user just threw away.

       The registry has to be believed only when it is actually populated: a
       frontend that has not received it yet would otherwise report every
       tracked device as deleted at once. */
    const registry = model.deviceIds;
    const registryReady = registry && registry.size > 0;
    const isDeleted = (key) => registryReady && !registry.has(key);

    if (fresh) {
      for (const key in store.unhealthy || {}) {
        if (current[key]) continue;
        const was = store.unhealthy[key];
        const entry = { key, name: was.name, integration: was.integration, label: was.label, at: now };
        recovered = recovered.filter((r) => r.key !== key);
        deleted = deleted.filter((r) => r.key !== key);
        (isDeleted(key) ? deleted : recovered).push(entry);
      }
    }

    /* A device can also be deleted after it has already been listed as
       recovered, so the existing list is re-checked rather than only the new
       arrivals. This is what moves an entry across on the render after the
       deletion, instead of leaving it mislabelled for the rest of the window. */
    const movedToDeleted = recovered.filter((r) => isDeleted(r.key));
    if (movedToDeleted.length) {
      recovered = recovered.filter((r) => !isDeleted(r.key));
      for (const r of movedToDeleted) {
        deleted = deleted.filter((d) => d.key !== r.key);
        deleted.push(r);
      }
    }

    /* A device that broke again drops off both lists. A deleted one cannot
       come back under the same id, so only the window expires it. */
    recovered = recovered.filter((r) => !current[r.key] && now - r.at <= windowMs);
    deleted = deleted.filter((r) => now - r.at <= windowMs);
    recovered.sort((a, b) => b.at - a.at);
    deleted.sort((a, b) => b.at - a.at);

    writeStore({ savedAt: now, unhealthy: current, recovered, deleted });
    model.recovered = recovered.map((r) => ({ ...r, age: now - r.at }));
    model.deleted = deleted.map((r) => ({ ...r, age: now - r.at }));
    model.recoveryFresh = !!fresh;
    return model;
  }

  /* ================================================================== *
   * 3. RENDER
   * ================================================================== */

  const esc = (s) =>
    String(s === null || s === undefined ? '' : s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );

  function sectionHtml(title, subtitle, body, extraClass) {
    return (
      '<ha-card class="sec ' + (extraClass || '') + '">' +
      '<div class="sechead"><span class="sectitle">' + esc(title) + '</span>' +
      (subtitle ? '<span class="secsub">' + esc(subtitle) + '</span>' : '') +
      '</div>' + body + '</ha-card>'
    );
  }

  /* A duration span re-reads its own timestamp on a timer, so the page ages
     without rebuilding the DOM. */
  function ageHtml(ms, cls) {
    return '<span class="' + (cls || 'age') + '" data-age="' + (ms === null ? '' : ms) + '">' + esc(durationText(ms)) + '</span>';
  }

  const SUMMARY_PILLS = [
    { key: 'offline', label: 'Offline', icon: 'mdi:lan-disconnect', band: 'critical' },
    { key: 'unknown', label: 'Unknown', icon: 'mdi:help-circle-outline', band: 'unknown' },
    { key: 'degraded', label: 'Degraded', icon: 'mdi:alert-circle-outline', band: 'warn' },
    { key: 'online', label: 'Online', icon: 'mdi:check-circle-outline', band: 'ok' },
    /* "Low battery" is one word too long for an 84px pill track and ellipsises
       to "Low batt...". The note underneath already says what low means. */
    { key: 'lowBattery', label: 'Battery', icon: 'mdi:battery-low', band: 'battery' },
  ];

  /* ================================================================== *
   * COMPACT MODES
   *
   * Two alert tiles for a main dashboard, both reading the models the full
   * page already built. Nothing here detects anything: no new threshold, no
   * second set of rules, no extra scan. Each one reduces an existing model to
   * a headline, and returns null when there is nothing to say - which is what
   * makes the tile disappear entirely rather than sit there saying "0".
   * ================================================================== */

  /** Plural helper: `n` things, with the noun agreeing. */
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');

  /**
   * The two tiles live or die together.
   *
   * Alone, a single tile takes half a row and the next unrelated card slides in
   * beside it, which reads as though the health tile belongs to whatever it
   * happens to be sitting next to. So if either tile has something to report,
   * both are shown and the row is full width; the quiet one goes grey and says
   * so. When neither has anything, both disappear exactly as before.
   *
   * Each instance publishes one boolean here and reads its peers'. That is all
   * the coupling required - the device tile still never scans configuration and
   * the configuration tile still never runs the device analysis.
   */
  const compactPeers = new Set();

  function peerHasProblem(except) {
    for (const card of compactPeers) {
      if (card !== except && card._compactHasProblem) return true;
    }
    return false;
  }

  /** The grey half of the pair: present only to keep the row whole. */
  function zeroCompact(mode, model) {
    if (mode === 'device-compact') {
      const n = (model.counts && model.counts.population) || 0;
      return {
        zero: true, band: 'ok', icon: 'mdi:heart-outline', count: 0,
        label: 'Devices', detail: n ? n + ' online' : 'All online',
      };
    }
    const conf = model.config;
    return {
      zero: true, band: 'ok', icon: 'mdi:cog-outline', count: 0,
      label: 'Config',
      /* Honest about the one moment it cannot answer yet. */
      detail: conf && conf.counts ? 'Nothing broken' : 'Checking…',
    };
  }

  /**
   * The runtime tile. Severity order matches the full page's SEVERITY table,
   * so whatever the Health view calls most urgent is what colours this tile.
   */
  const COMPACT_BUCKETS = [
    { key: 'offline', band: 'critical', word: 'offline', label: 'Offline', ids: ['offline', 'disconnected'] },
    { key: 'degraded', band: 'warn', word: 'degraded', label: 'Degraded', ids: ['degraded'] },
    { key: 'unknown', band: 'unknown', word: 'unknown', label: 'Unknown', ids: ['unknown'] },
  ];

  function deviceCompact(model, cfg) {
    const buckets = COMPACT_BUCKETS.map((b) => ({
      ...b,
      list: model.problems.filter((p) => b.ids.indexOf(p.issue.id) >= 0),
    })).filter((b) => b.list.length);

    const batteries = model.lowBatteries || [];
    const total = model.problems.length + batteries.length;
    /* Nothing actionable. The device-less orphan diagnostics deliberately do
       not count here: they are a diagnostic list on the full page, not an
       alert, and letting them raise this tile would leave it permanently on. */
    if (!total) return null;

    const categories = buckets.length + (batteries.length ? 1 : 0);
    const worst = buckets[0];
    const band = worst ? worst.band : 'battery';
    const icon = worst ? 'mdi:heart-broken-outline' : 'mdi:battery-low';

    /* One kind of problem can name itself on the tile; several kinds cannot,
       so the label becomes the generic one and the breakdown moves to the
       tooltip. The count is on the tile either way. */
    if (categories === 1 && worst) {
      const list = worst.list;
      let detail;
      if (list.length === 1) {
        detail = list[0].name + (list[0].age !== null ? ' · ' + durationText(list[0].age) : '');
      } else {
        /* All from one integration is the useful fact - the same inference the
           full page's clustering makes, reused rather than recomputed. */
        const integrations = new Set(list.map((p) => p.integration));
        detail = integrations.size === 1
          ? [...integrations][0] + ' · ' + list.length + ' affected'
          : list.map((p) => p.name).slice(0, 3).join(', ') + (list.length > 3 ? ' +' + (list.length - 3) : '');
      }
      return { band, icon, count: total, label: worst.label, detail };
    }

    if (categories === 1) {
      const lowest = batteries.reduce((a, b) => ((a.level ?? 101) <= (b.level ?? 101) ? a : b));
      return {
        band: 'battery',
        icon: 'mdi:battery-low',
        count: total,
        label: 'Battery',
        detail: lowest.level === null
          ? lowest.name
          : 'Lowest ' + lowest.name + ' · ' + Math.round(lowest.level) + '%',
      };
    }

    const bits = buckets.map((b) => b.list.length + ' ' + b.word);
    if (batteries.length) bits.push(batteries.length + ' low battery');
    return { band, icon, count: total, label: 'Attention', detail: bits.join(' · ') };
  }

  /**
   * The configuration tile. Counts only what the full inspector already calls
   * verified - warnings and unvalidated dynamic references never raise it,
   * exactly as they never raise the red counter on the Health page.
   */
  /** [long form, plural category, one-word tile label] */
  const COMPACT_CONFIG_WORD = {
    automation: ['broken automation', 'Automations', 'Automation'],
    script: ['broken script', 'Scripts', 'Script'],
    scene: ['broken scene', 'Scenes', 'Scene'],
    dashboard: ['dashboard problem', 'Dashboards', 'Dashboard'],
    other: ['configuration problem', 'Other', 'Config'],
  };

  function configCompact(conf) {
    /* `ready` is stamped on by the card's cache layer, so its absence just
       means the inspector was called directly; only an explicit false is a
       scan that failed, and a failed scan has nothing to report. */
    if (!conf || conf.ready === false || !conf.counts) return null;

    /* The items, not the cards: one grouped "32 automations failed to load"
       card stands for 32 broken automations, and the tile has to agree with
       the counter on the full page. */
    const broken = conf.items.filter((i) => i.verified);
    if (!broken.length) return null;

    const byType = new Map();
    for (const i of broken) byType.set(i.type, (byType.get(i.type) || 0) + 1);

    if (broken.length === 1) {
      const only = broken[0];
      const first = only.issues.find((i) => i.confidence === 'verified');
      return {
        band: 'critical',
        icon: 'mdi:cog-off-outline',
        count: 1,
        /* One problem can say what kind it is; the name and the fault go to the
           tooltip, and the raw reference stays on the full page. */
        label: (COMPACT_CONFIG_WORD[only.type] || COMPACT_CONFIG_WORD.other)[2],
        detail: only.name + (first ? ' · ' + shortIssue(first) : ''),
      };
    }

    const bits = [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => {
        const label = (COMPACT_CONFIG_WORD[type] || COMPACT_CONFIG_WORD.other)[1];
        return n + ' ' + (n === 1 ? label.replace(/s$/, '') : label);
      });

    return {
      band: 'critical',
      icon: 'mdi:cog-off-outline',
      count: broken.length,
      label: 'Config',
      detail: bits.join(' · '),
    };
  }

  /** "Missing entity: sensor.x" -> "Missing entity". */
  function shortIssue(issue) {
    const text = String(issue.message || '');
    const cut = text.indexOf(':');
    return cut > 0 ? text.slice(0, cut) : text;
  }

  /**
   * A compact tile is one pill - the same pill the summary rows on the full
   * page are built from, and the same shape as the battery mini tiles it sits
   * beside on the dashboard. Icon, count, one word. The detail that will not
   * fit stays in the tooltip and on the Health page, one tap away.
   */
  function compactHtml(view) {
    return (
      '<ha-card class="mini">' +
      '<button class="pill band-' + view.band + (view.zero ? ' is-zero' : '') +
      (view.nav ? ' is-tappable' : '') +
      '" type="button"' + (view.nav ? ' data-nav="' + esc(view.nav) + '"' : '') + '>' +
      '<ha-icon icon="' + esc(view.icon) + '"></ha-icon>' +
      '<span class="pnum">' + view.count + '</span>' +
      '<span class="plabel">' + esc(view.label) + '</span>' +
      /* The third row the battery tiles use for their range: same slot, same
         type size, carrying the one detail worth having without a tap. */
      '<span class="pnote">' + esc(view.detail) + '</span>' +
      '</button></ha-card>'
    );
  }

  function summarySection(model, cfg) {
    const c = model.counts;
    const notes = {
      offline: 'unreachable',
      unknown: 'no state',
      degraded: 'partly gone',
      online: 'responding',
      lowBattery: 'at or under ' + cfg.battery_threshold + '%',
    };
    const pills = SUMMARY_PILLS.map(
      (p) =>
        '<div class="pill band-' + p.band + (c[p.key] ? '' : ' is-zero') + '">' +
        '<ha-icon icon="' + p.icon + '"></ha-icon>' +
        '<span class="pnum">' + c[p.key] + '</span>' +
        '<span class="plabel">' + p.label + '</span>' +
        '<span class="pnote">' + esc(notes[p.key]) + '</span></div>'
    ).join('');
    return sectionHtml('Device status', c.population + ' devices monitored', '<div class="pills">' + pills + '</div>', 'sec-summary');
  }

  /* ---- house health -------------------------------------------------
   *
   * One line at the top that answers the question before any of the detail
   * does. It deliberately reads the runtime and the configuration halves
   * separately, because "eight things are offline" and "eight automations
   * point at things that no longer exist" call for completely different
   * reactions.
   * ------------------------------------------------------------------ */

  const HOUSE_STATES = {
    critical: { icon: 'mdi:heart-broken-outline', band: 'critical', word: 'Needs attention' },
    warn: { icon: 'mdi:heart-pulse', band: 'warn', word: 'Minor issues' },
    ok: { icon: 'mdi:heart-outline', band: 'ok', word: 'All healthy' },
  };

  function houseSection(model, cfg) {
    const c = model.counts;
    const conf = model.config;
    const deviceProblems = model.problems.length;
    const configBroken = conf && conf.counts ? conf.counts.brokenTotal : 0;
    const configWarn = conf && conf.counts ? conf.counts.warnings : 0;

    let level = 'ok';
    if (c.offline || configBroken) level = 'critical';
    else if (deviceProblems || c.lowBattery || configWarn) level = 'warn';
    const look = HOUSE_STATES[level];

    /* Two short clauses rather than one long one: each half of the page gets a
       sentence of its own, and a half that is clean says so. */
    const deviceLine = deviceProblems
      ? deviceProblems + (deviceProblems === 1 ? ' device needs' : ' devices need') + ' attention'
      : c.population + ' devices online';
    let configLine;
    if (!conf) configLine = conf === null ? 'Checking configuration…' : '';
    else if (!conf.ready) configLine = 'Configuration check unavailable';
    else if (configBroken) configLine = configBroken + (configBroken === 1 ? ' broken configuration item' : ' broken configuration items');
    /* Warnings are what pushed the verdict down to "minor issues", so the line
       underneath has to name them - saying "looks healthy" beside that verdict
       reads as a contradiction. */
    else if (configWarn) configLine = configWarn + (configWarn === 1 ? ' configuration warning' : ' configuration warnings');
    else configLine = 'Configuration looks healthy';

    const stats = [
      { n: c.offline, label: 'offline', band: 'critical' },
      { n: c.lowBattery, label: 'low battery', band: 'battery' },
      { n: configBroken, label: 'broken config', band: 'critical' },
    ].filter((s) => s.n);

    return sectionHtml(
      'House health', '',
      '<div class="house band-' + look.band + '">' +
      '<ha-icon class="hicon" icon="' + look.icon + '"></ha-icon>' +
      '<span class="htext"><span class="hword">' + esc(look.word) + '</span>' +
      '<span class="hsub">' + esc(deviceLine) + (configLine ? ' &middot; ' + esc(configLine) : '') + '</span></span>' +
      (stats.length
        ? '<span class="hstats">' + stats.map((s) =>
            '<span class="hstat band-' + s.band + '"><b>' + s.n + '</b>' + esc(s.label) + '</span>').join('') + '</span>'
        : '') +
      '</div>',
      'sec-house'
    );
  }

  /* ---- configuration health ---------------------------------------- */

  const CONFIG_PILLS = [
    { key: 'brokenAutomations', label: 'Automations', icon: 'mdi:robot-off-outline' },
    { key: 'brokenScripts', label: 'Scripts', icon: 'mdi:script-text-outline' },
    { key: 'brokenScenes', label: 'Scenes', icon: 'mdi:palette-outline' },
    { key: 'dashboardProblems', label: 'Dashboards', icon: 'mdi:view-dashboard-outline' },
    { key: 'other', label: 'Other', icon: 'mdi:cog-outline' },
  ];

  function configSummarySection(model) {
    const conf = model.config;
    if (!conf) {
      return sectionHtml(
        'Configuration health', 'scanning',
        '<div class="scanning"><ha-icon icon="mdi:progress-clock"></ha-icon>' +
        '<span>Reading automations, scripts, scenes and dashboards…</span></div>',
        'sec-config-summary'
      );
    }
    if (!conf.ready) {
      return sectionHtml(
        'Configuration health', '',
        '<div class="empty"><ha-icon icon="mdi:shield-alert-outline"></ha-icon>' +
        '<span>' + esc(conf.error || 'The configuration could not be read.') + '</span></div>',
        'sec-config-summary'
      );
    }

    const c = conf.counts;
    const s = c.scanned;
    const pills = CONFIG_PILLS.map((p) =>
      '<div class="pill pill-wrap band-critical' + (c[p.key] ? '' : ' is-zero') + '">' +
      '<ha-icon icon="' + p.icon + '"></ha-icon>' +
      '<span class="pnum">' + c[p.key] + '</span>' +
      '<span class="plabel">' + p.label + '</span></div>'
    ).join('');

    /* The subtitle is the coverage claim, and it has to be honest: an item
       whose configuration could not be read was counted as scanned but not
       actually inspected, and saying so is the difference between a clean
       result and a silent blind spot. */
    const sub = s.automation + ' automations · ' + s.script + ' scripts · ' +
      s.scene + ' scenes · ' + s.cards + ' cards';

    const extra = [];
    if (c.warnings) extra.push(c.warnings + (c.warnings === 1 ? ' warning' : ' warnings'));
    if (c.unvalidated) extra.push(c.unvalidated + ' dynamic reference' + (c.unvalidated === 1 ? '' : 's') + ' not checkable');
    if (!conf.hasRegistry) extra.push('entity registry unavailable — findings downgraded');

    return sectionHtml(
      'Configuration health', sub,
      '<div class="pills pills-config">' + pills + '</div>' +
      '<div class="confnote">' +
      '<span>' + esc(extra.join(' · ')) + '</span>' +
      '<button class="rescan" type="button" data-rescan="1">' +
      '<ha-icon icon="mdi:refresh"></ha-icon>Rescan</button></div>',
      'sec-config-summary'
    );
  }

  /* ---- broken configuration ---------------------------------------- */

  const CONFIG_TYPE = {
    automation: { label: 'Automation', icon: 'mdi:robot-outline' },
    script: { label: 'Script', icon: 'mdi:script-text-outline' },
    scene: { label: 'Scene', icon: 'mdi:palette-outline' },
    dashboard: { label: 'Dashboard', icon: 'mdi:view-dashboard-outline' },
    other: { label: 'Configuration', icon: 'mdi:cog-outline' },
  };

  const CONFIG_CHIPS = [
    { id: 'all', label: 'All' },
    { id: 'automation', label: 'Automations' },
    { id: 'script', label: 'Scripts' },
    { id: 'scene', label: 'Scenes' },
    { id: 'dashboard', label: 'Dashboards' },
    { id: 'other', label: 'Other' },
  ];

  const CONFIDENCE_DOT = { verified: '🔴', warning: '🟠', unvalidated: '⚪' };

  function issueHtml(issue) {
    return (
      '<div class="issue is-' + issue.confidence + '">' +
      '<span class="idot">' + CONFIDENCE_DOT[issue.confidence] + '</span>' +
      '<span class="itext"><span class="imsg">' + esc(issue.message) + '</span>' +
      '<span class="iloc">' + esc(issue.location) + '</span>' +
      (issue.renamedTo
        ? '<span class="ihint">Possible renamed entity: ' + esc(issue.renamedTo) + '</span>'
        : '') +
      (issue.note ? '<span class="ihint">' + esc(issue.note) + '</span>' : '') +
      '</span></div>'
    );
  }

  /**
   * One collapsed card per configuration item, not per finding: an automation
   * with five missing references is one thing to go and fix. The headline is
   * the first verified finding, and the rest wait inside the expansion.
   */
  /**
   * Where to go to fix a dashboard problem. One button per view that actually
   * has a finding, because landing on the dashboard's first tab and hunting for
   * the card is most of the work. The dashboard itself is only offered when no
   * finding names a view - a card type that was never registered, say - so the
   * common case is a single button that goes exactly where it should.
   */
  function dashboardLinksHtml(item) {
    const views = [];
    const seen = new Set();
    for (const issue of item.issues) {
      if (!issue.viewPath || seen.has(issue.viewPath)) continue;
      seen.add(issue.viewPath);
      views.push({ path: issue.viewPath, name: issue.viewName });
    }
    const buttons = views.map((v) =>
      '<button class="devbtn" type="button" data-nav="/' + esc(v.path) + '">' +
      '<ha-icon icon="mdi:open-in-app"></ha-icon>Open “' + esc(v.name) + '”</button>'
    );
    if (!buttons.length) {
      buttons.push(
        '<button class="devbtn" type="button" data-nav="/' + esc(item.urlPath) + '">' +
        '<ha-icon icon="mdi:open-in-app"></ha-icon>Open dashboard</button>'
      );
    }
    return '<div class="dlinks">' + buttons.join('') + '</div>';
  }

  function configItemHtml(item, open) {
    const type = CONFIG_TYPE[item.type] || CONFIG_TYPE.other;
    const first = item.issues[0];
    const n = item.issues.length;
    const dot = item.verified ? '🔴' : item.warnings ? '🟠' : '⚪';
    const counts = [];
    if (item.verified) counts.push(item.verified + ' issue' + (item.verified === 1 ? '' : 's'));
    if (item.warnings) counts.push(item.warnings + ' warning' + (item.warnings === 1 ? '' : 's'));
    if (item.unvalidated) counts.push(item.unvalidated + ' unchecked');

    return (
      '<div class="prob band-' + item.band + (open ? ' is-open' : '') + '">' +
      '<button class="probhead" type="button" data-toggle="' + esc(item.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      /* Shares `picon` with the device cards so the narrow-width layout rules,
         which reposition that cell, apply here too. */
      '<span class="picon cdot">' + dot + '</span>' +
      '<span class="ptext"><span class="pname">' + esc(item.name) + '</span>' +
      '<span class="pmeta">' + esc(type.label) + '</span>' +
      '<span class="pissue">' + esc(first ? first.message : '') + '</span>' +
      '<span class="ploc">' + esc(first ? first.location : '') + '</span></span>' +
      '<span class="pright"><span class="pstatus">' + n + '</span></span>' +
      '<ha-icon class="pchev" icon="mdi:chevron-down"></ha-icon></button>' +
      (open
        ? '<div class="details">' +
          '<div class="dmeta">' +
          (counts.length ? '<span>' + esc(counts.join(' · ')) + '</span>' : '') +
          (item.entityId ? '<span class="mono">' + esc(item.entityId) + '</span>' : '') +
          (item.urlPath ? '<span class="mono">/' + esc(item.urlPath) + '</span>' : '') +
          '</div>' +
          '<div class="issues">' + item.issues.map(issueHtml).join('') + '</div>' +
          (item.members
            ? '<div class="ents">' + item.members.map((m) =>
                '<button class="ent" type="button" data-entity="' + esc(m.entityId) + '">' +
                '<span class="ename">' + esc(m.name) + '</span>' +
                '<span class="eid">' + esc(m.entityId) + '</span>' +
                '<span class="estate">not loaded</span></button>').join('') + '</div>'
            : '') +
          (item.entityId
            ? '<div><button class="devbtn" type="button" data-entity="' + esc(item.entityId) + '">' +
              '<ha-icon icon="mdi:information-outline"></ha-icon>Open ' + esc(type.label.toLowerCase()) +
              '</button></div>'
            : '') +
          (item.urlPath ? dashboardLinksHtml(item) : '') +
          '</div>'
        : '') +
      '</div>'
    );
  }

  function configSection(model, state) {
    const conf = model.config;
    if (!conf || !conf.ready) return '';

    if (!conf.problems.length) {
      return sectionHtml(
        'Broken configuration', '',
        '<div class="allgood"><ha-icon icon="mdi:check-circle-outline"></ha-icon>' +
        '<span><strong>Configuration looks healthy</strong>' +
        '<small>Every entity, device, area, script, scene and action referenced by ' +
        conf.counts.scanned.automation + ' automations, ' + conf.counts.scanned.script +
        ' scripts and ' + conf.counts.scanned.cards + ' dashboard cards still exists.</small></span></div>',
        'sec-config'
      );
    }

    const counts = new Map();
    for (const p of conf.problems) counts.set(p.type, (counts.get(p.type) || 0) + 1);
    const chips = CONFIG_CHIPS
      .filter((c) => c.id === 'all' || counts.get(c.id))
      .map((c) => ({ ...c, n: c.id === 'all' ? conf.problems.length : counts.get(c.id) }));
    const active = chips.some((c) => c.id === state.confChip) ? state.confChip : 'all';

    const rows = conf.problems
      .filter((p) => active === 'all' || p.type === active)
      .map((p) => configItemHtml(p, state.open.has(p.key)));

    return sectionHtml(
      'Broken configuration',
      rows.length + (rows.length === 1 ? ' item' : ' items'),
      (chips.length > 2 ? chipsHtml(chips, active, 'confchip') : '') +
      '<div class="probs">' + rows.join('') + '</div>',
      'sec-config'
    );
  }

  function clustersSection(model) {
    if (!model.clusters.length) return '';
    const items = model.clusters.map((c) =>
      '<div class="cluster' + (c.scope === 'global' ? ' is-global' : '') + '">' +
      '<ha-icon icon="' + (c.scope === 'global' ? 'mdi:home-alert-outline' : 'mdi:hub-outline') + '"></ha-icon>' +
      '<span class="ctext"><span class="ctitle">' + esc(c.title) + '</span>' +
      '<span class="csub">' + esc(c.detail) + '</span></span></div>'
    ).join('');
    return sectionHtml('Probable shared cause', '', '<div class="clusters">' + items + '</div>', 'sec-clusters');
  }

  const TRANSPORT_LABEL = { zigbee: 'Zigbee', ip: 'Wi-Fi / IP', cloud: 'Cloud' };

  /**
   * Filter chips are built from what is actually on the page: a transport or
   * severity chip only exists when at least one current problem matches it, so
   * an install with no cloud integrations never sees a Cloud chip.
   */
  function buildChips(model) {
    /* The count on a chip is how many rows it puts on screen, so All counts
       the problems it shows and not the batteries, which have their own chip
       and their own section. */
    const chips = [{ id: 'all', label: 'All', n: model.problems.length }];
    const add = (id, label, n) => { if (n) chips.push({ id, label, n }); };
    add('offline', 'Offline', model.problems.filter((p) => p.issue.id === 'offline' || p.issue.id === 'disconnected').length);
    add('degraded', 'Degraded', model.problems.filter((p) => p.issue.id === 'degraded').length);
    add('unknown', 'Unknown', model.problems.filter((p) => p.issue.id === 'unknown').length);
    add('battery', 'Battery', model.lowBatteries.length);
    for (const t of ['zigbee', 'ip', 'cloud']) {
      add('t:' + t, TRANSPORT_LABEL[t], model.problems.filter((p) => p.transport === t).length);
    }
    return chips;
  }

  /* `attr` lets the device list and the configuration list own separate chip
     state without either one's clicks reaching the other's handler. */
  function chipsHtml(chips, active, attr) {
    const name = attr || 'chip';
    return '<div class="chips">' + chips.map((c) =>
      '<button class="chip' + (c.id === active ? ' is-on' : '') + '" data-' + name + '="' + esc(c.id) + '" type="button">' +
      esc(c.label) + '<span class="chipn">' + c.n + '</span></button>'
    ).join('') + '</div>';
  }

  function matchesChip(p, chip) {
    if (chip === 'all') return true;
    if (chip === 'offline') return p.issue.id === 'offline' || p.issue.id === 'disconnected';
    if (chip === 'degraded') return p.issue.id === 'degraded';
    if (chip === 'unknown') return p.issue.id === 'unknown';
    if (chip === 'battery') return false;
    if (chip.indexOf('t:') === 0) return p.transport === chip.slice(2);
    return true;
  }

  /** The collapsed problem card: icon, name, status, duration, integration, entity count. */
  function problemHtml(p, expanded) {
    const meta = [esc(p.integration), p.issue.cause.length === 1 ? '1 entity' : p.issue.cause.length + ' entities'];
    if (p.subDevices) meta.push('+' + p.subDevices + ' sub-device' + (p.subDevices > 1 ? 's' : ''));
    if (p.area) meta.push(esc(p.area));

    return (
      '<div class="prob band-' + p.issue.band + (expanded ? ' is-open' : '') + '" data-key="' + esc(p.key) + '">' +
      '<button class="probhead" type="button" data-toggle="' + esc(p.key) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' +
      '<ha-icon class="picon" icon="' + esc(p.issue.icon) + '"></ha-icon>' +
      '<span class="ptext">' +
      '<span class="pname">' + esc(p.name) + '</span>' +
      '<span class="pmeta">' + meta.join(' &middot; ') + '</span></span>' +
      '<span class="pright"><span class="pstatus">' + esc(p.issue.label) + '</span>' +
      ageHtml(p.age, 'page') + '</span>' +
      '<ha-icon class="pchev" icon="mdi:chevron-down"></ha-icon>' +
      '</button>' +
      (expanded ? detailsHtml(p) : '') +
      '</div>'
    );
  }

  /* Expanded detail. Identifiers are kept to the ones that help when
     troubleshooting and are pushed to the bottom so they never dominate. */
  function detailsHtml(p) {
    const facts = [];
    const fact = (label, value) =>
      '<span class="dfact"><span class="dlabel">' + esc(label) + '</span><span class="dval">' + value + '</span></span>';
    facts.push(fact('Integration', esc(p.integration)));
    if (p.manufacturer) facts.push(fact('Manufacturer', esc(p.manufacturer)));
    if (p.model) facts.push(fact('Model', esc(p.model)));
    facts.push(fact('Area', esc(p.area || 'Unassigned')));
    if (p.hubName) facts.push(fact('Via', esc(p.hubName)));
    if (p.transport) facts.push(fact('Transport', esc(TRANSPORT_LABEL[p.transport])));
    facts.push(fact('Entities', p.issue.cause.length + ' affected of ' + p.runtime.length));
    if (p.since) facts.push(fact('Since', esc(new Date(p.since).toLocaleString())));

    const rows = p.issue.cause.slice().sort((a, b) => a.entityId.localeCompare(b.entityId)).map((e) => {
      const age = ageOf(e.lastChanged, Date.now());
      return (
        '<button class="ent" type="button" data-entity="' + esc(e.entityId) + '">' +
        '<span class="ename">' + esc(e.name) + '</span>' +
        '<span class="eid">' + esc(e.entityId) + '</span>' +
        '<span class="estate">' + esc(e.state) + '</span>' +
        ageHtml(age, 'eage') + '</button>'
      );
    }).join('');

    /* The device page, not an entity page: when a device is dead the next step
       is usually to reconfigure or delete it, and that only exists at the
       device level. The button sits beside the facts rather than under them so
       it stays reachable without scrolling past the entity list. */
    const deviceButton =
      '<button class="devbtn" type="button" data-device="' + esc(p.deviceId) + '" ' +
      'title="Open this device in Settings">' +
      '<ha-icon icon="mdi:cog-outline"></ha-icon><span>Device</span></button>';

    return (
      '<div class="details">' +
      '<div class="dtop"><div class="dfacts">' + facts.join('') + '</div>' + deviceButton + '</div>' +
      '<div class="ents">' + rows + '</div></div>'
    );
  }

  function attentionSection(model, state, cfg) {
    if (!model.problems.length && !model.lowBatteries.length) {
      return sectionHtml(
        'Needs attention', '',
        '<div class="allgood"><ha-icon icon="mdi:check-circle-outline"></ha-icon>' +
        '<span><strong>Everything looks good</strong>' +
        '<small>' + model.counts.population + ' devices are responding and no battery is at or under ' +
        cfg.battery_threshold + '%.</small></span></div>',
        'sec-attention'
      );
    }

    const chips = buildChips(model);
    const active = chips.some((c) => c.id === state.chip) ? state.chip : 'all';
    /* The battery chip swaps the list for the battery rows rather than mixing
       two kinds of card, so the standalone Low battery section steps aside. */
    const rows = active === 'battery'
      ? model.lowBatteries.map(batteryRowHtml)
      : model.problems.filter((p) => matchesChip(p, active)).map((p) => problemHtml(p, state.open.has(p.key)));

    const body =
      (chips.length > 2 ? chipsHtml(chips, active) : '') +
      (rows.length
        ? '<div class="probs">' + rows.join('') + '</div>'
        : '<div class="empty"><ha-icon icon="mdi:filter-off-outline"></ha-icon><span>Nothing matches this filter.</span></div>');

    return sectionHtml('Needs attention', rows.length + (rows.length === 1 ? ' device' : ' devices'), body, 'sec-attention');
  }

  function batteryRowHtml(b) {
    const charging = b.charging === true;
    const band = b.level === null ? 'unknown' : b.level <= 10 ? 'critical' : 'battery';
    return (
      '<button class="brow band-' + band + (charging ? ' is-charging' : '') + '" type="button" data-entity="' + esc(b.entityId) + '">' +
      '<ha-icon class="bicon" icon="' + esc(batteryIcon(b.level, charging)) + '"></ha-icon>' +
      '<span class="btext"><span class="bname">' + esc(b.name) + '</span>' +
      '<span class="bmeta">' + esc(b.integration) + (b.area ? ' &middot; ' + esc(b.area) : '') +
      (charging ? ' &middot; Charging' : '') + '</span></span>' +
      '<span class="bval">' + (b.level === null ? esc(b.state) : Math.round(b.level) + '%') +
      (charging ? '<ha-icon class="bolt" icon="mdi:flash"></ha-icon>' : '') + '</span></button>'
    );
  }

  function batterySection(model, cfg) {
    if (!model.lowBatteries.length) return '';
    return sectionHtml(
      'Low battery',
      'at or under ' + cfg.battery_threshold + '%',
      '<div class="probs">' + model.lowBatteries.map(batteryRowHtml).join('') + '</div>',
      'sec-battery'
    );
  }

  function recoveredSection(model, cfg) {
    if (!model.recovered || !model.recovered.length) return '';
    const rows = model.recovered.map((r) =>
      '<div class="rec"><ha-icon icon="mdi:check-circle-outline"></ha-icon>' +
      '<span class="rectext"><span class="recname">' + esc(r.name) + '</span>' +
      '<span class="recmeta">' + esc(r.integration || '') + '</span></span>' +
      /* The age is wrapped so the 30s tick ages it in place, like every other
         duration on the page; without it the row would sit at "0s" until the
         next full rebuild. */
      '<span class="recage">back ' + ageHtml(model._now - r.at, 'recage-n') + ' ago</span></div>'
    ).join('');
    return sectionHtml('Recently recovered', 'last ' + Math.round(cfg.recovery_minutes / 60) + 'h', '<div class="recs">' + rows + '</div>', 'sec-recovered');
  }

  /**
   * Devices that left the problem list because they were removed from the
   * registry. Deliberately neutral in tone and colour: deleting a dead device
   * is a deliberate act, so this is a record of it rather than good or bad
   * news. Not rendered at all when nothing has been deleted.
   */
  function deletedSection(model, cfg) {
    if (!model.deleted || !model.deleted.length) return '';
    const rows = model.deleted.map((r) =>
      '<div class="rec is-deleted"><ha-icon icon="mdi:trash-can-outline"></ha-icon>' +
      '<span class="rectext"><span class="recname">' + esc(r.name) + '</span>' +
      '<span class="recmeta">' + esc(r.integration || '') + (r.label ? ' &middot; was ' + esc(r.label.toLowerCase()) : '') + '</span></span>' +
      '<span class="recage">removed ' + ageHtml(model._now - r.at, 'recage-n') + ' ago</span></div>'
    ).join('');
    return sectionHtml(
      'Recently deleted',
      'last ' + Math.round(cfg.recovery_minutes / 60) + 'h',
      '<div class="recs">' + rows + '</div>',
      'sec-deleted'
    );
  }

  function integrationsSection(model) {
    if (!model.integrations.length) return '';
    const items = model.integrations.map((i) =>
      '<div class="integ' + (i.problems ? (i.worst >= 3 ? ' band-critical is-bad' : ' band-warn is-bad') : ' band-ok') + '">' +
      '<span class="iname">' + esc(i.name) + '</span>' +
      '<span class="icount">' + i.devices + (i.devices === 1 ? ' device' : ' devices') + '</span>' +
      '<span class="ival">' + (i.problems ? i.problems + (i.problems === 1 ? ' problem' : ' problems') : '<ha-icon icon="mdi:check"></ha-icon>') + '</span></div>'
    ).join('');
    const bad = model.integrations.filter((i) => i.problems).length;
    return sectionHtml('Integrations', bad ? bad + ' with problems' : 'all healthy', '<div class="integs">' + items + '</div>', 'sec-integrations');
  }

  function orphansSection(model, state) {
    if (!model.orphans.length) return '';
    const total = model.orphans.reduce((n, g) => n + g.entities.length, 0);
    const rows = model.orphans.map((g) => {
      const open = state.open.has('orphan:' + g.platform);
      /* Already-escaped markup, so this line is not run through esc() again. */
      const bits = [];
      if (g.unavailable) bits.push(g.unavailable + ' unavailable');
      if (g.unknown) bits.push(g.unknown + ' unknown');
      return (
        '<div class="prob band-unknown' + (open ? ' is-open' : '') + '">' +
        '<button class="probhead" type="button" data-toggle="orphan:' + esc(g.platform) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        '<ha-icon class="picon" icon="mdi:link-variant-off"></ha-icon>' +
        '<span class="ptext"><span class="pname">' + esc(g.name) + '</span>' +
        '<span class="pmeta">' + bits.join(' &middot; ') + '</span></span>' +
        '<span class="pright"><span class="pstatus">' + g.entities.length + '</span>' + ageHtml(g.age, 'page') + '</span>' +
        '<ha-icon class="pchev" icon="mdi:chevron-down"></ha-icon></button>' +
        (open
          ? '<div class="details"><div class="ents">' + g.entities.map((e) =>
              '<button class="ent" type="button" data-entity="' + esc(e.entityId) + '">' +
              '<span class="ename">' + esc(e.name) + '</span>' +
              '<span class="eid">' + esc(e.entityId) + '</span>' +
              '<span class="estate">' + esc(e.state) + '</span>' +
              ageHtml(ageOf(e.lastChanged, Date.now()), 'eage') + '</button>').join('') +
            '</div></div>'
          : '') +
        '</div>'
      );
    }).join('');
    return sectionHtml(
      'Entity-only problems',
      total + ' entities, no device',
      '<div class="orphnote">Helpers, templates and YAML entities that belong to no device in the registry. They are listed for completeness and are not counted as devices above.</div>' +
      '<div class="probs">' + rows + '</div>',
      'sec-orphans'
    );
  }

  /* ================================================================== *
   * STYLES
   *
   * Two named containers: dhcard drives the section layouts off the width the
   * card is given, dhpill lets a summary pill scale its own contents. Naming
   * them is required - an unnamed query inside a pill would bind to the pill
   * instead of to the card.
   * ================================================================== */

  const STYLES = `
:host { display: block; container: dhcard / inline-size; }
* { box-sizing: border-box; }

.wrap { display: flex; flex-direction: column; gap: 12px; }

ha-card.sec { padding: 10px 12px 12px; overflow: hidden; }
/* The head wraps rather than clipping: the configuration summary's subtitle is
   a coverage claim several times longer than "last 2h", and at 304px it does
   not fit beside the title. */
.sechead { display: flex; align-items: baseline; gap: 2px 8px; margin: 0 0 8px; flex-wrap: wrap; }
.sectitle {
  font-size: 0.95rem; font-weight: 600; letter-spacing: 0.02em;
  color: var(--primary-text-color); text-transform: uppercase;
}
.secsub {
  font-size: 0.75rem; color: var(--secondary-text-color); margin-left: auto;
  min-width: 0; text-align: right; overflow-wrap: anywhere;
}

/* ---- colour bands. Healthy is deliberately neutral, and nothing is a full
   saturated fill: this is a status page, not an alarm panel. ---- */
.band-critical { --dh-accent: var(--error-color, #db4437); }
.band-warn     { --dh-accent: #e8710a; }
.band-unknown  { --dh-accent: var(--warning-color, #ffa600); }
.band-battery  { --dh-accent: #e8710a; }
.band-ok       { --dh-accent: var(--secondary-text-color); }

/* ---- summary ---- */
.pills { display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 6px; max-width: 1040px; }
.pill {
  container: dhpill / inline-size;
  display: grid; grid-template-columns: auto minmax(0, 1fr);
  align-items: center; gap: 0 5px; padding: 8px 7px; border-radius: 12px;
  background: color-mix(in srgb, var(--dh-accent) 12%, transparent);
  border: 1px solid var(--divider-color);
  border-color: color-mix(in srgb, var(--dh-accent) 30%, transparent);
  min-width: 0;
}
.pill.is-zero { background: none; border-color: var(--divider-color); }
.pill.is-zero .pnum { color: var(--secondary-text-color); }
.pill.is-zero ha-icon { color: var(--disabled-text-color, #8a8a8a); }
.pill ha-icon { grid-column: 1; grid-row: 1 / span 2; color: var(--dh-accent); --mdc-icon-size: 22px; }
.pnum { grid-column: 2; grid-row: 1; font-size: 1.35rem; font-weight: 700; line-height: 1.05; color: var(--dh-accent); }
.plabel { grid-column: 2; grid-row: 2; font-size: 0.72rem; font-weight: 600;
  color: var(--primary-text-color); line-height: 1.1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pnote { display: none; grid-column: 1 / -1; grid-row: 3; }
/* The configuration labels are single long words - "Automations",
   "Dashboards" - which no amount of wrapping will fit into an 84px pill, and
   breaking them mid-word reads worse than the ellipsis did. So this row gets a
   wider minimum and lays out fewer pills per line instead. */
.pills-config { grid-template-columns: repeat(auto-fit, minmax(108px, 1fr)); }
.pill-wrap .plabel { white-space: normal; overflow: visible; line-height: 1.05; }

/* ---- compact tiles ----
   One pill filling one small card: the same component the summary rows above
   are built from, and the same shape and size as the battery mini tiles these
   sit beside on the main dashboard. The pill already carries the colour band,
   the icon, the count and the label, so a tile is that and nothing else. */
ha-card.mini { overflow: hidden; }
ha-card.mini .pill {
  width: 100%; border: 0; border-radius: var(--ha-card-border-radius, 12px);
  font: inherit; text-align: left; cursor: pointer;
  /* The pill fills the card here rather than sitting inside a summary strip,
     so the icon would otherwise start hard against the card's own edge. */
  padding: 8px 7px 8px 12px;
}
ha-card.mini .pill:hover { background: color-mix(in srgb, var(--dh-accent) 20%, transparent); }
/* The detail row is always on for a mini tile - it is the tile's only prose -
   and only steps aside when the track is too narrow to hold a word of it. */
ha-card.mini .pnote {
  display: block; font-size: 0.62rem; color: var(--secondary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@container dhpill (max-width: 110px) { ha-card.mini .pnote { display: none; } }

/* ---- house health ----
   One row that must survive 304px, so the stat chips wrap under the verdict
   rather than squeezing it. */
.house {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px;
  align-items: center; padding: 10px 12px; border-radius: 12px;
  background: color-mix(in srgb, var(--dh-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dh-accent) 28%, transparent);
}
.hicon { --mdc-icon-size: 30px; color: var(--dh-accent); grid-row: 1 / span 1; }
.htext { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.hword { font-size: 1.05rem; font-weight: 700; line-height: 1.15; color: var(--primary-text-color); }
.hsub { font-size: 0.76rem; color: var(--secondary-text-color); line-height: 1.25; }
.hstats { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 5px; margin-top: 2px; }
.hstat {
  display: inline-flex; align-items: baseline; gap: 4px;
  font-size: 0.7rem; font-weight: 600; color: var(--secondary-text-color);
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--dh-accent) 34%, transparent);
  background: color-mix(in srgb, var(--dh-accent) 9%, transparent);
}
.hstat b { font-size: 0.82rem; color: var(--dh-accent); font-variant-numeric: tabular-nums; }
@container dhcard (min-width: 520px) {
  .house { grid-template-columns: auto minmax(0, 1fr) auto; }
  .hstats { grid-column: 3; grid-row: 1; margin-top: 0; justify-content: flex-end; }
}

/* ---- configuration health ---- */
.scanning, .empty, .allgood { display: flex; align-items: center; gap: 8px; }
.scanning { font-size: 0.8rem; color: var(--secondary-text-color); padding: 4px 0; }
.scanning ha-icon { --mdc-icon-size: 20px; animation: dhspin 1.6s linear infinite; }
@keyframes dhspin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .scanning ha-icon { animation: none; } }

.confnote {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 8px; font-size: 0.71rem; color: var(--secondary-text-color); line-height: 1.35;
}
.confnote > span { min-width: 0; flex: 1 1 140px; }
.rescan {
  display: inline-flex; align-items: center; gap: 4px; margin-left: auto;
  font: inherit; font-size: 0.71rem; font-weight: 600; cursor: pointer;
  padding: 3px 10px; border-radius: 999px; white-space: nowrap;
  color: var(--secondary-text-color);
  background: none; border: 1px solid var(--divider-color);
}
.rescan:hover { color: var(--primary-text-color); }
.rescan ha-icon { --mdc-icon-size: 14px; }

/* ---- broken configuration ---- */
.cdot { font-size: 0.85rem; line-height: 1; text-align: center; }
.pissue {
  font-size: 0.78rem; color: var(--primary-text-color); line-height: 1.3;
  overflow-wrap: anywhere;
}
.ploc { font-size: 0.7rem; color: var(--secondary-text-color); line-height: 1.25; }
.issues { display: grid; gap: 5px; }
.issue {
  display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px;
  padding: 6px 8px; border-radius: 8px;
  background: color-mix(in srgb, var(--dh-accent) 6%, transparent);
}
.issue.is-unvalidated { background: none; border: 1px dashed var(--divider-color); }
.idot { font-size: 0.7rem; line-height: 1.5; }
.itext { min-width: 0; display: flex; flex-direction: column; }
.imsg { font-size: 0.76rem; color: var(--primary-text-color); overflow-wrap: anywhere; }
.iloc { font-size: 0.69rem; color: var(--secondary-text-color); }
.ihint { font-size: 0.69rem; color: var(--primary-color, #03a9f4); overflow-wrap: anywhere; }
.dmeta {
  display: flex; flex-wrap: wrap; gap: 4px 10px; margin-bottom: 6px;
  font-size: 0.7rem; color: var(--secondary-text-color);
}
.dmeta .mono { font-family: var(--code-font-family, monospace); overflow-wrap: anywhere; }
/* Several views can be affected at once, so the links wrap rather than forcing
   the panel wider than the card. */
.dlinks { display: flex; flex-wrap: wrap; gap: 6px; }

/* ---- probable shared cause ---- */
.clusters { display: grid; gap: 6px; }
.cluster {
  display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 8px;
  padding: 8px 10px; border-radius: 10px;
  background: color-mix(in srgb, var(--warning-color, #ffa600) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning-color, #ffa600) 32%, transparent);
}
.cluster.is-global {
  background: color-mix(in srgb, var(--primary-color, #03a9f4) 10%, transparent);
  border-color: color-mix(in srgb, var(--primary-color, #03a9f4) 32%, transparent);
}
.cluster ha-icon { --mdc-icon-size: 22px; color: var(--warning-color, #ffa600); }
.cluster.is-global ha-icon { color: var(--primary-color, #03a9f4); }
.ctext { min-width: 0; display: flex; flex-direction: column; }
.ctitle { font-size: 0.85rem; font-weight: 700; color: var(--primary-text-color); }
.csub { font-size: 0.73rem; color: var(--secondary-text-color); }

/* ---- filter chips ---- */
.chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 9px; border-radius: 999px; cursor: pointer;
  font: inherit; font-size: 0.72rem; font-weight: 600;
  color: var(--secondary-text-color);
  background: none; border: 1px solid var(--divider-color);
}
.chip:hover { color: var(--primary-text-color); }
.chip.is-on {
  color: var(--primary-text-color);
  background: color-mix(in srgb, var(--primary-color, #03a9f4) 16%, transparent);
  border-color: color-mix(in srgb, var(--primary-color, #03a9f4) 40%, transparent);
}
.chipn { font-size: 0.66rem; font-weight: 700; opacity: 0.75; font-variant-numeric: tabular-nums; }

/* ---- problem cards ---- */
.probs { display: grid; grid-template-columns: 1fr; gap: 6px; align-items: start; }
.prob {
  border-radius: 10px; min-width: 0; break-inside: avoid;
  background: color-mix(in srgb, var(--dh-accent) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--dh-accent) 26%, transparent);
}
.prob.is-open { background: color-mix(in srgb, var(--dh-accent) 10%, transparent); }
.probhead {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto 18px;
  align-items: center; gap: 8px; width: 100%;
  padding: 8px 9px; border: 0; background: none; border-radius: 10px;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
}
.picon { color: var(--dh-accent); --mdc-icon-size: 22px; }
.ptext { min-width: 0; display: flex; flex-direction: column; }
.pname { font-size: 0.86rem; font-weight: 600; line-height: 1.25; color: var(--primary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pmeta { font-size: 0.7rem; line-height: 1.2; color: var(--secondary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pright { display: flex; flex-direction: column; align-items: flex-end; min-width: 0; }
.pstatus { font-size: 0.78rem; font-weight: 700; color: var(--dh-accent); white-space: nowrap; }
.page { font-size: 0.7rem; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; white-space: nowrap; }
.pchev { --mdc-icon-size: 18px; color: var(--secondary-text-color); transition: transform 0.15s ease; }
.prob.is-open .pchev { transform: rotate(180deg); }

/* ---- expanded detail ---- */
.details { padding: 0 9px 9px; display: grid; gap: 8px; }
.dtop { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.dfacts { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 4px 12px; }
.devbtn {
  display: inline-flex; align-items: center; gap: 4px; align-self: start;
  padding: 4px 9px; border-radius: 999px; cursor: pointer; white-space: nowrap;
  font: inherit; font-size: 0.72rem; font-weight: 600;
  color: var(--primary-text-color);
  background: color-mix(in srgb, var(--dh-accent) 14%, transparent);
  border: 1px solid color-mix(in srgb, var(--dh-accent) 38%, transparent);
}
.devbtn:hover { border-color: var(--dh-accent); background: color-mix(in srgb, var(--dh-accent) 24%, transparent); }
.devbtn ha-icon { --mdc-icon-size: 15px; color: var(--dh-accent); }
.dfact { display: flex; flex-direction: column; min-width: 0; }
.dlabel { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--secondary-text-color); }
.dval { font-size: 0.76rem; color: var(--primary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ents { display: grid; gap: 1px; }
.ent {
  display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
  grid-template-areas: "name state age" "id state age";
  align-items: center; gap: 0 8px; width: 100%;
  padding: 4px 6px; border: 0; border-radius: 6px; background: none;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  border-top: 1px solid var(--divider-color);
}
.ent:hover { background: color-mix(in srgb, var(--dh-accent) 12%, transparent); }
.ename { grid-area: name; font-size: 0.75rem; color: var(--primary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.eid { grid-area: id; font-size: 0.64rem; color: var(--secondary-text-color); font-family: ui-monospace, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.estate { grid-area: state; font-size: 0.68rem; font-weight: 600; color: var(--dh-accent); white-space: nowrap; }
.eage { grid-area: age; font-size: 0.66rem; color: var(--secondary-text-color);
  font-variant-numeric: tabular-nums; white-space: nowrap; min-width: 42px; text-align: right; }

/* ---- battery rows ---- */
.brow {
  display: grid; grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: center; gap: 8px; width: 100%;
  padding: 8px 9px; border-radius: 10px; break-inside: avoid;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  background: color-mix(in srgb, var(--dh-accent) 7%, transparent);
  border: 1px solid color-mix(in srgb, var(--dh-accent) 26%, transparent);
}
.brow:hover { border-color: var(--dh-accent); }
.bicon { color: var(--dh-accent); --mdc-icon-size: 22px; }
.brow.is-charging .bicon { color: var(--success-color, #43a047); }
.btext { min-width: 0; display: flex; flex-direction: column; }
.bname { font-size: 0.86rem; font-weight: 600; color: var(--primary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bmeta { font-size: 0.7rem; color: var(--secondary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bval { display: flex; align-items: center; gap: 2px; white-space: nowrap;
  font-size: 0.95rem; font-weight: 700; color: var(--dh-accent); font-variant-numeric: tabular-nums; }
.bolt { --mdc-icon-size: 14px; color: var(--success-color, #43a047); }

/* ---- recovered ---- */
.recs { display: grid; grid-template-columns: 1fr; gap: 2px; }
.rec { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 8px;
  padding: 5px 4px; border-bottom: 1px solid var(--divider-color); }
.recs .rec:last-child { border-bottom: 0; }
.rec ha-icon { --mdc-icon-size: 18px; color: var(--success-color, #43a047); }
.rectext { min-width: 0; display: flex; flex-direction: column; }
.recname { font-size: 0.82rem; color: var(--primary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recmeta { font-size: 0.68rem; color: var(--secondary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recage { font-size: 0.72rem; color: var(--success-color, #43a047); white-space: nowrap; font-weight: 600; }
.recage-n { font-variant-numeric: tabular-nums; }
/* Deletion is neither a failure nor a recovery, so it borrows neither colour. */
.rec.is-deleted ha-icon { color: var(--secondary-text-color); }
.rec.is-deleted .recname { color: var(--secondary-text-color); }
.rec.is-deleted .recage { color: var(--secondary-text-color); font-weight: 500; }

/* ---- integrations ---- */
/* The integration name gets the tile's full width on its own row: squeezing it
   next to "8 problems" ellipsised the longer official names, which are exactly
   the ones a reader needs to recognise. */
.integs { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 5px; }
.integ {
  display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline; gap: 0 8px; padding: 6px 9px; border-radius: 10px; min-width: 0;
  border: 1px solid var(--divider-color);
}
.integ.is-bad {
  background: color-mix(in srgb, var(--dh-accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--dh-accent) 30%, transparent);
}
.iname { grid-column: 1 / -1; grid-row: 1; font-size: 0.78rem; font-weight: 600; color: var(--primary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.icount { grid-column: 1; grid-row: 2; font-size: 0.66rem; color: var(--secondary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ival { grid-column: 2; grid-row: 2; font-size: 0.7rem; font-weight: 700; color: var(--dh-accent); white-space: nowrap; }
.integ.band-ok .ival { color: var(--success-color, #43a047); display: inline-flex; }
.integ.band-ok .ival ha-icon { --mdc-icon-size: 15px; }

/* ---- orphans ---- */
.orphnote { font-size: 0.7rem; color: var(--secondary-text-color); margin: 0 0 8px; line-height: 1.35; }

/* ---- empty / healthy ---- */
.allgood { display: flex; align-items: center; gap: 10px; padding: 6px 2px; }
.allgood ha-icon { --mdc-icon-size: 30px; color: var(--success-color, #43a047); flex: 0 0 auto; }
.allgood span { display: flex; flex-direction: column; min-width: 0; }
.allgood strong { font-size: 0.9rem; color: var(--primary-text-color); }
.allgood small { font-size: 0.73rem; color: var(--secondary-text-color); }
.empty { display: flex; align-items: center; gap: 8px; padding: 6px 2px;
  color: var(--secondary-text-color); font-size: 0.82rem; }
.empty ha-icon { --mdc-icon-size: 20px; }

/* ------------------------------------------------------------------ *
 * Responsive behaviour. Every breakpoint is a container query on the
 * card, so the layout follows the column it sits in, not the viewport.
 * ------------------------------------------------------------------ */
/* A pill narrower than its own label is the only thing that clips on this
   page: "Low battery" is a long label in a track that can be 84px wide. Give
   the icon and the type back a few pixels rather than dropping a column. */
@container dhpill (max-width: 128px) {
  .pill ha-icon { --mdc-icon-size: 18px; }
  .pnum { font-size: 1.2rem; }
  .plabel { font-size: 0.68rem; }
}
@container dhpill (max-width: 100px) {
  .pill ha-icon { --mdc-icon-size: 16px; }
  .pnum { font-size: 1.1rem; }
  .plabel { font-size: 0.62rem; }
  .pnote { font-size: 0.57rem; }
}
@container dhcard (max-width: 330px) {
  /* Two lines instead of a squeezed third column. */
  .probhead { grid-template-columns: 24px minmax(0, 1fr) 18px; }
  .pright { grid-column: 2 / 4; grid-row: 2; flex-direction: row; align-items: baseline;
    justify-content: flex-start; gap: 6px; }
  .picon { grid-row: 1 / span 2; }
  .pchev { grid-row: 1 / span 2; }
  .ent { grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas: "name state" "id age"; }
  .eage { text-align: left; }
}
@container dhcard (min-width: 340px) {
  .pnote { display: block; font-size: 0.62rem; color: var(--secondary-text-color);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
@container dhcard (min-width: 420px) {
  ha-card.sec { padding: 12px 14px 14px; }
}
@container dhcard (min-width: 640px) {
  .probs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .recs { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; }
}
@container dhcard (min-width: 1000px) {
  .probs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .recs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@container dhcard (min-width: 1360px) {
  .probs { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
`;

  /* ================================================================== *
   * THE CARD
   * ================================================================== */

  /* Manifests give integrations their real names and their cloud/local
     classification. One websocket call, shared by every instance and every
     render for the life of the page. */
  /**
   * The configuration scan, shared by every card instance on the page and kept
   * for the life of it. Rescanned only when the user asks or when the set of
   * automations, scripts or scenes changes - editing an automation's contents
   * cannot be seen from here, which is what the Rescan button is for.
   */
  let configCache = { sig: null, promise: null, model: null };

  /**
   * Events that mean "something the inspector reads has been rewritten".
   * `lovelace_updated` fires when any dashboard is saved; `automation_reloaded`
   * fires when automations are reloaded, which is what saving one does.
   */
  const CONFIG_EVENTS = ['lovelace_updated', 'automation_reloaded'];

  /** How long after a scan a forced rescan is treated as the same request. */
  const FORCE_COALESCE_MS = 1500;

  function configSignature(hass) {
    let sig = '';
    for (const id in hass.states) {
      if (id.startsWith('automation.') || id.startsWith('script.') || id.startsWith('scene.')) sig += id + ',';
    }
    return sig;
  }

  function getConfigModel(hass, cfg, force) {
    const sig = configSignature(hass);
    if (!force && configCache.promise && configCache.sig === sig) return configCache.promise;
    /* A forced rescan joins one that is already running, and also one that has
       only just finished. Two subscribers debounce independently, so the second
       can arrive a few milliseconds after the first scan completed - close
       enough that it is certainly the same edit, and far enough apart that an
       in-flight check alone would miss it and scan twice. */
    if (configCache.running) return configCache.promise;
    if (configCache.promise && configCache.finishedAt && Date.now() - configCache.finishedAt < FORCE_COALESCE_MS) {
      return configCache.promise;
    }
    const promise = scanConfiguration(hass, cfg)
      .then((m) => {
        m.ready = true;
        if (configCache.promise === promise) { configCache.model = m; configCache.running = false; configCache.finishedAt = Date.now(); }
        return m;
      })
      .catch((e) => {
        const m = { ready: false, error: (e && e.message) || String(e), counts: null, problems: [] };
        if (configCache.promise === promise) { configCache.model = m; configCache.running = false; configCache.finishedAt = Date.now(); }
        return m;
      });
    configCache = { sig, promise, model: null, running: true, finishedAt: 0 };
    return promise;
  }

  let manifestPromise = null;
  function loadManifests(hass) {
    if (manifestPromise) return manifestPromise;
    manifestPromise = hass
      .callWS({ type: 'manifest/list' })
      .then((list) => {
        const map = {};
        for (const m of list || []) map[m.domain] = m;
        return map;
      })
      .catch(() => ({}));
    return manifestPromise;
  }

  class DeviceHealthCard extends HTMLElement {
    static getStubConfig() {
      return { type: 'custom:device-health-card' };
    }

    /**
     * Keeps the element in the DOM while it is hiding itself, so it goes on
     * receiving `hass` and can come back when a device fails again. Read by
     * `hui-card._setElementVisibility()`; without it Home Assistant detaches a
     * hidden card and a tile that hid itself at zero could never return.
     */
    connectedWhileHidden = true;

    setConfig(config) {
      const c = config || {};
      const mode = c.mode || 'full';
      if (MODES.indexOf(mode) < 0) {
        throw new Error('device-health-card: unknown mode "' + mode + '". Use one of: ' + MODES.join(', '));
      }
      this._config = {
        mode,
        navigation_path: c.navigation_path || COMPACT_NAV,
        sections: c.sections || DEFAULT_SECTIONS,
        battery_threshold: c.battery_threshold === undefined ? DEFAULT_BATTERY_THRESHOLD : Number(c.battery_threshold),
        degraded_ratio: c.degraded_ratio === undefined ? DEFAULT_DEGRADED_RATIO : Number(c.degraded_ratio),
        recovery_minutes: c.recovery_minutes === undefined ? DEFAULT_RECOVERY_MINUTES : Number(c.recovery_minutes),
        ignored_domains: c.ignored_domains || DEFAULT_IGNORED_DOMAINS,
        exclude_integrations: c.exclude_integrations || DEFAULT_EXCLUDED_INTEGRATIONS,
        exclude: c.exclude || [],
        cluster: Object.assign({}, DEFAULT_CLUSTER, c.cluster || {}),
        manifests: {},
      };
      this._state = { chip: 'all', confChip: 'all', open: new Set() };
      this._signature = null;
      /* setConfig can arrive after connectedCallback, so registration happens
         in whichever runs second. */
      if (isCompact(mode) && this.isConnected) compactPeers.add(this);
      if (this._hass) this._update();
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (first) {
        loadManifests(hass).then((m) => {
          if (!this._config) return;
          this._config.manifests = m;
          this._signature = null;
          this._update();
        });
        /* Here rather than in connectedCallback: the connection only exists
           once hass has been handed over. */
        this._watchConfigEvents();
      }
      this._update();
    }

    connectedCallback() {
      /* Durations and the recovery window move on their own; a 30s tick keeps
         them honest without rebuilding anything. */
      this._timer = window.setInterval(() => this._tick(), 30000);
      if (this._config && isCompact(this._config.mode)) compactPeers.add(this);
    }

    disconnectedCallback() {
      if (this._timer) window.clearInterval(this._timer);
      this._timer = null;
      /* A tile that leaves the page must stop propping its peer up. */
      if (compactPeers.delete(this)) {
        this._compactHasProblem = false;
        for (const card of compactPeers) card._renderCompact(true);
      }
      window.clearTimeout(this._changeTimer);
      for (const un of this._unsubs || []) {
        try { un(); } catch (e) { /* the socket may already be gone */ }
      }
      this._unsubs = null;
    }

    /**
     * Editing a dashboard card, or the body of an automation, changes nothing
     * the state machine can see - so the scan signature cannot notice it and
     * the page would sit on a stale finding until a reload.
     *
     * Home Assistant broadcasts both edits on its event bus, which is the exact
     * signal, costs one subscription and needs no polling. An event that a
     * given Home Assistant version does not emit simply never fires, leaving
     * the Rescan button as the fallback it already was.
     */
    _watchConfigEvents() {
      /* The device tile never reads configuration, so it has no business
         waking up when a dashboard is saved - and a subscriber that only
         triggers a scan it will not use is exactly how two cards became two
         scans. */
      if (this._config.mode === 'device-compact') return;
      const conn = this._hass && this._hass.connection;
      if (!conn || typeof conn.subscribeEvents !== 'function' || this._unsubs) return;
      this._unsubs = [];
      for (const type of CONFIG_EVENTS) {
        Promise.resolve(conn.subscribeEvents(() => this._configChanged(), type))
          .then((un) => {
            /* The card may have been detached while the subscription was in
               flight, which would otherwise leak it. */
            if (this._unsubs) this._unsubs.push(un);
            else un();
          })
          .catch(() => { /* unknown event type on this version: stay quiet */ });
      }
    }

    /* One save can raise several events, so the rescan is debounced rather than
       run once per event. */
    _configChanged() {
      window.clearTimeout(this._changeTimer);
      this._changeTimer = window.setTimeout(() => {
        if (this._model) {
          this._model.config = null;
          this._render();
        }
        this._scanConfig(true);
      }, 700);
    }

    /* Sections views: 'auto' rows or the card gets clipped. */
    /* Sections views: 'auto' rows or the card gets clipped. The compact tiles
       ask for half a row so two of them sit side by side in a 12-column
       section, and drop to a whole row of their own when the section narrows -
       the same shape the battery tiles on that dashboard already use. */
    getGridOptions() {
      if (isCompact(this._config.mode)) {
        return { rows: 'auto', columns: 6, min_columns: 3, min_rows: 1 };
      }
      return { rows: 'auto', columns: 'full', min_columns: 6 };
    }

    getCardSize() {
      return isCompact(this._config.mode) ? 1 : 12;
    }

    /* ----------------------- update pipeline -----------------------
     *
     * `set hass` fires on every state change in the install, so the guard has
     * to be cheaper than the work it protects. The signature is a single pass
     * over the state machine that only records the entities that could change
     * what is on screen - the ones that are unavailable or unknown, plus
     * battery levels - so a light turning on costs one loop and no rebuild.
     */
    _update() {
      if (!this._hass || !this._config) return;
      /* The configuration tile shows nothing that any state change can alter,
         so it opts out of the state-driven pipeline entirely and rebuilds only
         when the scan itself produces a new answer. */
      if (this._config.mode === 'configuration-compact') {
        if (!this._model) this._build();
        else this._scanConfig(false);
        return;
      }
      const sig = this._signatureOf(this._hass);
      if (sig === this._signature) return;
      this._signature = sig;
      this._build();
    }

    _signatureOf(hass) {
      const states = hass.states;
      let sig = '';
      let n = 0;
      for (const id in states) {
        n++;
        const st = states[id];
        const v = st.state;
        if (v === UNAVAILABLE || v === UNKNOWN) {
          sig += id + (v === UNAVAILABLE ? '!' : '?');
        } else if (OFFLINE_WORDS.has(v)) {
          sig += id + '#';
        } else if (st.attributes && st.attributes.device_class === 'battery') {
          sig += id + '=' + v + ';';
        } else if (st.attributes && st.attributes.device_class === 'connectivity') {
          sig += id + ':' + v + ';';
        }
      }
      /* Registry identity: a device added, renamed or moved replaces these
         objects and is the only other thing that can change the page. */
      this._regStamp = this._regStamp || {};
      const changed =
        this._regStamp.e !== hass.entities || this._regStamp.d !== hass.devices || this._regStamp.a !== hass.areas;
      if (changed) {
        this._regStamp = { e: hass.entities, d: hass.devices, a: hass.areas };
        this._regSeq = (this._regSeq || 0) + 1;
      }
      return n + '|' + this._regSeq + '|' + sig;
    }

    _build() {
      const now = Date.now();
      const mode = this._config.mode;

      /* The configuration tile has no use for the runtime model, and running
         the whole device analysis for it would be 15ms of wasted work on every
         state change in the install. */
      const model = mode === 'configuration-compact'
        ? { problems: [], lowBatteries: [], counts: {}, _now: now }
        : analyse(this._hass, this._config, now);
      model.batteryThreshold = this._config.battery_threshold;
      /* Recovery tracking is a side effect on shared storage, so it belongs to
         the modes that actually own a device model. The compact device tile
         doing it too is deliberate: it lives on a dashboard that is open all
         day, so it observes far more transitions than the Health page ever
         does, and the two agree because they compute the same set. */
      if (mode !== 'configuration-compact') trackRecoveries(model, this._config, now);
      model._now = now;
      /* Whatever the shared scan has produced so far; null means it is still
         running and the configuration sections say so. */
      model.config = configCache.model;
      this._model = model;
      this._render();
      /* The device tile never reads configuration, so it never triggers the
         scan - which is what keeps three cards from meaning three scans. */
      if (mode !== 'device-compact') this._scanConfig(false);
    }

    /**
     * The configuration scan is hundreds of round trips, so it never blocks the
     * device half of the page: the runtime model paints first and the
     * configuration sections fill in when the answer arrives.
     */
    _scanConfig(force) {
      if (!this._hass || !this._config) return;
      /* Compare the signature, not merely whether a result exists: after the
         first scan a cached model is always present, and testing only for that
         is what would leave a deleted automation on the page until a reload. */
      if (!force && configCache.model && configCache.sig === configSignature(this._hass)) return;
      if (this._scanning && !force) return;
      this._scanning = true;
      const run = () =>
        getConfigModel(this._hass, this._config, force).then((m) => {
          this._scanning = false;
          if (!this._model) return;
          this._model.config = m;
          this._render();
        });
      if (force) run();
      else window.setTimeout(run, 60);
    }

    /** Ages only: no model rebuild, no innerHTML churn on the whole page. */
    _tick() {
      if (!this._model) return;
      const now = Date.now();
      const root = this.shadowRoot;
      if (!root) return;
      for (const el of root.querySelectorAll('[data-age]')) {
        const base = el.dataset.age;
        if (base === '') continue;
        el.textContent = durationText(Number(base) + (now - this._model._now));
      }
      /* Expiring a recovery or deletion entry does need a rebuild, but only then. */
      const windowMs = this._config.recovery_minutes * 60000;
      const stale = (r) => now - r.at > windowMs;
      if (this._model.recovered.some(stale) || (this._model.deleted || []).some(stale)) {
        this._signature = null;
        this._update();
      }
    }

    _render() {
      if (isCompact(this._config.mode)) return this._renderCompact();
      const root = this._ensureRoot();
      const model = this._model;
      const cfg = this._config;
      const want = cfg.sections;
      const parts = [];
      for (const name of want) {
        if (name === 'house') parts.push(houseSection(model, cfg));
        else if (name === 'summary') parts.push(summarySection(model, cfg));
        else if (name === 'config_summary') parts.push(configSummarySection(model));
        else if (name === 'config') parts.push(configSection(model, this._state));
        else if (name === 'clusters') parts.push(clustersSection(model));
        else if (name === 'attention') parts.push(attentionSection(model, this._state, cfg));
        else if (name === 'battery') parts.push(this._state.chip === 'battery' ? '' : batterySection(model, cfg));
        else if (name === 'recovered') parts.push(recoveredSection(model, cfg));
        else if (name === 'deleted') parts.push(deletedSection(model, cfg));
        else if (name === 'integrations') parts.push(integrationsSection(model));
        else if (name === 'orphans') parts.push(orphansSection(model, this._state));
      }
      /* Rebuilding the page throws the reader back to the top, and the reason
         is not the swap itself.
         `ha-card` is a Lit element: the ones this markup creates exist the
         instant innerHTML is assigned, but their shadow roots - and therefore
         everything slotted into them - are not rendered until Lit's microtask
         runs. For that one layout pass the whole page is a stack of empty
         shells a few hundred pixels tall, the document has almost nothing to
         scroll, and the browser clamps the scroll offset to fit. Lit then
         renders, the height comes back, and the offset does not.
         So the height is held across the gap: the wrapper keeps its old height
         until the new content has really rendered, the document never shrinks,
         and there is nothing to clamp. The offset is restored as well, which
         costs nothing and covers any shrink this does not anticipate. */
      const wrap = root.querySelector('.wrap');
      const scroller = this._scroller();
      const top = scroller ? scroller.scrollTop : 0;
      const height = wrap.offsetHeight;

      if (height) wrap.style.minHeight = height + 'px';
      wrap.innerHTML = parts.join('');
      if (scroller && top && scroller.scrollTop !== top) scroller.scrollTop = top;

      /* A timeout rather than requestAnimationFrame: Lit's update is a
         microtask, so it has always finished by the time a macrotask runs, and
         rAF never fires at all in a browser tab that is not compositing. */
      window.clearTimeout(this._releaseTimer);
      this._releaseTimer = window.setTimeout(() => {
        wrap.style.minHeight = '';
      }, 0);
    }

    /**
     * A compact tile. The whole point is that it is not there when there is
     * nothing to say, so the empty case is a real disappearance rather than an
     * empty card: `hidden` on the card element is what
     * `hui-card._updateVisibility()` reads, and it collapses the entire grid
     * cell, gap included, so the surrounding dashboard closes the space. It is
     * re-read immediately after every `hass` assignment, so a tile goes from
     * absent to present in the same tick that a device fails.
     */
    _renderCompact(fromPeer) {
      const mode = this._config.mode;
      const problem = mode === 'device-compact'
        ? deviceCompact(this._model, this._config)
        : configCompact(this._model.config);

      /* Published before the peers are consulted, so they read the current
         answer rather than the previous one. */
      const changed = this._compactHasProblem !== !!problem;
      this._compactHasProblem = !!problem;

      const show = !!problem || peerHasProblem(this);
      this.hidden = !show && !this._inEditor();

      const view = problem || (show ? zeroCompact(mode, this._model) : null);
      if (view) view.nav = this._config.navigation_path;

      const root = this._ensureRoot();
      const wrap = root.querySelector('.wrap');
      /* No min-height dance here: a tile is one small ha-card, and pinning the
         height of something that is about to be hidden would defeat the point. */
      wrap.innerHTML = view ? compactHtml(view) : '';
      if (view) {
        const card = root.querySelector('ha-card');
        /* The detail the pill has no room for. Hover on a desktop, long-press
           on a tablet, and the full page on a tap. */
        if (card) card.title = view.count + ' ' + view.label.toLowerCase() + ' — ' + view.detail;
      }

      /* Only a change in this tile's own verdict can change a peer's decision,
         and a peer re-rendering never changes its own verdict - so this
         recurses exactly one level and cannot loop. */
      if (changed && !fromPeer) {
        for (const card of compactPeers) if (card !== this) card._renderCompact(true);
      }
    }

    /** Home Assistant sets both while the dashboard is being edited. */
    _inEditor() {
      return this.preview === true || this.editMode === true;
    }

    /**
     * The element that actually scrolls. The card sits several shadow roots
     * deep inside Home Assistant's view, and the scroller is one of its
     * ancestors rather than anything this card owns, so the composed tree is
     * walked outwards until something that can scroll turns up. Cached, and
     * re-resolved if it is ever detached.
     */
    _scroller() {
      if (this._scrollEl && this._scrollEl.isConnected) return this._scrollEl;
      let node = this;
      for (let i = 0; i < 40 && node; i++) {
        const parent = node.parentElement || (node.parentNode && node.parentNode.host) || null;
        if (!parent) break;
        node = parent;
        const style = window.getComputedStyle(node);
        const scrolls = /auto|scroll|overlay/.test(style.overflowY);
        if (scrolls && node.scrollHeight > node.clientHeight + 1) {
          this._scrollEl = node;
          return node;
        }
      }
      /* Home Assistant normally scrolls the document itself. */
      this._scrollEl = document.scrollingElement || document.documentElement;
      return this._scrollEl;
    }

    /**
     * Home Assistant's router listens on window for `location-changed`, so a
     * pushState followed by that event navigates within the app. A plain
     * anchor would work too, but it would drop the whole frontend and reload
     * it, which on a wall tablet takes seconds.
     */
    _navigate(path) {
      history.pushState(null, '', path);
      window.dispatchEvent(new CustomEvent('location-changed', { bubbles: true, composed: true }));
    }

    _ensureRoot() {
      if (this.shadowRoot && this._built) return this.shadowRoot;
      const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = STYLES;
      const wrap = document.createElement('div');
      wrap.className = 'wrap';
      root.replaceChildren(style, wrap);

      wrap.addEventListener('click', (ev) => {
        const device = ev.target.closest('[data-device]');
        if (device) {
          ev.stopPropagation();
          this._navigate('/config/devices/device/' + device.dataset.device);
          return;
        }
        const entity = ev.target.closest('[data-entity]');
        if (entity) {
          ev.stopPropagation();
          this.dispatchEvent(
            new CustomEvent('hass-more-info', {
              detail: { entityId: entity.dataset.entity },
              bubbles: true,
              composed: true,
            })
          );
          return;
        }
        const nav = ev.target.closest('[data-nav]');
        if (nav) {
          ev.stopPropagation();
          this._navigate(nav.dataset.nav);
          return;
        }
        const rescan = ev.target.closest('[data-rescan]');
        if (rescan) {
          this._model.config = null;
          this._render();
          this._scanConfig(true);
          return;
        }
        const chip = ev.target.closest('[data-chip]');
        if (chip) {
          this._state.chip = chip.dataset.chip;
          this._render();
          return;
        }
        const confChip = ev.target.closest('[data-confchip]');
        if (confChip) {
          this._state.confChip = confChip.dataset.confchip;
          this._render();
          return;
        }
        const toggle = ev.target.closest('[data-toggle]');
        if (toggle) {
          const key = toggle.dataset.toggle;
          if (this._state.open.has(key)) this._state.open.delete(key);
          else this._state.open.add(key);
          this._render();
        }
      });
      this._built = true;
      return root;
    }
  }

  if (!customElements.get('device-health-card')) {
    customElements.define('device-health-card', DeviceHealthCard);
  }

  /* Exposed so the project's test harness and the live-verification tooling
     exercise the same code that ships, rather than a copy of it. */
  window.DEVICE_HEALTH_INTERNALS = {
    analyse, trackRecoveries, findClusters, durationText, batteryIcon, ageOf,
    HEALTH_SIGNALS, SEVERITY,
    buildIndex, inspectConfiguration, walkRefs, judge, findingsOf,
    deviceCompact, configCompact,
    DEFAULTS: {
      ignored_domains: DEFAULT_IGNORED_DOMAINS,
      exclude_integrations: DEFAULT_EXCLUDED_INTEGRATIONS,
      battery_threshold: DEFAULT_BATTERY_THRESHOLD,
      degraded_ratio: DEFAULT_DEGRADED_RATIO,
      recovery_minutes: DEFAULT_RECOVERY_MINUTES,
      cluster: DEFAULT_CLUSTER,
      sections: DEFAULT_SECTIONS,
    },
  };

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'device-health-card',
    name: 'Health Card',
    description: 'House health: offline, unknown and degraded devices, low batteries, integration health, and a read-only inspector for broken automation, script, scene and dashboard references. Set `mode: device-compact` or `mode: configuration-compact` for an alert tile that hides itself when there is nothing wrong.',
    preview: false,
  });

  console.info(
    '%c DEVICE-HEALTH-CARD %c v' + CARD_VERSION + ' ',
    'color: #fff; background: #03a9f4; font-weight: 700;',
    'color: #03a9f4; background: #fff; font-weight: 700;'
  );
})();
