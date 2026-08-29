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
 * @version 2026.8.25.4
 * @license MIT
 */

(function () {
  'use strict';

  /* Bumped with every release. `tools/tests.js` refuses to pass unless this
     matches the newest CHANGELOG heading: a banner that lies about which
     build is loaded is worse than no banner, because a stale page and an
     up-to-date one then look identical. */
  const CARD_VERSION = '2026.8.29.3';
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
   * Ignored domains where `unavailable` is still a fault.
   *
   * The domains above are ignored because their IDLE state looks bad: a command
   * surface reads `unknown` when it has never been fired. But those same
   * entities do not go `unavailable` unless the hardware has actually left the
   * network, and that IS news.
   *
   * Without this, a device whose ONLY entities are command surfaces is
   * structurally invisible to this card. Every Broadlink IR blaster is exactly
   * that shape - `remote` + `infrared` + `radio_frequency`, nothing else - so an
   * RM4 pro can sit dead for hours while the page reports a clean bill of
   * health. That is not hypothetical: it is how this list came to exist.
   *
   * `media_player` is deliberately NOT here. A TV that has been switched off is
   * `unavailable` by design, which is the false positive the ignore list was
   * written to prevent in the first place. Same for `update`, whose placeholder
   * entities sit at `unavailable` permanently.
   *
   * Set `unavailable_is_fault_domains: []` to restore the old behaviour.
   */
  const DEFAULT_UNAVAILABLE_IS_FAULT = ['remote', 'infrared', 'radio_frequency', 'siren'];

  /**
   * Integrations whose devices are intermittent by design, so "not currently
   * reachable" is their normal condition rather than a fault. Bluetooth
   * beacons are the classic case: a key fob out of range is not a broken
   * device. Override with `exclude_integrations: []` to see them.
   */
  const DEFAULT_EXCLUDED_INTEGRATIONS = ['ibeacon'];

  /**
   * Skipping a device.
   *
   * Some devices are switched off on purpose - a desktop shut down when the
   * house is empty, a socket cut at the wall for the winter - and reporting
   * them as unreachable is noise rather than news.
   *
   * The list of skipped devices is kept as a **label on the device registry**
   * rather than in the card's own storage, for two reasons. It is
   * install-wide, so skipping a device at a desk also skips it on every wall
   * tablet, which per-user frontend storage would not; and it is visible and
   * removable in Settings, so the state is never trapped inside this card.
   */
  const DEFAULT_SKIP_LABEL = 'skip_health_checks';
  const SKIP_LABEL_NAME = 'Skip health checks';

  /** Battery percentage at or below which a device wants attention. */
  const DEFAULT_BATTERY_THRESHOLD = 18;

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
  const MODES = ['full', 'device-compact', 'configuration-compact', 'conflicts-compact', 'overall-compact'];
  const isCompact = (mode) => mode !== 'full';

  const DEFAULT_SECTIONS = [
    /* `system` sits above everything because an add-on that has crashed or a
       backup that stopped running outranks any single device, and it hides
       itself completely when there is nothing to say. `unstable` sits with
       the devices because it is the same devices, seen over a day. */
    'house', 'system', 'summary', 'config_summary', 'clusters', 'attention', 'unstable',
    'config', 'conflicts', 'battery', 'integrations', 'recovered', 'deleted', 'skipped',
    'orphans',
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
    const faultWhenGone = new Set(cfg.unavailable_is_fault_domains);
    const excludedIntegrations = new Set(cfg.exclude_integrations);
    const excludes = toRegex(cfg.exclude);
    /* Devices the user has told the card to leave alone, by label or by a
       static id in the card's own YAML. */
    const skippedIds = skippedDevices(hass, cfg);

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
        byDevice.set(deviceId, { runtime: [], bad: [], unsure: [], conn: [], explicit: [], cmd: [], platforms: new Set() });
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
      if (ignoredDomains.has(domain)) {
        /* Held aside, not counted yet. Pass 2 promotes these only when they are
           ALL unavailable and the device has nothing else to speak for it - see
           DEFAULT_UNAVAILABLE_IS_FAULT. Admitting only the unavailable ones here
           would make bad/runtime always 1.0 and call a half-registered device
           "offline" when a live sibling entity proves it is reachable. */
        if (faultWhenGone.has(domain)) bucket.cmd.push(row);
        continue;
      }

      bucket.runtime.push(row);
      if (isBad) bucket.bad.push(row);
      else if (isUnsure) bucket.unsure.push(row);
      if (isExplicit) bucket.explicit.push(row);
    }

    /* ---- pass 2: classify each device -------------------------------- */
    const population = [];
    const problems = [];
    const skipped = [];

    for (const [deviceId, bucket] of byDevice) {
      const device = devices[deviceId];
      if (!device || device.disabled_by) continue;
      /* A device whose only entities are command surfaces is invisible to the
         rules above, because those domains are ignored. That is the right call
         while it is merely idle, but not when the hardware has left: a Broadlink
         blaster is `remote` + `infrared` + `radio_frequency` and nothing else, so
         it could sit dead for hours behind a clean bill of health.
         Promote them only when EVERY one is unavailable. If any is still live the
         device is reachable and the dead siblings are a duplicate registration,
         which is a configuration matter rather than a health one. */
      if (!bucket.runtime.length && bucket.cmd.length &&
          bucket.cmd.every((r) => r.state === UNAVAILABLE)) {
        for (const row of bucket.cmd) { bucket.runtime.push(row); bucket.bad.push(row); }
      }

      /* A device with no runtime entities is a registry placeholder - an
         add-on, a frontend repository, a service shim - not a thing that can
         be online or offline. */
      if (!bucket.runtime.length) continue;

      const platform = pickPlatform(bucket.platforms, device, entities);
      if (excludedIntegrations.has(platform)) continue;

      /* A skipped device leaves the population entirely rather than being
         counted as healthy: calling a deliberately powered-off machine
         "online" would be as wrong as calling it offline. It is listed in its
         own section instead, so the decision stays visible. */
      if (skippedIds.has(deviceId)) {
        skipped.push({
          key: deviceId,
          deviceId,
          name: device.name_by_user || device.name || deviceId,
          area: (device.area_id && areas[device.area_id] && areas[device.area_id].name) || null,
          platform,
          integration: integrationName(platform, manifests),
          entities: bucket.runtime.length,
          /* What it would have been reported as, so the row can say whether
             the skip is currently hiding anything - the point of the list is
             to make a skip reviewable, not to hide the device twice over. */
          wouldBe: firstSignal(bucket, cfg),
        });
        continue;
      }

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
    const batteries = buildBatteries(batteryRows, devices, areas, states, entities, cfg, excludedIntegrations, manifests, skippedIds);
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
      counts, population, problems, integrations, clusters, batteries, lowBatteries, orphans, skipped,
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
   * Runs the same signals a live device would be put through, and reports the
   * first that matches. Used only to describe a skipped device: it answers
   * "what is this skip currently suppressing?" without letting the device back
   * into any counter.
   */
  function firstSignal(bucket, cfg) {
    for (const signal of HEALTH_SIGNALS) {
      const issue = signal.evaluate(bucket, cfg);
      if (issue) return { id: signal.id, label: signal.label, band: signal.band };
    }
    return null;
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
  function buildBatteries(rows, devices, areas, states, entities, cfg, excluded, manifests, skippedIds) {
    const out = new Map();
    for (const r of rows) {
      const device = r.deviceId ? devices[r.deviceId] : null;
      if (device && device.disabled_by) continue;
      /* Batteries are found from the sensor, not from the device loop, so a
         skipped device would otherwise still surface here. */
      if (skippedIds && r.deviceId && skippedIds.has(r.deviceId)) continue;
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
   * Keys whose value is prose, a URL or a literal event name. Home Assistant
   * never resolves any of them, so an entity id inside one is documentation,
   * not a reference - and the audit found a real example: an automation whose
   * `description` names a deleted sensor on purpose, to explain which sensor
   * NOT to use. A textual scanner reports that as a broken reference; this
   * list is what stops it.
   *
   * Deliberately short. A key only belongs here if Home Assistant can never
   * resolve a reference from it - `name` and `title` stay off the list because
   * a Lovelace card may template them, and that template is a real dependency.
   */
  const PROSE_KEYS = new Set([
    'description', 'example', 'documentation', 'url', 'note', 'comment',
    'event_type', 'logger', 'unique_id', 'webhook_id',
  ]);

  /**
   * Custom cards invent their own option names - `rain_sensor:`,
   * `power_entity:`, `battery:` - so a structural walk keyed on the documented
   * slots cannot see them. The audit found 36 such references on this install.
   *
   * Regex-scanning every string in a dashboard is how an inspector starts
   * inventing problems, so the rule is narrow on purpose:
   *
   *   - only inside containers we mark weak (dashboard cards, `variables:`)
   *   - the whole value must be exactly one entity id, nothing else
   *   - its domain must be one this installation actually has
   *   - the key must not be prose, and must not be one of the layout and
   *     styling names below that routinely hold dotted strings
   *
   * What survives is recorded as a dependency when it resolves - which is
   * safe, because "this card mentions an entity that exists" is a fact - and
   * reported as *unvalidated* when it does not. A guess never becomes a broken
   * or impaired counter.
   */
  const WEAK_SKIP_KEYS = new Set([
    'type', 'theme', 'icon', 'path', 'navigation_path', 'image', 'format',
    'unit', 'unit_of_measurement', 'state', 'value', 'template', 'style',
    'card_mod', 'view_layout', 'grid_options', 'layout', 'tap_action',
    'hold_action', 'double_tap_action', 'action', 'service', 'perform_action',
    'device_class', 'aspect_ratio', 'font_family', 'suffix', 'prefix',
  ]);

  /** One entity id and nothing else. */
  const WEAK_VALUE_RE = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

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
      /**
       * Is this the stem of an entity that exists?
       *
       * Custom cards routinely take a *prefix* and build the real id from it.
       * A button-card template doing
       * `entity: [[[ return variables.batt_sensor + '_battery' ]]]` turns
       * `batt_sensor: sensor.tab_hall` into `sensor.tab_hall_battery`, so the
       * value in the configuration is not an entity and never was. Flagging it
       * put one row per tablet on a real dashboard, all of them wrong.
       *
       * A deleted entity being a strict prefix of a living one is vanishingly
       * rare; a stem being one is the whole point of a stem. That asymmetry is
       * what makes this safe.
       */
      isStemOf(id) {
        const prefix = id + '_';
        for (const key in states) if (key.startsWith(prefix)) return true;
        for (const key in display) if (key.startsWith(prefix)) return true;
        for (const key of registered) if (key.startsWith(prefix)) return true;
        return false;
      },
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

      /* Prose is not configuration. The whole branch goes, not just the
         immediate string, because a folded `description` arrives as one value
         but a `selector` under a documented field is a structure of its own. */
      if (PROSE_KEYS.has(key)) continue;

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

      /* Everything else is only interesting for the templates it may contain,
         for a weak custom-card reference, and for the structure underneath. */
      if (typeof value === 'string') {
        if (TEMPLATE_RE.test(value)) emitTemplate(value, path, emit);
        else if (o.weak) emitWeak(key, value, path, emit, o);
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

  /**
   * A string in a slot nobody documented, inside a container marked weak.
   *
   * See WEAK_SKIP_KEYS for why this is as narrow as it is. The emitted
   * reference carries `weak: true`, which judgeEntity reads: a weak reference
   * that resolves is a genuine dependency, and one that does not is reported
   * as unvalidated rather than broken. Guessing must never light a red counter.
   */
  function emitWeak(key, value, path, emit, o) {
    if (WEAK_SKIP_KEYS.has(key)) return;
    /* A key that is itself an entity id is a scene's state map or a
       card_mod selector, not an option name holding a reference. */
    if (WEAK_VALUE_RE.test(key)) return;
    const v = value.trim();
    if (!WEAK_VALUE_RE.test(v)) return;
    const domain = v.slice(0, v.indexOf('.'));
    /* Without a domain list there is nothing separating `binary_sensor.foo`
       from `graphite.dark`, so the rule simply does not run. */
    if (!o.domains || !o.domains.has(domain)) return;
    emit({ kind: 'entity', value: v, location: locationOf(path), dynamic: false, weak: true });
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

  /**
   * The verdict on a weak reference that did not resolve. Recorded so the
   * coverage is honest and the reader can see what the walk suspected, never
   * counted among the things that are actually wrong.
   */
  function weakUnvalidated(ref, value, why) {
    return {
      confidence: 'unvalidated', kind: 'entity', ref: value, location: ref.location,
      weak: true,
      message: why === 'disabled'
        ? 'Possible reference in a card option, and that entity is disabled: ' + value
        : 'Possible reference in a card option, and no such entity: ' + value,
    };
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
      if (ref.weak) return weakUnvalidated(ref, value, 'disabled');
      return {
        confidence: 'warning', kind: 'entity-disabled', ref: value, location: ref.location,
        message: 'Referenced ' + noun + ' is disabled: ' + value,
      };
    }
    /* A guess that turned out to point at nothing is a guess, not a break -
       and if it is the stem of an entity that does exist, it was never meant to
       be an entity id at all, so it is not even worth mentioning. */
    if (ref.weak) {
      if (index.isStemOf && index.isStemOf(value)) return null;
      return weakUnvalidated(ref, value, 'missing');
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

  /**
   * Collects, judges and de-duplicates the findings of one configuration item.
   *
   * It also records the entity references that *resolve*. A reference to an
   * entity that exists is not a finding, but it is a dependency: if that entity
   * later goes unavailable, this item stops working while remaining perfectly
   * valid. Collecting them here costs one lookup per reference on a scan that
   * is already looking every reference up, and it is what the whole impaired
   * join is built on. `deps` is attached to the item by the caller.
   */
  function findingsOf(walk, index, deps) {
    const raw = [];
    walk((ref) => raw.push(ref));
    const out = [];
    const seen = new Set();
    for (const ref of raw) {
      if (deps && ref.value && !ref.dynamic) noteDependency(ref, index, deps);
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

  /**
   * Records a reference that points at something real.
   *
   * `script.foo` arrives as a service reference but is an entity, and that is
   * the form the runtime join needs - the same normalisation judge() already
   * does for its own reasons.
   */
  function noteDependency(ref, index, deps) {
    let value = ref.value;
    if (ref.kind === 'service') {
      const dot = String(value).indexOf('.');
      if (dot < 0) return;
      const domain = value.slice(0, dot);
      const name = value.slice(dot + 1);
      if (domain !== 'script' || ['turn_on', 'turn_off', 'toggle', 'reload'].includes(name)) return;
    } else if (ref.kind !== 'entity') {
      return;
    }
    if (!ENTITY_ID_RE.test(value)) return;
    if (index.entity(value) !== 'exists') return;
    /* Keeping the locations, not just the id: "Condition #2" is the difference
       between a report and a lead. Capped because one dashboard can name the
       same sensor in thirty cards and the list stops being readable long
       before that. */
    let at = deps.get(value);
    if (!at) deps.set(value, (at = []));
    if (ref.location && at.length < 8 && at.indexOf(ref.location) < 0) at.push(ref.location);
  }

  /* Ordering, and the severity ladder the page reads from. `impaired` sits
     between the two: the configuration is structurally sound, but something it
     depends on is not answering, so it cannot do its job today. */
  const CONFIDENCE_ORDER = { verified: 0, impaired: 1, warning: 2, unvalidated: 3 };

  /* ---- ignore rules ----
   *
   * Findings the user has looked at and accepted. The rules live in
   * /config/config_health_ignores.json, written by the backend services and
   * republished on the scan entity, so the same answer holds on every wall
   * tablet and survives a restart - which browser storage would not, on an
   * install with thirteen accounts.
   *
   * An ignored finding is moved aside rather than deleted: it stops counting,
   * stops putting a card on the page, and stays readable under "Ignored" so a
   * rule can be taken back.
   */

  /** A glob over references. `*` and `?` only; everything else is a literal. */
  function globToRe(pattern) {
    let out = '^';
    for (const ch of String(pattern)) {
      if (ch === '*') out += '.*';
      else if (ch === '?') out += '.';
      else if ('.+^${}()|[]/'.indexOf(ch) >= 0) out += '[' + ch + ']';
      else if (ch === String.fromCharCode(92)) out += String.fromCharCode(92, 92);
      else out += ch;
    }
    return new RegExp(out + '$');
  }

  function compileIgnores(rules) {
    const out = [];
    for (const rule of rules || []) {
      if (!rule || !rule.scope || !rule.value) continue;
      const c = { id: rule.id || rule.scope + ':' + rule.value, rule };
      if (rule.scope === 'pattern') {
        try { c.re = globToRe(rule.value); } catch (e) { continue; }
      }
      out.push(c);
    }
    return out;
  }

  /** Does this rule cover this finding, on this item? */
  function ignoreMatches(c, issue, item, hass) {
    const rule = c.rule;
    const ref = issue.ref == null ? '' : String(issue.ref);
    switch (rule.scope) {
      case 'ref':
        return ref === rule.value;
      case 'pattern':
        return !!ref && c.re.test(ref);
      case 'item':
        return item.key === rule.value || item.entityId === rule.value ||
          item.urlPath === rule.value || item.id === rule.value;
      case 'kind':
        /* A kind rule may be install-wide or pinned to one item, which is the
           difference between "stop telling me about disabled entities" and
           "stop telling me about this one dashboard's disabled entities". */
        if (issue.kind !== rule.value) return false;
        if (!rule.item) return true;
        return item.key === rule.item || item.entityId === rule.item || item.urlPath === rule.item;
      case 'label':
        return entityCarriesLabel(hass, ref, rule.value);
      default:
        return false;
    }
  }

  /** A label on the entity itself, or on the device it belongs to. */
  function entityCarriesLabel(hass, entityId, label) {
    if (!entityId || !hass) return false;
    const reg = (hass.entities || {})[entityId];
    if (!reg) return false;
    if (Array.isArray(reg.labels) && reg.labels.indexOf(label) >= 0) return true;
    const dev = reg.device_id && (hass.devices || {})[reg.device_id];
    return !!(dev && Array.isArray(dev.labels) && dev.labels.indexOf(label) >= 0);
  }

  /**
   * Moves every covered finding out of the actionable set.
   *
   * Idempotent: previously ignored findings are folded back in first, so the
   * pass can run again after a rule is added or withdrawn without a rescan.
   */
  function applyIgnores(config, rules, hass) {
    if (!config || !config.items) return config;
    const compiled = compileIgnores(rules);
    config.ignoreRules = rules || [];
    /* Nothing to hide and nothing hidden: the counters applyRuntime just
       rebuilt are already right, and this runs on every state change. */
    if (!compiled.length && !config.items.some((i) => i.ignoredIssues && i.ignoredIssues.length)) {
      if (config.counts) { config.counts.ignoredFindings = 0; config.counts.ignoredItems = 0; }
      return config;
    }
    let findings = 0;
    let hitItems = 0;
    for (const item of config.items) {
      if (item.ignoredIssues && item.ignoredIssues.length) {
        item.issues = item.issues.concat(item.ignoredIssues);
      }
      item.ignoredIssues = [];
      if (compiled.length) {
        const keep = [];
        for (const issue of item.issues) {
          let hit = null;
          for (const c of compiled) {
            if (ignoreMatches(c, issue, item, hass)) { hit = c; break; }
          }
          if (hit) {
            issue.ignoredBy = hit.id;
            item.ignoredIssues.push(issue);
          } else {
            delete issue.ignoredBy;
            keep.push(issue);
          }
        }
        item.issues = keep;
        if (item.ignoredIssues.length) { hitItems++; findings += item.ignoredIssues.length; }
      }
      summariseItem(item);
    }
    const summary = summariseConfig(config.items, config.counts && config.counts.scanned);
    config.counts = summary.counts;
    config.problems = summary.display;
    config.counts.ignoredFindings = findings;
    config.counts.ignoredItems = hitItems;
    config.healthy = summary.counts.brokenTotal === 0 && summary.counts.other === 0 &&
      summary.counts.impairedItems === 0;
    return config;
  }

  /**
   * What a rule would hide, worked out before it is written.
   *
   * A wildcard is the one ignore scope that can quietly bury a hundred real
   * problems, so the confirmation says how many findings it covers and names
   * the first few. Returns { findings, items, refs, sample }.
   */
  function ignorePreview(config, rule, hass) {
    const compiled = compileIgnores([rule]);
    const refs = new Set();
    const items = new Set();
    const sample = [];
    let findings = 0;
    for (const item of (config && config.items) || []) {
      const all = item.issues.concat(item.ignoredIssues || []);
      for (const issue of all) {
        if (!compiled.length || !ignoreMatches(compiled[0], issue, item, hass)) continue;
        findings++;
        items.add(item.key);
        if (issue.ref) refs.add(String(issue.ref));
        if (sample.length < 5) sample.push(item.name + ' — ' + issue.message);
      }
    }
    return { findings, items: items.size, refs: refs.size, sample };
  }

  function summariseItem(item) {
    item.issues.sort((a, b) => {
      const c = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
      return c || String(a.location).localeCompare(String(b.location));
    });
    item.verified = item.issues.filter((i) => i.confidence === 'verified').length;
    item.impaired = item.issues.filter((i) => i.confidence === 'impaired').length;
    item.warnings = item.issues.filter((i) => i.confidence === 'warning').length;
    item.unvalidated = item.issues.filter((i) => i.confidence === 'unvalidated').length;
    /* Broken outranks impaired outranks warning: a reference that does not
       exist is worse news than one that is merely silent today. */
    item.band = item.verified ? 'critical' : item.impaired ? 'impaired' : item.warnings ? 'warn' : 'unknown';
    return item;
  }

  /**
   * The top-level keys of an automation or script that can hold a live
   * reference, walked after the blocks.
   *
   * This used to be a hole: the walk was pointed at `triggers`, `conditions`,
   * `actions` and `sequence` only, so a `variables:` block above them was
   * invisible - and a script that resolves its whole behaviour from
   * `variables: { dry_run: "{{ is_state('input_boolean.x', 'on') }}" }` had
   * none of it seen.
   *
   * `variables` and `trigger_variables` are walked weak, because their keys are
   * whatever the author chose. `fields` is treated with more care: a script's
   * `description`, `example` and `selector` are documentation for the run
   * dialog, and only `default` becomes a real value at run time.
   */
  function walkTopLevel(cfg, type, emit, index) {
    const weak = { weak: true, domains: index.domains };
    for (const key of ['variables', 'trigger_variables']) {
      const block = cfg[key];
      if (block && typeof block === 'object') {
        walkRefs(block, [key === 'variables' ? 'Variables' : 'Trigger variables'], emit, weak);
      }
    }
    if (type !== 'script' || !cfg.fields || typeof cfg.fields !== 'object') return;
    for (const name in cfg.fields) {
      const field = cfg.fields[name];
      if (!field || typeof field !== 'object' || field.default === undefined) continue;
      const at = ['Field “' + name + '” default'];
      if (typeof field.default === 'string') {
        if (TEMPLATE_RE.test(field.default)) emitTemplate(field.default, at, emit);
        else emitWeak('default', field.default, at, emit, weak);
      } else {
        walkRefs(field.default, at, emit, weak);
      }
    }
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

    item.deps = new Map();
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
      } else {
        for (const block of AUTOMATION_BLOCKS) {
          const key = block.keys.find((k) => cfg[k] !== undefined);
          if (!key) continue;
          const value = cfg[key];
          const list = Array.isArray(value) ? value : [value];
          list.forEach((step, i) => walkRefs(step, [block.label + ' #' + (i + 1)], emit, {}));
        }
      }
      walkTopLevel(cfg, type, emit, index);
    }, index, item.deps);

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
    item.deps = new Map();
    item.issues = findingsOf((emit) => {
      emitSlot('entity', cfg.entities || {}, ['Entities'], emit, 'entities');
    }, index, item.deps);
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
    item.deps = new Map();
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
            /* Weak: a card's own option names are the custom card's business,
               not Home Assistant's, so `rain_sensor:` has to be recognised by
               the shape of its value rather than by the slot. */
            walkRefs(card, base.concat(seg), emit, { weak: true, domains: index.domains });
          });
        }
      }, index, item.deps);

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
    const summary = summariseConfig(items, scanned);
    return {
      items,
      problems: summary.display,
      counts: summary.counts,
      /* Kept so the runtime join can ask the same existence questions the scan
         asked, rather than re-deriving "disabled" from a second source. */
      index,
      healthy: summary.counts.brokenTotal === 0 && summary.counts.other === 0 &&
        summary.counts.impairedItems === 0,
    };
  }

  /* ------------------------------------------------------------------ *
   * The runtime join
   *
   * A configuration item can be structurally perfect and still be unable to
   * work, because something it depends on is not answering. That is neither a
   * broken reference nor a healthy one, so it gets its own tier: IMPAIRED.
   *
   * The join is deliberately one-directional and index-driven. Every item
   * already carries the set of entities it references and that exist; turning
   * that into `entity -> items` once per scan means a state change is answered
   * by a lookup on the handful of entities that are actually unavailable,
   * never by walking automations again.
   * ------------------------------------------------------------------ */

  /** Only these mean "cannot work". `off`, `closed`, `idle` and friends do not. */
  const IMPAIRED_STATES = { unavailable: 'entity-unavailable', unknown: 'entity-unknown' };

  /**
   * The devices the user has told the card to leave alone.
   *
   * Extracted so the configuration half can ask the same question the device
   * half already asks. Skip has to mean skipped everywhere: a 3D printer that
   * travels between two houses is switched off in one of them by definition,
   * and a page that honours that on the device list while still reporting
   * seven impaired dashboard cards has not really skipped anything.
   */
  function skippedDevices(hass, cfg) {
    const devices = (hass && hass.devices) || {};
    const label = (cfg && cfg.skip_label) || DEFAULT_SKIP_LABEL;
    const out = new Set((cfg && cfg.exclude_devices) || []);
    for (const id in devices) {
      const labels = devices[id].labels;
      if (labels && labels.indexOf(label) >= 0) out.add(id);
    }
    return out;
  }

  /**
   * Domains for which `unknown` is the resting state, not a fault.
   *
   * A `button`'s state is the timestamp of its last press, a `scene`'s the last
   * time it was applied, an `event`'s the last event. One that has not been
   * fired since Home Assistant started has no timestamp and reads `unknown`
   * forever. On a normal install that is most of them - 200 of 220 buttons on
   * the house this was found in - so treating it as an impairment fills the
   * page with configuration that is working perfectly.
   *
   * The same list already excludes these domains from device health for exactly
   * this reason. `unavailable` is deliberately NOT excluded: a button that has
   * gone unavailable means the hardware has left the network, and that is news.
   */
  const UNKNOWN_IS_IDLE = new Set(DEFAULT_IGNORED_DOMAINS.concat(['input_button']));

  /* "unknown" reads as "I do not recognise this entity", which is the one thing
     it does not mean - a reference to something that truly does not exist is
     reported as missing, in red, before this ever runs. */
  const IMPAIRED_WORD = {
    'entity-unavailable': 'Referenced entity is unavailable: ',
    'entity-unknown': 'Referenced entity has never reported a value: ',
  };

  /**
   * entity_id -> {name, deviceId} for naming the device behind an impaired
   * reference. Cached on the registry objects themselves: they are replaced
   * wholesale when anything in the registry changes, so identity is a free and
   * exact cache key.
   */
  let deviceIndexCache = null;
  function dependencyDeviceIndex(hass) {
    if (deviceIndexCache && deviceIndexCache.e === hass.entities && deviceIndexCache.d === hass.devices) {
      return deviceIndexCache.map;
    }
    const map = new Map();
    const entities = hass.entities || {};
    const devices = hass.devices || {};
    for (const id in entities) {
      const did = entities[id].device_id;
      if (!did) continue;
      const dev = devices[did];
      if (!dev) continue;
      map.set(id, { deviceId: did, name: dev.name_by_user || dev.name || did });
    }
    deviceIndexCache = { e: hass.entities, d: hass.devices, map };
    return map;
  }

  /* Owner kinds the backend can report, and the item they become on the page.
     `yaml` and `helper` have no browser-side counterpart at all: nothing in the
     frontend can read templates.yaml or a utility meter's config entry, which
     is exactly why those references were outside the join. */
  const FILE_OWNER_TYPE = {
    automation: 'automation', script: 'script', scene: 'scene',
    dashboard: 'dashboard', file: 'yaml', entry: 'helper',
  };

  /**
   * Folds the file scanner's dependency universe into the card's.
   *
   * The audit measured the hole this closes: the browser tracked 287 entities
   * while the configuration actually names 358, so 71 of them could go
   * unavailable without anything on the page noticing. The browser cannot read
   * YAML packages, templates.yaml or a helper's config entry, and it never
   * will - so the backend hands over the edges it found and this merges them
   * into the same index, under the same rules.
   *
   * Deduplication is by (item, entity): a reference both scanners found is one
   * dependency with two witnesses, never two rows saying the same thing. The
   * structural location wins when there is one, because "Trigger #1" is worth
   * more than "automations.yaml:935".
   */
  /**
   * Resolves a file-side owner to the item it belongs on, creating one only
   * when the browser has no counterpart. Shared by the dependency merge and
   * the missing-reference merge so both halves land on the same card.
   */
  function fileOwnerResolver(config) {
    const byAutomation = new Map();
    const byScript = new Map();
    const byDashboard = new Map();
    const byKey = new Map();
    for (const item of config.items) {
      byKey.set(item.key, item);
      if (item.type === 'automation' && item.id != null) byAutomation.set(String(item.id), item);
      if (item.type === 'script' && item.entityId) byScript.set(item.entityId.slice(7), item);
      if (item.type === 'dashboard' && item.urlPath) byDashboard.set(item.urlPath, item);
    }
    return (own) => {
      if (own.k === 'automation' && byAutomation.has(String(own.i))) return byAutomation.get(String(own.i));
      if (own.k === 'script' && byScript.has(own.i)) return byScript.get(own.i);
      if (own.k === 'dashboard' && byDashboard.has(own.i)) return byDashboard.get(own.i);
      const type = FILE_OWNER_TYPE[own.k] || 'other';
      const key = own.k + ':' + own.i;
      if (byKey.has(key)) return byKey.get(key);
      const item = {
        type,
        key,
        entityId: null,
        id: own.i || null,
        name: own.t || (own.k === 'file' ? String(own.i).split('/').pop() : String(own.i)),
        issues: [],
        inspected: true,
        fileOnly: true,
        entryId: own.k === 'entry' ? own.i : null,
        entryDomain: own.d || null,
        file: own.f || null,
        deps: new Map(),
      };
      byKey.set(key, item);
      config.items.push(item);
      return item;
    };
  }

  function mergeFileDeps(config, payload) {
    if (!config || !config.items || !payload || !Array.isArray(payload.deps)) return config;
    config.fileDeps = payload;

    const owned = fileOwnerResolver(config);

    let merged = 0;
    let added = 0;
    for (const dep of payload.deps) {
      const entity = dep.e;
      if (!entity || !Array.isArray(dep.o)) continue;
      for (const own of dep.o) {
        const item = owned(own);
        if (!item.deps) item.deps = new Map();
        if (!item.fileSeen) item.fileSeen = new Map();
        const where = own.p
          ? own.t
            ? own.p
            : own.f + ' → ' + own.p
          : own.f + ':' + own.l;
        const seen = item.fileSeen.get(entity) || [];
        if (seen.indexOf(where) < 0 && seen.length < 4) seen.push(where);
        item.fileSeen.set(entity, seen);
        if (item.deps.has(entity)) { merged++; continue; }
        item.deps.set(entity, []);
        added++;
      }
    }
    /* The index is derived from the items, so it has to be thrown away or the
       new edges would never be joined. */
    config.depIndex = null;
    config.fileDepStats = { entities: payload.deps.length, merged, added };
    return config;
  }

  /**
   * Folds the file scanner's *broken* references into the same items.
   *
   * The browser and the file scanner overlap: both read automations.yaml, one
   * through the automation editor and one off the disk. When both see the same
   * dangling reference it is one finding with two witnesses - never two rows
   * saying the same sentence because two different programs said it.
   *
   * A reference only the file scanner can see - in a YAML package, or in a
   * helper's config entry - becomes a finding on an owner item of its own,
   * which is the only way it reaches the page at all.
   */
  function mergeFileMissing(config, list) {
    if (!config || !config.items || !Array.isArray(list)) return config;
    const owned = fileOwnerResolver(config);
    let confirmed = 0;
    let fromFile = 0;
    for (const rec of list) {
      const ref = rec && rec.entity_id;
      if (!ref) continue;
      const owners = [];
      for (const occ of rec.occurrences || []) {
        const file = occ.file;
        if (file === '.storage/core.config_entries') continue;
        const base = String(file).split('/').pop();
        const kind = { 'automations.yaml': 'automation', 'scripts.yaml': 'script', 'scenes.yaml': 'scene' }[base];
        if (occ.holder && kind) owners.push({ k: kind, i: occ.holder, f: file, l: occ.line });
        else if (rec.dashboard) owners.push({ k: 'dashboard', i: rec.dashboard, f: file, l: occ.line });
        else owners.push({ k: 'file', i: file, f: file, l: occ.line });
      }
      for (const own of rec.owners || []) {
        owners.push({ k: 'entry', i: own.entry_id, t: own.title, d: own.domain, f: '.storage/core.config_entries', p: own.field });
      }
      if (!owners.length) owners.push({ k: 'file', i: 'configuration', f: 'configuration', l: 0 });

      const meta = {
        chFile: (rec.occurrences && rec.occurrences[0] && rec.occurrences[0].file) || null,
        chLine: (rec.occurrences && rec.occurrences[0] && rec.occurrences[0].line) || null,
        chSuggestion: rec.suggestion || null,
        chEditable: rec.editable,
      };
      const seenOn = new Set();
      for (const own of owners) {
        const item = owned(own);
        if (seenOn.has(item.key)) continue;
        seenOn.add(item.key);
        /* Already found structurally: confirm it rather than repeat it. */
        const existing = item.issues.filter((i) => i.ref === ref && i.confidence !== 'unvalidated');
        if (existing.length) {
          for (const issue of existing) {
            issue.seenByFile = true;
            Object.assign(issue, meta);
          }
          confirmed++;
          continue;
        }
        /* The walk did look here and called it unvalidated - a template it
           could not resolve. The file scanner resolved it and found nothing,
           so the guess becomes a fact. */
        const guessed = item.issues.filter((i) => i.ref === ref && i.confidence === 'unvalidated');
        if (guessed.length) {
          for (const issue of guessed) {
            issue.confidence = 'verified';
            issue.seenByFile = true;
            Object.assign(issue, meta);
          }
          confirmed++;
          continue;
        }
        item.issues.push(Object.assign({
          confidence: 'verified',
          kind: 'entity',
          ref,
          location: own.p || (own.l ? own.f + ':' + own.l : own.f),
          message: 'Missing entity: ' + ref,
          fromFile: true,
          seenByFile: true,
          renamedTo: config.index && config.index.renameHint ? config.index.renameHint(ref) : null,
        }, meta));
        fromFile++;
      }
    }
    for (const item of config.items) summariseItem(item);
    const summary = summariseConfig(config.items, config.counts && config.counts.scanned);
    config.counts = summary.counts;
    config.problems = summary.display;
    config.fileMissingStats = { records: list.length, confirmed, fromFile };
    config.healthy = summary.counts.brokenTotal === 0 && summary.counts.other === 0 &&
      summary.counts.impairedItems === 0;
    return config;
  }

  function buildDependencyIndex(items) {
    const index = new Map();
    for (const item of items) {
      if (!item.deps) continue;
      for (const id of item.deps.keys()) {
        let list = index.get(id);
        if (!list) index.set(id, (list = []));
        list.push(item);
      }
    }
    return index;
  }

  /**
   * Rewrites the impaired findings from current state.
   *
   * Called whenever the runtime picture changes, so it must be idempotent:
   * every previously injected finding is dropped first, and the surviving
   * findings are the ones the scan itself produced.
   */
  function applyRuntime(config, hass, deviceIndex, cfg) {
    if (!config || !config.items) return config;
    /* Skip is a device-registry label, and it has to mean the same thing here
       as it does on the device list. Only the runtime verdicts are suppressed:
       a reference to an entity that has actually been deleted is a broken
       configuration whether or not the device is skipped. */
    const skipped = skippedDevices(hass, cfg);
    /* The label can sit on a single entity as well as on its device, and the
       backend has always honoured both. One printer entity that reports
       nonsense while the rest of the machine is fine is a reasonable thing to
       silence on its own. */
    const skipLabel = (cfg && cfg.skip_label) || DEFAULT_SKIP_LABEL;
    const registry = hass.entities || {};
    if (!config.depIndex) config.depIndex = buildDependencyIndex(config.items);

    const touched = new Set();
    for (const item of config.items) {
      if (item.hasRuntime) {
        item.issues = item.issues.filter((i) => !i.runtime);
        /* A runtime finding that an ignore rule moved aside still has to go,
           or the next pass would fold a stale one back in. */
        if (item.ignoredIssues) item.ignoredIssues = item.ignoredIssues.filter((i) => !i.runtime);
        item.hasRuntime = false;
        touched.add(item);
      }
    }

    const states = hass.states || {};
    const index = config.index || null;
    for (const [entityId, items] of config.depIndex) {
      const st = states[entityId];
      /* One classification, used by both scanners. Precedence is fixed:
         missing beats disabled beats unavailable beats unknown, and everything
         else - off, closed, idle, standby - is a working entity doing its job.
         A dependency that has since been deleted outright is reported as
         broken here rather than silently dropped, which is what used to happen
         to a reference the file scanner found and the browser could not see. */
      let confidence = null;
      let kind = null;
      let message = null;
      const verdict = index ? index.entity(entityId) : (st ? 'exists' : 'missing');
      if (verdict === 'missing') {
        confidence = 'verified';
        kind = 'entity';
        message = 'Missing entity: ' + entityId;
      } else if (verdict === 'disabled') {
        confidence = 'warning';
        kind = 'entity-disabled';
        message = 'Referenced entity is disabled: ' + entityId;
      } else if (st && IMPAIRED_STATES[st.state]) {
        /* A command surface that has never been fired is not impaired; it is
           waiting, which is what it does. */
        if (st.state === UNKNOWN && UNKNOWN_IS_IDLE.has(domainOf(entityId))) continue;
        confidence = 'impaired';
        kind = IMPAIRED_STATES[st.state];
        message = IMPAIRED_WORD[kind] + entityId;
      }
      if (!confidence) continue;
      const since = st ? st.last_changed || null : null;
      /* The device the entity belongs to, so a reader can go from "this
         automation cannot run" to "because that device is offline" without
         holding both halves of the page in their head. */
      const dev = deviceIndex ? deviceIndex.get(entityId) : null;
      if (confidence !== 'verified') {
        const own = (registry[entityId] && registry[entityId].labels) || null;
        if (dev && skipped.has(dev.deviceId)) continue;
        if (own && own.indexOf(skipLabel) >= 0) continue;
      }
      for (const item of items) {
        item.issues.push({
          confidence,
          kind,
          ref: entityId,
          runtime: true,
          location: locationsFor(item, entityId),
          since: confidence === 'impaired' ? since : null,
          device: dev || null,
          message,
        });
        item.hasRuntime = true;
        touched.add(item);
      }
    }
    for (const item of touched) summariseItem(item);
    /* The counters and the visible list are derived from the items, so they
       have to be rebuilt here too - otherwise the page would show an impaired
       card while the summary above it still read zero. */
    if (touched.size || !config.countsFrom) {
      const summary = summariseConfig(config.items, config.counts && config.counts.scanned);
      config.counts = summary.counts;
      config.problems = summary.display;
      config.healthy =
        summary.counts.brokenTotal === 0 && summary.counts.other === 0 && summary.counts.impairedItems === 0;
      config.countsFrom = 'runtime';
    }
    return config;
  }

  /**
   * Where in the item the entity is named. The scan does not keep a location
   * for a reference that resolved - there was nothing to report - so this is
   * recovered from the findings that do carry one, and falls back to a plain
   * count. Showing "5 places" beats showing the same row five times.
   */
  function locationsFor(item, entityId) {
    const at = item.deps && item.deps.get(entityId);
    /* The structural location reads better than a file offset, so it wins when
       both scanners saw the same reference; the file location is the only one
       there is for a YAML package or a helper's config entry. */
    const list = at && at.length ? at : (item.fileSeen && item.fileSeen.get(entityId)) || [];
    if (!list.length) return null;
    if (list.length <= 2) return list.join(', ');
    return list[0] + ' and ' + (list.length - 1) + ' more';
  }

  /**
   * The counters and the display list, derived from the items.
   *
   * Pulled out of the scan because the runtime join rewrites findings
   * afterwards and the numbers have to follow. Called once by the scan and
   * again by every runtime pass; it reads items and returns, holding no
   * state of its own.
   */
  function summariseConfig(items, scanned) {
    const flagged = items.filter((i) => i.issues.length);
    const problems = flagged.filter((i) => i.verified || i.impaired || i.warnings);
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
      /* A YAML package or a helper only ever reaches the page through the file
         scanner, and only a verified finding there is "broken": one whose
         source has merely gone quiet is impaired, and impaired is not
         something the broken counter is allowed to swallow. */
      other: problems.filter(
        (i) => i.type === 'other' || ((i.type === 'yaml' || i.type === 'helper') && i.verified)
      ).length,
      verifiedIssues: verified.length,
      /* Items, not findings: one automation naming the same silent sensor in
         five conditions is one impaired automation, not five. */
      impairedItems: items.filter((i) => i.impaired && !i.verified).length,
      impairedAutomations: items.filter((i) => i.impaired && !i.verified && i.type === 'automation').length,
      impairedScripts: items.filter((i) => i.impaired && !i.verified && i.type === 'script').length,
      impairedScenes: items.filter((i) => i.impaired && !i.verified && i.type === 'scene').length,
      impairedDashboards: items.filter((i) => i.impaired && !i.verified && i.type === 'dashboard').length,
      impairedFiles: items.filter((i) => i.impaired && !i.verified && i.type === 'yaml').length,
      impairedHelpers: items.filter((i) => i.impaired && !i.verified && i.type === 'helper').length,
      impairedRefs: new Set(all.filter((x) => x.issue.confidence === 'impaired').map((x) => x.issue.ref)).size,
      disabledRefs: new Set(
        all.filter((x) => x.issue.kind === 'entity-disabled').map((x) => x.issue.ref)
      ).size,
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
      if (a.impaired !== b.impaired) return b.impaired - a.impaired;
      if (a.warnings !== b.warnings) return b.warnings - a.warnings;
      return String(a.name).localeCompare(String(b.name));
    });

    return { counts, display };
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


  /* ================================================================== *
   * CONFLICT ANALYSIS
   *
   * A fourth question, alongside the others: can two scheduled runs get in
   * each other's way?
   *
   * Home Assistant will happily let an automation fire at 05:15 while its own
   * 05:00 run is still working through a delay. In `mode: single` the second
   * run is dropped, silently, and the only symptom is that something did not
   * happen. Nothing warns about it.
   *
   * This layer is READ ONLY in the strongest sense: it never calls a service,
   * never triggers, enables, disables or edits anything. It reads the same
   * automation and script configurations the inspector already fetched, and
   * reasons about them statically.
   *
   * The whole design is built around not crying wolf. Two automations running
   * at the same time is not a conflict; two automations fighting over the same
   * switch is. Anything it cannot work out is reported as unknown rather than
   * guessed, and an unknown runtime never becomes a conflict on its own.
   * ================================================================== */

  const DEFAULT_CONFLICTS = {
    /* How close two scheduled starts must be to be worth mentioning even when
       neither run is long enough to overlap the other. */
    near_minutes: 2,
    /* Depth limit for following script calls: deep enough for the real chains
       on a normal install, shallow enough that a pathological one cannot hang
       the page. Cycles are caught separately and exactly. */
    max_script_depth: 4,
    /* A `repeat` with more iterations than this is treated as unbounded rather
       than multiplied out, so one silly loop cannot dominate the page. */
    max_repeat_iterations: 500,
    /* A run shorter than this is over before anything can collide with it.
       Without this the page fills with automations that merely happen to fire
       in the same minute and are finished instantly - true, and useless. */
    min_runtime_minutes: 1,
  };

  const DAY_MIN = 1440;

  /* ---------------------------------------------------------------- *
   * Durations
   * ---------------------------------------------------------------- */

  /** True for anything carrying a Jinja template, which is not statically known. */
  const isTemplate = (v) => typeof v === 'string' && v.indexOf('{{') >= 0;

  /**
   * Seconds from any shape Home Assistant accepts for a delay or a timeout: a
   * bare number, "HH:MM:SS", "MM:SS", or a mapping. Returns null when it cannot
   * be known, which is a different thing from zero.
   */
  function durationSeconds(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return isFinite(value) ? value : null;

    if (typeof value === 'string') {
      if (isTemplate(value)) return null;
      const parts = value.trim().split(':');
      if (parts.length === 2 || parts.length === 3) {
        const nums = parts.map(Number);
        if (nums.some((n) => !isFinite(n))) return null;
        return parts.length === 3
          ? nums[0] * 3600 + nums[1] * 60 + nums[2]
          : nums[0] * 60 + nums[1];
      }
      const n = Number(value);
      return isFinite(n) ? n : null;
    }

    if (typeof value === 'object') {
      let total = 0;
      let saw = false;
      const units = { days: 86400, hours: 3600, minutes: 60, seconds: 1, milliseconds: 0.001 };
      for (const key in units) {
        if (!(key in value)) continue;
        const raw = value[key];
        if (isTemplate(raw)) return null;
        const n = Number(raw);
        if (!isFinite(n)) return null;
        total += n * units[key];
        saw = true;
      }
      return saw ? total : null;
    }
    return null;
  }

  /** A duration estimate: a range, plus why it is not exact. */
  const known = (sec) => ({ min: sec, max: sec, unknown: false, reasons: [] });
  const unknownFor = (reason) => ({ min: 0, max: 0, unknown: true, reasons: [reason] });

  function addDur(a, b) {
    return {
      min: a.min + b.min,
      max: a.max + b.max,
      unknown: a.unknown || b.unknown,
      estimated: !!(a.estimated || b.estimated),
      reasons: a.reasons.concat(b.reasons),
    };
  }

  /** Widest of several branches: the shortest floor and the longest ceiling. */
  function spanDur(list) {
    if (!list.length) return known(0);
    return {
      min: Math.min.apply(null, list.map((d) => d.min)),
      max: Math.max.apply(null, list.map((d) => d.max)),
      unknown: list.some((d) => d.unknown),
      estimated: list.some((d) => d.estimated),
      reasons: list.reduce((acc, d) => acc.concat(d.reasons), []),
    };
  }

  /**
   * How long a sequence of actions takes, as a range.
   *
   * Only what actually consumes wall-clock time is counted: delays, and waits
   * that carry a timeout. A service call is treated as instant, which is not
   * exactly true but is true enough at this resolution - and erring short is
   * the safe direction, because it makes the analyser claim fewer overlaps
   * rather than more.
   *
   * `ctx` carries the script table, the stack of scripts already entered (for
   * cycle detection), the remaining depth, and the trigger id that fired, which
   * is what lets a `choose` be narrowed to the branch that can actually run.
   */
  function sequenceDuration(seq, ctx) {
    if (!Array.isArray(seq)) return known(0);
    let total = known(0);
    for (const step of seq) total = addDur(total, stepDuration(step, ctx));
    return total;
  }

  function stepDuration(step, ctx) {
    if (!step || typeof step !== 'object') return known(0);

    /* A step the user switched off does not run. */
    if (step.enabled === false) return known(0);

    if ('delay' in step) {
      const sec = durationSeconds(step.delay);
      return sec === null ? unknownFor('templated delay') : known(sec);
    }

    /* A wait with a timeout is bounded by it; without one it can wait for ever,
       which is exactly where inventing a number would be wrong. */
    if ('wait_template' in step || 'wait_for_trigger' in step) {
      if (!('timeout' in step)) return unknownFor('wait without a timeout');
      const sec = durationSeconds(step.timeout);
      if (sec === null) return unknownFor('templated wait timeout');
      /* It may return the moment the condition is met, so the floor is zero. */
      return { min: 0, max: sec, unknown: false, reasons: [] };
    }

    if ('repeat' in step) return repeatDuration(step.repeat, ctx);

    if ('choose' in step) {
      const branches = Array.isArray(step.choose) ? step.choose : [];
      const reachable = branches.filter((b) => branchReachable(b, ctx));
      const durations = reachable.map((b) => sequenceDuration(b.sequence, ctx));
      if (step.default) durations.push(sequenceDuration(step.default, ctx));
      if (!durations.length) return known(0);
      const span = spanDur(durations);
      /* Only one branch runs. The floor is the shortest of them, but if some
         branch could match nothing at all the floor is zero. */
      const allReachable = reachable.length === branches.length && !step.default;
      return { min: allReachable ? span.min : 0, max: span.max, unknown: span.unknown, reasons: span.reasons };
    }

    if ('if' in step) {
      const thenD = sequenceDuration(step.then, ctx);
      const elseD = step.else ? sequenceDuration(step.else, ctx) : known(0);
      const span = spanDur([thenD, elseD]);
      return { min: Math.min(thenD.min, elseD.min), max: span.max, unknown: span.unknown, reasons: span.reasons };
    }

    /* Branches run at the same time, so the slowest one sets the length. */
    if ('parallel' in step) {
      const list = Array.isArray(step.parallel) ? step.parallel : [];
      const durations = list.map((b) =>
        Array.isArray(b) ? sequenceDuration(b, ctx)
          : b && b.sequence ? sequenceDuration(b.sequence, ctx)
            : stepDuration(b, ctx));
      if (!durations.length) return known(0);
      const span = spanDur(durations);
      return { min: Math.max.apply(null, durations.map((d) => d.min)), max: span.max, unknown: span.unknown, reasons: span.reasons };
    }

    if ('sequence' in step) return sequenceDuration(step.sequence, ctx);

    const call = step.action || step.service;
    if (isTemplate(call)) return unknownFor('templated action name');

    /* Remember how long each timer was started for, so a loop that waits on it
       further down the sequence has a bound to use. */
    if (call === 'timer.start' && ctx.timers) {
      const dur = resolveTemplatedDuration(step.data && step.data.duration, ctx.hass);
      for (const e of targetEntities(step, ctx)) {
        if (e.unresolved || e.id.indexOf('timer.') !== 0) continue;
        /* `timer.start` with no duration restarts the timer at the one it
           already has, so an entry is only ever replaced, never forgotten. */
        if (dur) ctx.timers.set(e.id, dur);
      }
    }

    /* A script called and waited on runs inline: its delays are this run's. */
    if (typeof call === 'string') return scriptCallDuration(call, step, ctx);

    return known(0);
  }

  function repeatDuration(repeat, ctx) {
    if (!repeat || typeof repeat !== 'object') return known(0);

    /* Read before the body is walked: the body may restart the very timer the
       loop is waiting on, and the bound that matters is the one in force when
       the loop was entered. */
    const bound = timerBound(repeat, ctx);

    const body = sequenceDuration(repeat.sequence, ctx);

    if ('count' in repeat) {
      if (isTemplate(repeat.count)) return unknownFor('templated repeat count');
      const n = Number(repeat.count);
      if (!isFinite(n) || n < 0) return unknownFor('unreadable repeat count');
      if (n > ctx.limits.max_repeat_iterations) return unknownFor('very large repeat count');
      return { min: body.min * n, max: body.max * n, unknown: body.unknown, reasons: body.reasons };
    }
    if ('for_each' in repeat) {
      if (!Array.isArray(repeat.for_each)) return unknownFor('templated for_each');
      const n = repeat.for_each.length;
      return { min: body.min * n, max: body.max * n, unknown: body.unknown, reasons: body.reasons };
    }
    /* A loop that runs while a timer is active is bounded by that timer. */
    if (bound) return bound;

    /* while / until otherwise run an unknown number of times. */
    return unknownFor('repeat with no fixed count');
  }


  /**
   * How much of one loop iteration the watched timer is actually counting down
   * for, and how long the iteration takes in total.
   *
   * A timer's duration is *countdown* time, not elapsed time: `timer.pause`
   * stops the clock while the world keeps turning. The irrigation pattern of
   * "five minutes on, five minutes off, repeat until the timer runs out" is
   * exactly this - a 25-minute timer spends 25 minutes counting, but takes 50
   * minutes of wall clock to do it.
   *
   * So the two are measured separately: delays that happen while the timer runs
   * consume its duration, and every delay adds to the elapsed time.
   */
  function iterationTiming(seq, timerId, ctx, state) {
    state = state || { running: true, active: 0, total: 0, unknown: false };
    if (!Array.isArray(seq)) return state;

    for (const step of seq) {
      if (!step || typeof step !== 'object' || step.enabled === false) continue;

      if ('delay' in step) {
        const sec = durationSeconds(step.delay);
        if (sec === null) { state.unknown = true; continue; }
        state.total += sec;
        if (state.running) state.active += sec;
        continue;
      }

      /* Nested blocks still consume time; they are walked so a pause inside one
         is not missed. Their branching is not modelled beyond this - a loop
         whose iteration length depends on a condition is not something to be
         confident about. */
      if ('sequence' in step) { iterationTiming(step.sequence, timerId, ctx, state); continue; }
      if ('if' in step) { iterationTiming(step.then, timerId, ctx, state); continue; }
      if ('choose' in step) {
        const branches = Array.isArray(step.choose) ? step.choose : [];
        if (branches.length) iterationTiming(branches[0].sequence, timerId, ctx, state);
        state.unknown = true;
        continue;
      }
      if ('repeat' in step) { state.unknown = true; continue; }

      const call = step.action || step.service;
      if (typeof call !== 'string' || isTemplate(call)) continue;

      /* Only commands aimed at the timer this loop is waiting on matter. */
      if (call.indexOf('timer.') !== 0) continue;
      const aimed = targetEntities(step, ctx).some((e) => e.id === timerId);
      if (!aimed) continue;

      const verb = call.slice('timer.'.length);
      /* `timer.start` on a paused timer resumes it; on a running one it
         restarts. Either way it is counting down afterwards. */
      if (verb === 'start' || verb === 'resume' || verb === 'change') state.running = true;
      else if (verb === 'pause') state.running = false;
      else if (verb === 'cancel' || verb === 'finish') { state.running = false; state.unknown = true; }
    }
    return state;
  }

  /** The bound a `while <timer active>` loop takes from that timer, if known. */
  function timerBound(repeat, ctx) {
    const watched = timersWatchedBy(repeat.while || repeat.until);
    for (const id of watched) {
      const dur = ctx.timers && ctx.timers.get(id);
      if (!dur) continue;

      const t = iterationTiming(repeat.sequence, id, ctx, null);
      const from = dur.source ? ', started from ' + dur.source : '';

      /* No delay runs while the timer counts down, so the loop could turn over
         for ever without spending any of it. */
      if (!t.active) {
        return unknownFor('loop on ' + id + ' never lets the timer count down');
      }

      /* Elapsed time is the timer's duration stretched by however much of each
         iteration it spends paused. With no pause the two are the same. */
      const stretch = t.total / t.active;
      const seconds = dur.seconds * stretch;
      const reason = stretch > 1.01
        ? 'bounded by ' + id + from + ', stretched ' + (Math.round(stretch * 100) / 100) +
          'x because the timer is paused for ' + Math.round((t.total - t.active) / 60) +
          ' of every ' + Math.round(t.total / 60) + ' min'
        : 'bounded by ' + id + from;

      return {
        min: 0,
        max: seconds,
        /* A branch inside the loop makes the iteration length a guess rather
           than a measurement, so the estimate is offered but flagged. */
        unknown: !!t.unknown,
        estimated: true,
        reasons: [reason + (t.unknown ? ' (iteration length varies)' : '')],
      };
    }
    return null;
  }

  /**
   * A `choose` branch is reachable from a given trigger unless it is gated on a
   * *different* trigger id. This is what stops a seven-trigger irrigation
   * automation being reported as seven overlapping half-hour runs: each trigger
   * only reaches its own branch.
   */
  function branchReachable(branch, ctx) {
    if (!branch || typeof branch !== 'object') return false;
    if (branch.enabled === false) return false;
    if (!ctx.triggerId) return true;
    const conds = Array.isArray(branch.conditions) ? branch.conditions
      : branch.conditions ? [branch.conditions] : [];
    let gated = false;
    for (const c of conds) {
      if (!c || c.condition !== 'trigger') continue;
      gated = true;
      const ids = Array.isArray(c.id) ? c.id : [c.id];
      if (ids.map(String).indexOf(String(ctx.triggerId)) >= 0) return true;
    }
    /* Gated on some other trigger: this branch cannot run for ours. */
    return !gated;
  }

  function scriptCallDuration(call, step, ctx) {
    const dot = call.indexOf('.');
    const domain = dot > 0 ? call.slice(0, dot) : call;
    const service = dot > 0 ? call.slice(dot + 1) : '';

    /* `script.turn_on` starts a script without waiting for it, so it adds no
       time to this run - a real difference from calling the script directly. */
    if (domain === 'script' && (service === 'turn_on' || service === 'toggle' || service === 'turn_off')) {
      return known(0);
    }
    if (domain !== 'script') {
      const ent = firstEntityOf(step.target) || firstEntityOf(step.entity_id);
      if (typeof ent !== 'string' || ent.indexOf('script.') !== 0) return known(0);
      return enterScript(ent, ctx);
    }
    return enterScript('script.' + service, ctx);
  }

  function enterScript(target, ctx) {
    if (ctx.stack.indexOf(target) >= 0) {
      /* A script that calls itself, directly or through a chain. Counted once
         and then stopped: the loop is real, and its length is not knowable. */
      return unknownFor('recursive script call (' + target + ')');
    }
    if (ctx.depth >= ctx.limits.max_script_depth) {
      return unknownFor('script nesting deeper than ' + ctx.limits.max_script_depth);
    }
    const script = ctx.scripts[target];
    if (!script || !script.config) return unknownFor('script config not readable (' + target + ')');

    return sequenceDuration(script.config.sequence, {
      scripts: ctx.scripts,
      limits: ctx.limits,
      byDevice: ctx.byDevice,
      byRegistryId: ctx.byRegistryId,
      stack: ctx.stack.concat(target),
      depth: ctx.depth + 1,
      /* Trigger gating does not carry into a called script. */
      triggerId: null,
      /* Timers carry across the call: a script that starts a timer and then
         loops on it is the common shape. */
      timers: ctx.timers, hass: ctx.hass,
    });
  }

  const firstEntityOf = (t) => {
    if (!t) return null;
    if (typeof t === 'string') return t;
    if (Array.isArray(t)) return firstEntityOf(t[0]);
    if (typeof t === 'object') return firstEntityOf(t.entity_id);
    return null;
  };


  /* ---------------------------------------------------------------- *
   * Timer-bounded loops
   *
   * `repeat: while <timer is active>` is the standard way to write "keep going
   * until the timer runs out", and on its own it reads as an unbounded loop -
   * which would make every irrigation script's runtime unknown and leave the
   * analyser with nothing to say about exactly the automations it is most
   * useful for.
   *
   * The bound is knowable, though, and without guessing: the `timer.start`
   * that precedes the loop carries the duration. When that duration is a
   * template it is resolved only in the one shape that can be resolved
   * safely - a literal clock skeleton with a single `states()` lookup in it,
   * read from the state machine. Anything more involved stays unknown.
   * ---------------------------------------------------------------- */

  /**
   * A duration that may be templated. Returns { seconds, source } or null.
   * Only `{{ states('x') }}`-shaped substitutions are resolved, and only when
   * the result parses as a number; `| int(20)` style filters fall back to their
   * default when the entity cannot be read.
   */
  function resolveTemplatedDuration(value, hass) {
    const direct = durationSeconds(value);
    if (direct !== null) return { seconds: direct, source: null };
    if (typeof value !== 'string') return null;

    let source = null;
    let failed = false;
    const filled = value.replace(/\{\{(.*?)\}\}/g, (whole, expr) => {
      const ref = /states\(\s*['"]([a-z_]+\.[a-z0-9_]+)['"]\s*\)/i.exec(expr);
      if (!ref) { failed = true; return ''; }
      const entityId = ref[1];
      const st = hass && hass.states && hass.states[entityId];
      const n = st ? Number(st.state) : NaN;
      if (isFinite(n)) {
        source = entityId;
        return String(Math.round(n));
      }
      /* `| int(20)` names its own fallback; using it is the same thing Home
         Assistant would do with an unreadable entity. */
      const dflt = /\|\s*int\(\s*(\d+)\s*\)/.exec(expr);
      if (dflt) { source = entityId + ' (default)'; return dflt[1]; }
      failed = true;
      return '';
    });
    if (failed) return null;
    const seconds = durationSeconds(filled.trim());
    return seconds === null ? null : { seconds: seconds, source: source };
  }

  /** The timer entities a `while`/`until` block watches for being active. */
  function timersWatchedBy(conditions) {
    const out = [];
    const walk = (c) => {
      if (!c) return;
      if (Array.isArray(c)) { c.forEach(walk); return; }
      if (typeof c !== 'object') return;
      if (c.conditions) walk(c.conditions);
      if (c.condition !== 'state') return;
      const states = [].concat(c.state === undefined ? [] : c.state).map(String);
      /* Only "still running" counts. A loop that waits for `idle` is waiting
         for something else to finish and is not bounded by this timer. */
      if (!states.some((s) => s === 'active' || s === 'paused')) return;
      for (const id of [].concat(c.entity_id || [])) {
        if (typeof id === 'string' && id.indexOf('timer.') === 0) out.push(id);
      }
    };
    walk(conditions);
    return out;
  }

  /* ---------------------------------------------------------------- *
   * Triggers
   * ---------------------------------------------------------------- */

  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const minutesToClock = (m) => {
    const t = ((Math.round(m) % DAY_MIN) + DAY_MIN) % DAY_MIN;
    return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60);
  };

  /** "HH:MM:SS" -> minutes past midnight, or null. */
  function clockToMinutes(text) {
    if (typeof text !== 'string' || isTemplate(text)) return null;
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi + (m[3] ? Number(m[3]) / 60 : 0);
  }

  /**
   * The scheduled starts a trigger produces, as minutes past midnight.
   *
   * Only deterministic schedules are expanded. A state change, an MQTT message
   * or a motion sensor has no predictable time, and pretending otherwise is how
   * a monitor like this turns into noise - so those are recorded as dynamic and
   * take no further part in the schedule analysis.
   */
  function triggerOccurrences(trig, hass) {
    const kind = trig.trigger || trig.platform;
    const out = { kind: kind, times: [], dynamic: false, note: null };

    if (trig.enabled === false) { out.disabled = true; return out; }

    if (kind === 'time') {
      const list = Array.isArray(trig.at) ? trig.at : [trig.at];
      for (const at of list) {
        if (typeof at === 'string') {
          const mins = clockToMinutes(at);
          if (mins !== null) { out.times.push(mins); continue; }
          /* `at` can name an input_datetime or a timestamp sensor: still a
             schedule, just one stored elsewhere. */
          if (at.indexOf('.') > 0) {
            const resolved = resolveTimeEntity(at, hass);
            if (resolved !== null) { out.times.push(resolved); out.note = 'from ' + at; continue; }
            out.note = 'time helper ' + at + ' could not be read';
            continue;
          }
          out.note = 'unreadable time';
        } else if (at && typeof at === 'object' && at.entity_id) {
          const resolved = resolveTimeEntity(at.entity_id, hass);
          if (resolved !== null) { out.times.push(resolved); out.note = 'from ' + at.entity_id; }
          else out.note = 'time helper could not be read';
        }
      }
      return out;
    }

    if (kind === 'time_pattern') return timePatternOccurrences(trig, out);

    if (kind === 'sun') {
      const base = sunMinutes(hass, trig.event === 'sunset' ? 'next_setting' : 'next_rising');
      if (base === null) { out.note = 'sun times unavailable'; return out; }
      const offset = durationSeconds(trig.offset) || 0;
      out.times.push(base + offset / 60);
      /* Sunrise and sunset move a little every day, so a collision found today
         is not guaranteed tomorrow. */
      out.approximate = true;
      out.note = trig.event + (trig.offset ? ' ' + trig.offset : '');
      return out;
    }

    out.dynamic = true;
    return out;
  }

  function resolveTimeEntity(entityId, hass) {
    const st = hass && hass.states && hass.states[entityId];
    if (!st) return null;
    const direct = clockToMinutes(st.state);
    if (direct !== null) return direct;
    const attrs = st.attributes || {};
    if (typeof attrs.hour === 'number' && typeof attrs.minute === 'number') {
      return attrs.hour * 60 + attrs.minute;
    }
    /* A timestamp sensor: only its time of day is meaningful here. */
    const parsed = Date.parse(st.state);
    if (!isNaN(parsed)) {
      const d = new Date(parsed);
      return d.getHours() * 60 + d.getMinutes();
    }
    return null;
  }

  function sunMinutes(hass, attr) {
    const sun = hass && hass.states && hass.states['sun.sun'];
    const iso = sun && sun.attributes && sun.attributes[attr];
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.getHours() * 60 + d.getMinutes();
  }

  /**
   * `time_pattern` is a rhythm rather than a list of appointments. A dense one
   * would swamp the page with identical conflicts, so it is summarised instead
   * of expanded.
   */
  function timePatternOccurrences(trig, out) {
    const readField = (v) => {
      if (v === undefined || v === null) return { any: true };
      if (typeof v === 'string' && v.charAt(0) === '/') {
        const step = Number(v.slice(1));
        return isFinite(step) && step > 0 ? { step: step } : { bad: true };
      }
      if (v === '*') return { any: true };
      const n = Number(v);
      return isFinite(n) ? { fixed: n } : { bad: true };
    };
    const H = readField(trig.hours);
    const M = readField(trig.minutes);
    if (H.bad || M.bad) { out.note = 'unreadable time pattern'; return out; }

    if (trig.seconds !== undefined && trig.seconds !== null && String(trig.seconds) !== '0') {
      out.note = 'fires on a seconds pattern';
      out.tooDense = true;
      return out;
    }
    if (M.step && M.step < 30) {
      out.note = 'every ' + M.step + ' minutes';
      out.tooDense = true;
      return out;
    }

    const hours = H.fixed !== undefined ? [H.fixed] : rangeStep(0, 23, H.step || 1);
    const minutes = M.fixed !== undefined ? [M.fixed] : M.step ? rangeStep(0, 59, M.step) : [0];

    for (const h of hours) for (const m of minutes) out.times.push(h * 60 + m);
    out.recurringPattern = true;
    out.note = 'time pattern';
    return out;
  }

  const rangeStep = (from, to, step) => {
    const out = [];
    for (let i = from; i <= to; i += step) out.push(i);
    return out;
  };

  /* ---------------------------------------------------------------- *
   * Targets
   * ---------------------------------------------------------------- */

  /* Pairs of services that undo each other. Used only to raise severity when
     two overlapping runs aim them at the same entity. */
  const OPPOSITES = [
    ['turn_on', 'turn_off'], ['open_cover', 'close_cover'], ['lock', 'unlock'],
    ['open', 'close'], ['start', 'stop'], ['arm_home', 'disarm'], ['arm_away', 'disarm'],
    ['media_play', 'media_pause'],
  ];

  function areOpposites(a, b) {
    const sa = String(a).split('.').pop();
    const sb = String(b).split('.').pop();
    if (sa === sb) return false;
    for (const pair of OPPOSITES) {
      if ((sa === pair[0] && sb === pair[1]) || (sa === pair[1] && sb === pair[0])) return true;
    }
    /* `toggle` fights anything deterministic aimed at the same thing. */
    return sa === 'toggle' || sb === 'toggle';
  }

  /**
   * Every entity a sequence commands, with the services used on each. Device
   * targets are resolved through the registry so that a device-id action and an
   * entity-id action on the same physical thing count as the same target.
   */
  function collectTargets(seq, ctx, out) {
    out = out || { entities: new Map(), unresolved: [] };
    if (!Array.isArray(seq)) return out;

    for (const step of seq) {
      if (!step || typeof step !== 'object' || step.enabled === false) continue;

      if ('choose' in step) {
        const branches = Array.isArray(step.choose) ? step.choose : [];
        for (const b of branches) if (branchReachable(b, ctx)) collectTargets(b.sequence, ctx, out);
        if (step.default) collectTargets(step.default, ctx, out);
        continue;
      }
      if ('if' in step) { collectTargets(step.then, ctx, out); collectTargets(step.else, ctx, out); continue; }
      if ('repeat' in step) { collectTargets(step.repeat && step.repeat.sequence, ctx, out); continue; }
      if ('sequence' in step) { collectTargets(step.sequence, ctx, out); continue; }
      if ('parallel' in step) {
        const list = Array.isArray(step.parallel) ? step.parallel : [];
        for (const b of list) {
          collectTargets(Array.isArray(b) ? b : (b && b.sequence) ? b.sequence : [b], ctx, out);
        }
        continue;
      }

      const call = step.action || step.service;

      /* A device automation step: `type: turn_on` with a device id and an
         entity *registry* id rather than a service name. */
      if (!call && step.type && step.device_id) {
        const ent = ctx.byRegistryId[step.entity_id] || null;
        addTarget(out, ent || ('device:' + step.device_id), (step.domain || 'device') + '.' + step.type, !ent);
        continue;
      }

      if (typeof call !== 'string' || isTemplate(call)) continue;

      const dot = call.indexOf('.');
      const domain = dot > 0 ? call.slice(0, dot) : call;
      const service = dot > 0 ? call.slice(dot + 1) : '';

      /* Following a script call means its targets belong to this run too. */
      if (domain === 'script' && service && service !== 'turn_off') {
        const target = 'script.' + service;
        if (ctx.stack.indexOf(target) < 0 && ctx.depth < ctx.limits.max_script_depth) {
          const script = ctx.scripts[target];
          if (script && script.config) {
            collectTargets(script.config.sequence, {
              scripts: ctx.scripts, limits: ctx.limits, byDevice: ctx.byDevice,
              byRegistryId: ctx.byRegistryId, stack: ctx.stack.concat(target),
              depth: ctx.depth + 1, triggerId: null,
              timers: ctx.timers, hass: ctx.hass,
            }, out);
          }
        }
        addTarget(out, target, call, false);
        continue;
      }

      const ents = targetEntities(step, ctx);
      for (const e of ents) addTarget(out, e.id, call, e.unresolved);
    }
    return out;
  }

  function addTarget(out, id, service, unresolved) {
    if (!id) return;
    if (unresolved) {
      if (out.unresolved.indexOf(id) < 0) out.unresolved.push(id);
      return;
    }
    if (!out.entities.has(id)) out.entities.set(id, new Set());
    out.entities.get(id).add(service);
  }

  /** The entities a single service call aims at, as far as is knowable. */
  function targetEntities(step, ctx) {
    const found = [];
    const push = (v, unresolved) => {
      if (typeof v !== 'string' || !v || isTemplate(v)) return;
      found.push({ id: v, unresolved: !!unresolved });
    };
    const walk = (t) => {
      if (!t) return;
      if (typeof t === 'string') return push(t);
      if (Array.isArray(t)) { t.forEach(walk); return; }
      if (typeof t !== 'object') return;
      if (t.entity_id) walk(t.entity_id);
      if (t.device_id) {
        const ids = Array.isArray(t.device_id) ? t.device_id : [t.device_id];
        for (const d of ids) {
          const ents = ctx.byDevice[d];
          if (ents && ents.length) ents.forEach((e) => push(e));
          else push('device:' + d, true);
        }
      }
      /* An area or label target expands to whatever is in it at run time.
         Membership is knowable, but treating it as an exact target would
         overstate the certainty, so it is recorded as unresolved. */
      if (t.area_id) [].concat(t.area_id).forEach((a) => push('area:' + a, true));
      if (t.label_id) [].concat(t.label_id).forEach((l) => push('label:' + l, true));
      if (t.floor_id) [].concat(t.floor_id).forEach((f) => push('floor:' + f, true));
    };
    walk(step.target);
    walk(step.entity_id);
    if (step.data) { walk(step.data.entity_id); walk(step.data.target); }
    return found;
  }

  /* ---------------------------------------------------------------- *
   * Runs
   * ---------------------------------------------------------------- */

  /**
   * One scheduled run: a start time, an estimated length, and what it commands.
   *
   * A run is derived per *trigger*, not per automation, because an automation
   * with seven time triggers has seven different schedules and - when its
   * branches are gated on the trigger id - seven different bodies.
   */
  function buildRuns(automations, ctx, hass) {
    const runs = [];
    const dynamic = [];
    const unanalysable = [];
    const tooShort = [];

    for (const auto of automations) {
      const config = auto && auto.config;
      if (!config || config.__error) {
        unanalysable.push({ entityId: auto && auto.entityId, name: auto && auto.name, reason: 'configuration not readable' });
        continue;
      }
      const triggers = [].concat(config.triggers || config.trigger || []);
      const mode = config.mode || 'single';

      triggers.forEach((trig, index) => {
        if (!trig || typeof trig !== 'object') return;
        const occ = triggerOccurrences(trig, hass);
        const label = trig.alias || trig.id || ('Trigger #' + (index + 1));

        if (occ.disabled) return;
        if (occ.dynamic) {
          dynamic.push({
            entityId: auto.entityId, name: auto.name, label: label, kind: occ.kind || 'unknown',
          });
          return;
        }
        if (!occ.times.length) {
          unanalysable.push({
            entityId: auto.entityId, name: auto.name, label: label,
            reason: occ.note || (occ.tooDense ? 'fires too often to schedule' : 'no readable time'),
          });
          return;
        }

        /* The body is resolved per trigger id, so a trigger-gated `choose`
           contributes only the branch this trigger can actually reach. */
        const runCtx = {
          scripts: ctx.scripts, limits: ctx.limits, byDevice: ctx.byDevice,
          byRegistryId: ctx.byRegistryId, stack: [], depth: 0,
          triggerId: trig.id || null,
          /* Fresh per run: one trigger's timer settings say nothing about
             another's. */
          timers: new Map(), hass: hass,
        };
        const actions = config.actions || config.action || [];
        const duration = sequenceDuration(actions, runCtx);
        const targets = collectTargets(actions, runCtx, null);

        /* Over before anything could collide with it. Counted so the page can
           say how many were set aside rather than quietly dropping them. */
        if (duration.max / 60 < ctx.limits.min_runtime_minutes) {
          tooShort.push({ entityId: auto.entityId, name: auto.name, label: label });
          return;
        }

        for (const startMin of occ.times) {
          runs.push({
            entityId: auto.entityId,
            automationId: auto.id || (config && config.id) || null,
            name: auto.name,
            mode: mode,
            triggerLabel: label,
            triggerId: trig.id || null,
            triggerKind: occ.kind,
            triggerIndex: index,
            start: startMin,
            duration: duration,
            /* The ceiling is what matters for an overlap: the question is
               whether the run *can* still be going when the next one starts. */
            end: startMin + duration.max / 60,
            targets: targets,
            approximate: !!occ.approximate,
            recurringPattern: !!occ.recurringPattern,
            note: occ.note,
          });
        }
      });
    }
    return { runs: runs, dynamic: dynamic, unanalysable: unanalysable, tooShort: tooShort };
  }

  /* ---------------------------------------------------------------- *
   * Pairing and severity
   * ---------------------------------------------------------------- */

  /**
   * How many minutes the two runs are actually both in progress, allowing for a
   * run that crosses midnight. Zero or less means no overlap.
   *
   * This is a true interval intersection rather than "does A's end reach B's
   * start", because the two are not the same when both runs begin in the same
   * minute: measuring from one end only would give a different answer depending
   * on which run happened to be called first.
   */
  function overlapMinutes(a, b) {
    const shift = b.start < a.start ? DAY_MIN : 0;
    const bStart = b.start + shift;
    const bEnd = b.end + shift;
    return Math.min(a.end, bEnd) - Math.max(a.start, bStart);
  }

  /**
   * How far before the first run's estimated finish the second one tries to
   * start. This is a different question from how long the two overlap, and it
   * is the one that matters when a run is going to be rejected outright: a
   * ten-minute automation triggering 55 minutes early is 55 minutes early, no
   * matter that it would only have run for ten.
   */
  function encroachMinutes(a, b) {
    const shift = b.start < a.start ? DAY_MIN : 0;
    return a.end - (b.start + shift);
  }

  /** Distance between two starts, the short way round the clock. */
  function clockGap(a, b) {
    const raw = Math.abs(a.start - b.start);
    return Math.min(raw, DAY_MIN - raw);
  }

  /**
   * What the two runs have in common. Shared targets are the difference
   * between "two things happened at once" and "two things fought".
   */
  function sharedTargets(a, b) {
    const shared = [];
    let opposing = null;
    a.targets.entities.forEach((servicesA, id) => {
      const servicesB = b.targets.entities.get(id);
      if (!servicesB) return;
      const sa = Array.from(servicesA);
      const sb = Array.from(servicesB);
      const entry = { id: id, services: Array.from(new Set(sa.concat(sb))), opposing: false };
      for (const x of sa) {
        for (const y of sb) {
          if (areOpposites(x, y)) { entry.opposing = true; opposing = { id: id, a: x, b: y }; }
        }
      }
      shared.push(entry);
    });
    return { list: shared, opposing: opposing };
  }

  const MODE_NOTE = {
    single: 'Home Assistant drops the second run while the first is still going, so it simply does not happen.',
    restart: 'The second trigger cancels the run in progress and starts again from the top, so the rest of the first run is abandoned.',
    queued: 'The second run waits for the first to finish, so it starts late rather than on time.',
    parallel: 'Both runs execute at once.',
  };

  /**
   * Severity, in the order the evidence actually justifies.
   *
   * The floor is deliberately low: two runs overlapping with nothing in common
   * is information, not a fault. It climbs only with real evidence - a mode
   * that drops or cancels runs, a shared target, opposing commands on it.
   */
  function scoreConflict(a, b, overlap, encroach, shared) {
    const mode = a.mode;
    const sameAutomation = a.entityId === b.entityId;
    const reasons = [];
    let severity = 'info';

    if (overlap > 0) {
      if (sameAutomation && mode === 'single') {
        severity = 'critical';
        reasons.push('The automation is `mode: single` and its own next trigger arrives ' +
          formatMins(encroach) + ' before this run is estimated to finish. ' + MODE_NOTE.single);
      } else if (mode === 'single' && sameAutomation === false) {
        /* Different automations do not block each other, whatever their mode. */
        severity = shared.list.length ? 'warning' : 'info';
        reasons.push('The runs overlap by ' + formatMins(overlap) + '. Separate automations do not block one another, so both will run.');
      } else if (sameAutomation && mode === 'restart') {
        severity = 'warning';
        reasons.push('The automation is `mode: restart` and re-triggers ' + formatMins(encroach) +
          ' before this run is estimated to finish. ' + MODE_NOTE.restart);
      } else if (sameAutomation && mode === 'queued') {
        severity = 'warning';
        reasons.push('The automation is `mode: queued`, so the second run is delayed by up to ' +
          formatMins(encroach) + ' rather than starting on time.');
      } else if (sameAutomation && mode === 'parallel') {
        severity = shared.list.length ? 'warning' : 'info';
        reasons.push('The automation is `mode: parallel`, so both runs execute at once.');
      } else {
        reasons.push('The runs overlap by ' + formatMins(overlap) + '.');
      }
    } else {
      reasons.push('The triggers are ' + formatMins(clockGap(a, b)) + ' apart; neither run is estimated to still be going when the other starts.');
    }

    /* Shared targets are what turn a coincidence into a conflict. */
    if (shared.list.length && overlap > 0) {
      if (shared.opposing) {
        severity = 'critical';
        reasons.push('Both runs command `' + shared.opposing.id + '` while overlapping, and `' +
          shared.opposing.a + '` and `' + shared.opposing.b + '` undo each other.');
      } else if (severity === 'info') {
        severity = 'warning';
        reasons.push('Both runs command ' + shared.list.length +
          (shared.list.length === 1 ? ' shared entity' : ' shared entities') + ' while overlapping.');
      } else {
        reasons.push('Both runs command ' + shared.list.length +
          (shared.list.length === 1 ? ' shared entity' : ' shared entities') + ' while overlapping.');
      }
    }

    return { severity: severity, reasons: reasons };
  }

  function formatMins(mins) {
    const m = Math.round(mins);
    if (m < 1) return 'under a minute';
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return h + 'h' + (rest ? ' ' + rest + 'm' : '');
  }

  /* ---------------------------------------------------------------- *
   * The analysis
   * ---------------------------------------------------------------- */

  /**
   * Compares every analysable scheduled run against every other and reports
   * the pairs that can get in each other's way.
   *
   * Times are handled as minutes past midnight rather than as dates, which is
   * what makes a daily collision one finding instead of one per day.
   */
  function analyseConflicts(sources, index, hass, cfg) {
    const limits = Object.assign({}, DEFAULT_CONFLICTS, (cfg && cfg.conflicts) || {});

    const scripts = {};
    for (const s of sources.scripts || []) scripts[s.entityId] = s;

    /* Device id -> its entity ids, and entity registry id -> entity id, so a
       device-targeted action and an entity-targeted one on the same thing are
       recognised as the same target. */
    const byDevice = {};
    const byRegistryId = {};
    for (const reg of (index && index.registryList) || []) {
      if (reg.device_id) {
        if (!byDevice[reg.device_id]) byDevice[reg.device_id] = [];
        byDevice[reg.device_id].push(reg.entity_id);
      }
      if (reg.id) byRegistryId[reg.id] = reg.entity_id;
    }

    const built = buildRuns(sources.automations || [], { scripts: scripts, limits: limits, byDevice: byDevice, byRegistryId: byRegistryId }, hass);
    const runs = built.runs;

    const conflicts = [];
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const pair = orderRuns(runs[i], runs[j]);
        const first = pair[0];
        const second = pair[1];

        /* A run never conflicts with itself. */
        if (first === second) continue;
        if (first.entityId === second.entityId &&
            first.triggerIndex === second.triggerIndex &&
            first.start === second.start) continue;

        const overlap = overlapMinutes(first, second);
        const encroach = encroachMinutes(first, second);
        const gap = clockGap(first, second);
        const near = gap <= limits.near_minutes;

        if (overlap <= 0 && !near) continue;

        /* An unknown runtime cannot prove an overlap. A near-collision still
           stands on its own, because it needs no runtime at all. */
        if (overlap > 0 && first.duration.unknown && first.duration.max === 0) {
          if (!near) continue;
        }

        const shared = sharedTargets(first, second);
        const scored = scoreConflict(first, second, overlap, encroach, shared);

        conflicts.push({
          key: [first.entityId, first.triggerIndex, first.start, second.entityId, second.triggerIndex, second.start].join('|'),
          severity: scored.severity,
          reasons: scored.reasons,
          internal: first.entityId === second.entityId,
          exact: Math.abs(gap) < 0.5,
          near: near && overlap <= 0,
          overlap: overlap > 0 ? overlap : 0,
          /* How early the second trigger is - the number that matters when the
             run is going to be dropped or restarted. */
          encroach: encroach > 0 ? encroach : 0,
          gap: gap,
          shared: shared.list,
          opposing: shared.opposing,
          first: runSummary(first),
          second: runSummary(second),
          approximate: first.approximate || second.approximate,
          runtimeUnknown: first.duration.unknown || second.duration.unknown,
          runtimeReasons: Array.from(new Set(first.duration.reasons.concat(second.duration.reasons))),
        });
      }
    }

    /* Worst first, then the biggest overlap, then by time so the order is
       stable between scans. */
    const rank = { critical: 0, warning: 1, info: 2 };
    conflicts.sort((x, y) =>
      rank[x.severity] - rank[y.severity] ||
      y.overlap - x.overlap ||
      x.first.start - y.first.start);

    const counts = { critical: 0, warning: 0, info: 0 };
    for (const c of conflicts) counts[c.severity]++;

    return {
      ready: true,
      analysedAt: Date.now(),
      conflicts: conflicts,
      counts: counts,
      /* Only these two are worth interrupting someone's main dashboard for. */
      actionable: counts.critical + counts.warning,
      scanned: {
        automations: (sources.automations || []).length,
        runs: runs.length,
        dynamic: built.dynamic.length,
        unanalysable: built.unanalysable.length,
        tooShort: built.tooShort.length,
      },
      dynamic: built.dynamic,
      unanalysable: built.unanalysable,
      tooShort: built.tooShort,
      runs: runs.map(runSummary),
    };
  }

  /** Earlier start first, so "first" and "second" mean what they say. */
  function orderRuns(a, b) {
    if (a.start < b.start) return [a, b];
    if (b.start < a.start) return [b, a];
    /* Same minute: keep a stable order so the key does not flip between scans. */
    return a.entityId <= b.entityId ? [a, b] : [b, a];
  }

  function runSummary(run) {
    return {
      entityId: run.entityId,
      automationId: run.automationId,
      name: run.name,
      mode: run.mode,
      triggerLabel: run.triggerLabel,
      triggerId: run.triggerId,
      triggerKind: run.triggerKind,
      start: run.start,
      startClock: minutesToClock(run.start),
      endClock: minutesToClock(run.end),
      durationMin: run.duration.max / 60,
      durationMinFloor: run.duration.min / 60,
      durationUnknown: run.duration.unknown,
      /* Derived from something real - a timer's configured length - rather than
         read straight off a delay, and labelled so on the card. */
      durationEstimated: !!run.duration.estimated,
      durationReasons: Array.from(new Set(run.duration.reasons)),
      targetCount: run.targets.entities.size,
      targets: Array.from(run.targets.entities.keys()),
      unresolvedTargets: run.targets.unresolved,
      approximate: run.approximate,
      note: run.note,
    };
  }

  /**
   * Gathers everything and runs the inspection. The full entity registry is
   * fetched here rather than reused from `hass.entities`, because the
   * frontend's copy is the display registry and has disabled entities removed -
   * which is precisely the distinction the inspector needs to make.
   */
  /**
   * The file scanner's dependency universe.
   *
   * A service response rather than a state attribute: several hundred edges do
   * not belong in the state machine. Absent pyscript, or an older backend, this
   * simply answers null and the card carries on with what the browser can see.
   */
  async function fetchFileDeps(hass) {
    try {
      const res = await hass.callWS({
        type: 'call_service', domain: 'pyscript', service: 'config_health_deps',
        service_data: {}, return_response: true,
      });
      const payload = (res && res.response) || res || null;
      return payload && Array.isArray(payload.deps) ? payload : null;
    } catch (e) {
      return null;
    }
  }

  async function scanConfiguration(hass, cfg) {
    const [registry, resources, automations, scripts, scenes, dashboards, fileDeps] = await Promise.all([
      hass.callWS({ type: 'config/entity_registry/list' }).catch(() => null),
      hass.callWS({ type: 'lovelace/resources' }).catch(() => []),
      fetchScriptLike(hass, 'automation', 'automation/config'),
      fetchScriptLike(hass, 'script', 'script/config'),
      fetchScenes(hass),
      fetchDashboards(hass),
      fetchFileDeps(hass),
    ]);

    const sources = { automations, scripts, scenes, dashboards, resources };
    const model = inspectSources(hass, cfg, sources, registry);
    /* Kept so a registry change can be answered by re-judging what is already
       in hand rather than by 132 fresh round trips. */
    model.sources = sources;
    model.registry = registry;
    if (fileDeps) mergeFileDeps(model, fileDeps);
    mergeFileMissing(model, backendMissing(hass));
    /* The conflict analysis rides the same fetch: every automation and script
       configuration it needs has just been read for the inspector, so this
       costs no extra round trips. */
    model.conflicts = analyseConflicts({ automations, scripts }, model.index, hass, cfg);
    model.scannedAt = Date.now();
    return model;
  }

  /** The pure half of a scan: everything after the fetching. */
  function inspectSources(hass, cfg, sources, registry) {
    const index = buildIndex(hass, { registry, manifests: cfg.manifests });
    index.registryList = registry || [];
    const model = inspectConfiguration(sources, index, {
      isDefined: (tag) => !!window.customElements.get(tag),
    });
    model.hasRegistry = !!registry;
    return model;
  }

  /**
   * Re-judge the configuration already in hand against a fresh registry.
   *
   * Deleting, renaming, disabling or re-enabling an entity changes what every
   * reference means without changing a single line of configuration, so the
   * fetched sources are still good and only the existence index is stale.
   * Re-inspecting them costs one round trip and about fifteen milliseconds,
   * against three quarters of a second for a full rescan.
   */
  async function reinspectConfiguration(hass, cfg, previous, opts) {
    if (!previous || !previous.sources) return null;
    const o = opts || {};
    const [registry, fresh] = await Promise.all([
      hass.callWS({ type: 'config/entity_registry/list' }).catch(() => previous.registry),
      o.refetchDeps ? fetchFileDeps(hass) : Promise.resolve(null),
    ]);
    const model = inspectSources(hass, cfg, previous.sources, registry);
    model.sources = previous.sources;
    model.registry = registry;
    const deps = fresh || previous.fileDeps;
    if (deps) mergeFileDeps(model, deps);
    mergeFileMissing(model, backendMissing(hass));
    model.conflicts = previous.conflicts;
    model.scannedAt = previous.scannedAt;
    model.reinspectedAt = Date.now();
    model.ready = true;
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

  /**
   * The conflicts tile. Only critical and warning raise it: an `info` finding
   * is a schedule that happens to coincide, which is worth knowing on the full
   * page and is emphatically not worth a red tile on a main dashboard.
   */
  function conflictsCompact(con) {
    if (!con || !con.ready || !con.counts) return null;
    const c = con.counts;
    if (!c.critical && !c.warning) return null;

    const worst = con.conflicts.find((x) => x.severity === 'critical')
      || con.conflicts.find((x) => x.severity === 'warning');
    const bits = [];
    if (c.critical) bits.push(c.critical + ' critical');
    if (c.warning) bits.push(c.warning + ' warning');

    return {
      band: c.critical ? 'critical' : 'warn',
      icon: 'mdi:calendar-alert',
      count: c.critical + c.warning,
      label: 'Conflicts',
      /* The worst one by name, because "2 critical" tells you there is a
         problem and this tells you where to look. */
      detail: worst
        ? worst.first.name + ' · ' + worst.first.startClock + ' ↔ ' + worst.second.startClock
        : bits.join(' · '),
    };
  }


  /**
   * One card for the whole house, for a main dashboard.
   *
   * Three separate tiles answered three questions, which is right on the Health
   * page and wrong on a dashboard you only glance at. What belongs there is a
   * verdict and a short list of what is behind it, grouped the same way the
   * Health page groups them - devices, configuration, conflicts - so the list
   * reads as a table of contents for the page it links to.
   *
   * Only groups with something in them appear, and the card is absent entirely
   * while everything is fine. A list of zeroes is what makes a status card
   * ignorable.
   */
  function overallCompact(model) {
    const c = model.counts || {};
    const conf = model.config;
    const con = model.conflicts;

    const num = (v) => v || 0;
    const line = (n, one, many) => n + ' ' + (n === 1 ? one : many);

    const groups = [];

    const device = [];
    if (num(c.offline)) device.push(line(c.offline, 'offline', 'offline'));
    if (num(c.degraded)) device.push(line(c.degraded, 'degraded', 'degraded'));
    if (num(c.unknown)) device.push(line(c.unknown, 'unknown', 'unknown'));
    if (num(c.lowBattery)) device.push(line(c.lowBattery, 'low battery', 'low batteries'));
    if (device.length) {
      groups.push({
        key: 'devices', label: 'Devices', items: device,
        band: c.offline ? 'critical' : c.degraded ? 'warn' : c.unknown ? 'unknown' : 'battery',
        serious: num(c.offline),
      });
    }

    const cfg = [];
    if (conf && conf.counts) {
      if (num(conf.counts.brokenItems)) cfg.push(line(conf.counts.brokenItems, 'broken item', 'broken items'));
      /* Impaired belongs here too: an automation that cannot run today is a
         thing the dashboard should say out loud, and leaving it off made the
         tile disagree with the page it links to. Distinguished from broken by
         the band, and never counted as serious - the configuration is sound. */
      if (num(conf.counts.impairedItems)) cfg.push(line(conf.counts.impairedItems, 'impaired item', 'impaired items'));
      /* Warnings ride along when the tile is up for a real reason, but never
         raise it on their own: a disabled entity somebody meant to disable is
         not a thing to interrupt the main dashboard for. Ignored findings are
         already absent from every one of these counters. */
      if (cfg.length && num(conf.counts.warnings)) {
        cfg.push(line(conf.counts.warnings, 'warning', 'warnings'));
      }
    }
    if (cfg.length) {
      groups.push({
        key: 'config', label: 'Configuration', items: cfg,
        band: conf.counts.brokenItems ? 'critical' : conf.counts.impairedItems ? 'impaired' : 'warn',
        serious: num(conf.counts.brokenItems),
      });
    }

    /* The operational groups. Each has one rule for reaching a main
       dashboard, and each rule is deliberately narrower than what the full
       page shows: a repair, a supervisor note or a device at 96% belongs on
       the Health page and nowhere else. */
    const ops = model.ops;
    const opsItems = [];
    if (ops) {
      /* Only what is happening now. `pending` is honest on the page and
         silent on a main dashboard: it is a prompt to look, not an alarm. */
      const failing = ops.execution.filter((e) => (e.status || e.severity) === 'actionable');
      if (failing.length) {
        opsItems.push(line(failing.length, 'automation failing', 'automations failing'));
      }
      const addons = ops.system.filter((x) => x.kind === 'addon' && x.severity === 'actionable');
      if (addons.length) opsItems.push(line(addons.length, 'add-on down', 'add-ons down'));
      const backup = ops.system.filter(
        (x) => x.kind === 'backup' && (x.severity === 'actionable' || x.severity === 'critical'));
      if (backup.length) opsItems.push('backup stale');
      const integ = ops.integrations.filter((i) => (i.status || i.severity) === 'critical');
      if (integ.length) opsItems.push(line(integ.length, 'integration failing', 'integrations failing'));
    }
    if (opsItems.length) {
      groups.push({
        key: 'system', label: 'System', items: opsItems,
        band: 'critical', serious: true,
      });
    }

    /* A device that spent a fifth of the day unreachable is worth the main
       dashboard; one at 96% is not, and neither is a weak radio link. */
    const un = model.unstable;
    if (un && un.devices) {
      /* Only a device that is unstable NOW. `recovered` is a band of its own,
         so a bad day that ended two hours ago cannot reach a main dashboard,
         and neither can an hour of commissioning - those transitions never
         became a band at all. */
      const bad = un.devices.filter(
        (r) => unstableBand(r) === 'critical' &&
          !(r.deviceId && model.skipped && model.skipped.has(r.deviceId)));
      if (bad.length) {
        groups.push({
          key: 'unstable', label: 'Unstable', items: [line(bad.length, 'device', 'devices') + ' below 80% today'],
          band: 'critical', serious: true,
        });
      }
    }

    const clash = [];
    if (con && con.counts) {
      if (num(con.counts.critical)) clash.push(line(con.counts.critical, 'critical', 'critical'));
      if (num(con.counts.warning)) clash.push(line(con.counts.warning, 'warning', 'warnings'));
    }
    if (clash.length) {
      groups.push({
        key: 'conflicts', label: 'Conflicts', items: clash,
        band: con.counts.critical ? 'critical' : 'warn',
        serious: num(con.counts.critical),
      });
    }

    if (!groups.length) return null;

    /* Anything that stops something working outright earns the stronger word;
       the rest is worth knowing but not worth alarm. */
    const serious = groups.some((g) => g.serious);
    const look = HOUSE_STATES[serious ? 'critical' : 'warn'];

    return {
      band: look.band,
      icon: look.icon,
      word: look.word,
      groups: groups,
      total: groups.reduce((sum, g) => sum + g.items.length, 0),
    };
  }

  function overallHtml(view, nav) {
    const tag = nav ? 'button' : 'div';
    return (
      '<ha-card class="mini overall">' +
      '<' + tag + ' class="ocard band-' + view.band + (nav ? ' is-tappable' : '') + '"' +
      (nav ? ' type="button" data-nav="' + esc(nav) + '"' : '') + '>' +
      '<div class="ohead">' +
      '<ha-icon class="hicon" icon="' + esc(view.icon) + '"></ha-icon>' +
      '<span class="hword">' + esc(view.word) + '</span>' +
      '</div>' +
      '<div class="ogroups">' +
      view.groups.map((g) =>
        '<div class="ogroup band-' + g.band + '">' +
        '<span class="odot"></span>' +
        '<span class="olabel">' + esc(g.label) + '</span>' +
        '<span class="oitems">' + esc(g.items.join(' · ')) + '</span>' +
        '</div>').join('') +
      '</div>' +
      '</' + tag + '></ha-card>'
    );
  }

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

  /* The order tiles are filled in when one has to be borrowed to complete a
     row. Devices first because it is the one people look at without being
     prompted. */
  const COMPACT_ORDER = ['device-compact', 'configuration-compact', 'conflicts-compact'];

  /**
   * Which of the group's tiles are on screen.
   *
   * A tile takes half a row, so a lone one leaves the other half to whatever
   * unrelated card follows it. The group therefore shows an even two: every
   * tile that has something to report, and - if that is only one - the next
   * quiet tile to fill the row beside it. A third quiet tile would only add an
   * orphaned half-row of its own, so it stays away.
   *
   * When all of them have something to say, all of them are shown: dropping one
   * to keep the row tidy would be hiding a real problem.
   */
  function visibleCompactModes() {
    const present = COMPACT_ORDER.filter((mode) =>
      [...compactPeers].some((card) => card._config && card._config.mode === mode));
    const shown = new Set(
      present.filter((mode) =>
        [...compactPeers].some((card) => card._config && card._config.mode === mode && card._compactHasProblem))
    );
    if (!shown.size) return shown;
    for (const mode of present) {
      if (shown.size >= 2) break;
      shown.add(mode);
    }
    return shown;
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
    if (mode === 'conflicts-compact') {
      const con = model.conflicts;
      return {
        zero: true, band: 'ok', icon: 'mdi:calendar-check', count: 0,
        label: 'Conflicts',
        detail: con && con.ready ? 'No schedule clashes' : 'Checking…',
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

  /**
   * The operational entities the backend publishes, if it is publishing.
   *
   * Read like any other entity: they are real registry entities over MQTT, not
   * a private channel. Absent them - no pyscript, no broker - the page simply
   * does not show the line, which is what it did before they existed.
   */
  const OPS_STATUS = 'sensor.config_health_status';
  const OPS_LAST_SCAN = 'sensor.config_health_last_scan';

  function opsInfo(hass) {
    const st = hass && hass.states && hass.states[OPS_STATUS];
    if (!st || st.state === 'unavailable' || st.state === 'unknown') return null;
    const a = st.attributes || {};
    const scan = hass.states[OPS_LAST_SCAN];
    let when = null;
    if (scan && scan.state && scan.state !== 'unknown' && scan.state !== 'unavailable') {
      const d = new Date(scan.state);
      if (!isNaN(d)) {
        const today = new Date();
        const sameDay = d.toDateString() === today.toDateString();
        when = (sameDay ? '' : d.toLocaleDateString() + ' ') +
          String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      }
    }
    return {
      status: st.state,
      lastScan: when,
      /* "2026-08-27 04:17" reads better here as just the time when it is
         tomorrow anyway, which it always is after the nightly run. */
      next: a.next_scheduled_scan ? String(a.next_scheduled_scan).slice(11) : null,
      lastSuccessful: a.last_successful_scan || null,
      error: st.state === 'error' ? (a.error || 'scan failed') : null,
    };
  }

  function configCompact(conf, ops) {
    /* An automation that is failing right now outranks anything a reference
       scan can find, so it is tested before the scan is even consulted - and
       it shows on an install whose configuration is otherwise spotless,
       which is exactly the case that went unnoticed. Only currently
       recurring incidents qualify: a recovered one is history, and history
       does not belong on a main dashboard. */
    const failing = ops ? ops.execution.filter((e) => (e.status || e.severity) === 'actionable') : [];
    if (failing.length) {
      const worst = failing[0];
      return {
        band: 'critical',
        icon: 'mdi:play-box-remove-outline',
        count: failing.length,
        label: failing.length === 1 ? 'Failing' : 'Failing',
        detail: failing.length === 1
          ? worst.name + ' · ' + worst.failures + ' failed action' +
            (worst.failures === 1 ? '' : 's') + ' · latest ' + String(worst.last || '').slice(11, 16)
          : failing.length + ' automations failing · ' +
            failing.reduce((n, e) => n + e.failures, 0) + ' failed actions',
      };
    }

    /* `ready` is stamped on by the card's cache layer, so its absence just
       means the inspector was called directly; only an explicit false is a
       scan that failed, and a failed scan has nothing to report. */
    if (!conf || conf.ready === false || !conf.counts) return null;

    /* The items, not the cards: one grouped "32 automations failed to load"
       card stands for 32 broken automations, and the tile has to agree with
       the counter on the full page. */
    const broken = conf.items.filter((i) => i.verified);
    /* Impaired earns the tile too. An automation that cannot run today is
       worth a glance from the main dashboard, and a page that says so while
       the tile stays hidden is a page nobody trusts. Warnings and ignored
       findings deliberately do not: neither is something to do now. */
    const impaired = conf.items.filter((i) => i.impaired && !i.verified);
    if (!broken.length && !impaired.length) return null;

    if (!broken.length) {
      const byImpaired = new Map();
      for (const i of impaired) byImpaired.set(i.type, (byImpaired.get(i.type) || 0) + 1);
      const bits = [...byImpaired.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, n]) => {
          const label = (COMPACT_CONFIG_WORD[type] || COMPACT_CONFIG_WORD.other)[1].toLowerCase();
          return n + ' ' + (n === 1 ? label.replace(/s$/, '') : label);
        });
      return {
        band: 'impaired',
        icon: 'mdi:cog-clockwise',
        count: impaired.length,
        label: 'Config',
        detail: bits.join(' · ') + ' impaired',
      };
    }

    const byType = new Map();
    for (const i of broken) byType.set(i.type, (byType.get(i.type) || 0) + 1);
    const alsoImpaired = impaired.length ? ' · ' + impaired.length + ' impaired' : '';

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
        detail: only.name + (first ? ' · ' + shortIssue(first) : '') + alsoImpaired,
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
      detail: bits.join(' · ') + alsoImpaired,
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

  /* Severity, not type. The section below already groups by type, and the
     DEVICE STATUS strip directly above reads as a severity ladder - matching it
     keeps one language on the page instead of two. */
  const CONFIG_PILLS = [
    { key: 'brokenItems', label: 'Broken', icon: 'mdi:close-octagon-outline', band: 'critical',
      note: 'references gone' },
    { key: 'impairedItems', label: 'Impaired', icon: 'mdi:progress-alert', band: 'impaired',
      note: 'cannot run now' },
    { key: 'warnings', label: 'Warnings', icon: 'mdi:alert-outline', band: 'unknown',
      note: 'worth a look' },
    { key: 'ignoredItems', label: 'Ignored', icon: 'mdi:eye-off-outline', band: 'ok',
      note: 'accepted' },
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
      '<div class="pill pill-wrap band-' + p.band + ((c[p.key] || 0) ? '' : ' is-zero') + '">' +
      '<ha-icon icon="' + p.icon + '"></ha-icon>' +
      '<span class="pnum">' + (c[p.key] || 0) + '</span>' +
      '<span class="plabel">' + p.label + '</span>' +
      '<span class="pnote">' + esc(p.note) + '</span></div>'
    ).join('');

    /* The subtitle is the coverage claim, and it has to be honest: an item
       whose configuration could not be read was counted as scanned but not
       actually inspected, and saying so is the difference between a clean
       result and a silent blind spot. */
    const sub = s.automation + ' automations · ' + s.script + ' scripts · ' +
      s.scene + ' scenes · ' + s.cards + ' cards';

    const extra = [];
    /* The severity pills lost the per-type breakdown, so it lands here where
       it costs no height. Only the types that actually have something. */
    const byType = [];
    const typeLine = (n, word) => { if (n) byType.push(n + ' ' + word + (n === 1 ? '' : 's')); };
    typeLine(c.brokenAutomations + c.impairedAutomations, 'automation');
    typeLine(c.brokenScripts + c.impairedScripts, 'script');
    typeLine(c.brokenScenes + c.impairedScenes, 'scene');
    typeLine(c.dashboardProblems + c.impairedDashboards, 'dashboard');
    if (byType.length) extra.push(byType.join(', '));
    if (c.unvalidated) extra.push(c.unvalidated + ' dynamic reference' + (c.unvalidated === 1 ? '' : 's') + ' not checkable');
    if (!conf.hasRegistry) extra.push('entity registry unavailable — findings downgraded');
    /* When the backend scan is answering, say when it last ran and when it
       runs next. On the line that already exists - a status panel would push
       the actual findings further down the page for no gain. A failed scan is
       not an aside, so that one joins the main list. */
    const ops = opsInfo(conf.hass);
    if (ops && ops.error) extra.push('last scan failed · ' + ops.error);
    const opsNote = ops
      ? (ops.lastScan ? '<span class="opswhen">scanned ' + esc(ops.lastScan) + '</span>' : '') +
        (ops.next ? '<span class="opsnext">next ' + esc(ops.next) + '</span>' : '')
      : '';

    return sectionHtml(
      'Configuration health', sub,
      '<div class="pills pills-config">' + pills + '</div>' +
      '<div class="confnote">' +
      '<span>' + esc(extra.join(' · ')) + opsNote + '</span>' +
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
    /* Owners only the file scanner can see: a YAML package or an included
       file, and a helper defined by a config entry. */
    yaml: { label: 'YAML file', icon: 'mdi:file-code-outline' },
    helper: { label: 'Helper', icon: 'mdi:tune-variant' },
    other: { label: 'Configuration', icon: 'mdi:cog-outline' },
  };

  /* Severity first, then type, in one wrapping row - the same shape the
     device section uses, so the page has one idea of what a filter looks
     like. A chip that matches nothing is never rendered. */
  const CONFIG_CHIPS = [
    { id: 'all', label: 'All' },
    { id: 'sev:broken', label: 'Broken', match: (p) => p.verified > 0 },
    { id: 'sev:impaired', label: 'Impaired', match: (p) => !p.verified && p.impaired > 0 },
    { id: 'sev:warning', label: 'Warnings', match: (p) => !p.verified && !p.impaired && p.warnings > 0 },
    { id: 'automation', label: 'Automations' },
    { id: 'script', label: 'Scripts' },
    { id: 'scene', label: 'Scenes' },
    { id: 'dashboard', label: 'Dashboards' },
    { id: 'other', label: 'Other' },
  ];

  function configChipMatches(p, id) {
    if (id === 'all') return true;
    const chip = CONFIG_CHIPS.find((c) => c.id === id);
    if (chip && chip.match) return chip.match(p);
    return p.type === id;
  }

  const CONFIDENCE_DOT = {
    verified: '🔴', impaired: '🟠', warning: '🟡', unvalidated: '⚪',
  };

  /** The identity a finding is armed by, stable across a re-render. */
  function issueKey(item, issue) {
    return item.key + '|' + issue.kind + '|' + (issue.ref == null ? '' : issue.ref) + '|' + (issue.location || '');
  }

  function issueHtml(issue, item, state, conf) {
    /* Ignoring is offered on the full page only, and only for findings that
       are actually being counted - there is nothing to dismiss about a
       reference the inspector has already said it could not check. */
    const armable = item && state && conf && issue.confidence !== 'unvalidated';
    const key = armable ? issueKey(item, issue) : null;
    const armed = armable && state.ignoring === key;
    return (
      '<div class="issue is-' + issue.confidence + '">' +
      '<span class="idot">' + CONFIDENCE_DOT[issue.confidence] + '</span>' +
      '<span class="itext"><span class="imsg">' + esc(issue.message) + '</span>' +
      '<span class="iloc">' + esc(issue.location) + '</span>' +
      (issue.renamedTo
        ? '<span class="ihint">Possible renamed entity: ' + esc(issue.renamedTo) + '</span>'
        : '') +
      (issue.note ? '<span class="ihint">' + esc(issue.note) + '</span>' : '') +
      /* The other half of the page already knows why this entity is silent.
         Naming the device here is what turns two lists into one diagnosis. */
      (issue.device
        ? '<span class="ihint idev">Device: <button class="devlink" type="button" data-device="' +
          esc(issue.device.deviceId) + '">' + esc(issue.device.name) + '</button>' +
          (issue.since ? ' · ' + esc(durationText(ageOf(issue.since, Date.now()))) : '') + '</span>'
        : '') +
      (armed ? ignoreChooserHtml(conf, issue, item, conf.hass) : '') +
      '</span>' +
      (armable && !armed
        ? '<button class="ignbtn" type="button" title="Stop reporting this" data-ignorearm="' + esc(key) + '">' +
          '<ha-icon icon="mdi:eye-off-outline"></ha-icon></button>'
        : '') +
      '</div>'
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

  function configItemHtml(item, open, state, conf) {
    const type = CONFIG_TYPE[item.type] || CONFIG_TYPE.other;
    /* issues are sorted by severity, so the first is the worst - which after
       the runtime join may be an impaired finding rather than a broken one. */
    const first = item.issues[0];
    const n = item.issues.length;
    const dot = item.verified ? '🔴' : item.impaired ? '🟠' : item.warnings ? '🟡' : '⚪';
    const counts = [];
    if (item.verified) counts.push(item.verified + ' broken');
    if (item.impaired) counts.push(item.impaired + ' impaired');
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
          '<div class="issues">' + item.issues.map((i) => issueHtml(i, item, state, conf)).join('') + '</div>' +
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


  /* ---- automation conflicts ----
     Same components as the sections above it: `sec` card, `chips` filter row,
     `prob` expandable rows. Only the contents of a row are new. */

  const CONFLICT_BAND = { critical: 'critical', warning: 'warn', info: 'unknown' };
  const CONFLICT_DOT = { critical: '🔴', warning: '🟠', info: '⚪' };
  const CONFLICT_WORD = { critical: 'Critical', warning: 'Warning', info: 'Info' };

  function conflictChips(list) {
    return [
      { id: 'all', label: 'All', n: list.length },
      { id: 'critical', label: 'Critical', n: list.filter((c) => c.severity === 'critical').length },
      { id: 'warning', label: 'Warning', n: list.filter((c) => c.severity === 'warning').length },
      { id: 'internal', label: 'Internal', n: list.filter((c) => c.internal).length },
      { id: 'cross', label: 'Cross', n: list.filter((c) => !c.internal).length },
    ].filter((c) => c.n || c.id === 'all');
  }

  const matchesConflictChip = (c, chip) =>
    chip === 'all' ? true
      : chip === 'internal' ? c.internal
        : chip === 'cross' ? !c.internal
          : c.severity === chip;

  /** "05:00 ─── 05:55" against "05:50 ─── 06:00", as one readable line. */
  function windowHtml(run) {
    const len = run.durationUnknown && !run.durationMin
      ? 'runtime unknown'
      : Math.round(run.durationMin) + ' min' + (run.durationEstimated ? ' est' : '');
    return (
      '<span class="cwin">' +
      '<span class="ctime">' + esc(run.startClock) + '</span>' +
      '<span class="cbar"></span>' +
      '<span class="ctime">' + esc(run.endClock) + '</span>' +
      '<span class="clen">' + esc(len) + '</span>' +
      '</span>'
    );
  }

  function conflictRunDetail(run, label) {
    const bits = [];
    bits.push('<div class="crow"><span class="ck">' + esc(label) + '</span><span class="cv">' +
      esc(run.name) + ' · ' + esc(run.triggerLabel) + '</span></div>');
    bits.push('<div class="crow"><span class="ck">Trigger</span><span class="cv">' +
      esc(run.triggerKind) + (run.triggerId ? ' · id ' + esc(run.triggerId) : '') +
      (run.note ? ' · ' + esc(run.note) : '') + '</span></div>');
    bits.push('<div class="crow"><span class="ck">Scheduled</span><span class="cv">' +
      esc(run.startClock) + ' → ' + esc(run.endClock) + '</span></div>');
    bits.push('<div class="crow"><span class="ck">Runtime</span><span class="cv">' +
      (run.durationUnknown && !run.durationMin
        ? 'unknown'
        : Math.round(run.durationMin) + ' min' + (run.durationEstimated ? ' (estimated)' : '')) +
      (run.durationReasons.length ? ' — ' + esc(run.durationReasons.join('; ')) : '') +
      '</span></div>');
    bits.push('<div class="crow"><span class="ck">Mode</span><span class="cv mono">' + esc(run.mode) + '</span></div>');
    if (run.targetCount) {
      bits.push('<div class="crow"><span class="ck">Commands</span><span class="cv mono">' +
        esc(run.targets.slice(0, 8).join(', ')) +
        (run.targets.length > 8 ? ' +' + (run.targets.length - 8) + ' more' : '') + '</span></div>');
    }
    if (run.unresolvedTargets.length) {
      bits.push('<div class="crow"><span class="ck">Also aims at</span><span class="cv mono">' +
        esc(run.unresolvedTargets.join(', ')) + ' (membership resolved at run time)</span></div>');
    }
    return bits.join('');
  }

  function conflictItemHtml(c, open) {
    const band = CONFLICT_BAND[c.severity];
    const headline = c.internal
      ? c.first.name
      : c.first.name + ' ↔ ' + c.second.name;
    const sub = c.internal ? 'Internal · ' + esc(c.first.mode) : 'Cross-automation · ' + esc(c.first.mode);
    /* The badge shows whatever the reason talks about: when a run is going to
       be dropped or restarted that is how early the next trigger is, not how
       long the two would have overlapped. */
    const badgeMins = c.internal && c.encroach > c.overlap ? c.encroach : c.overlap;
    const right = badgeMins > 0 ? Math.round(badgeMins) + 'm' : c.exact ? 'same' : Math.round(c.gap) + 'm';

    return (
      '<div class="prob conflict band-' + band + (open ? ' is-open' : '') + '">' +
      '<button class="probhead" type="button" data-toggle="' + esc(c.key) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="picon cdot">' + CONFLICT_DOT[c.severity] + '</span>' +
      '<span class="ptext">' +
      '<span class="pname">' + esc(headline) + '</span>' +
      '<span class="pmeta">' + sub + '</span>' +
      '<span class="cwins">' + windowHtml(c.first) + windowHtml(c.second) + '</span>' +
      '<span class="ploc">' + esc(c.first.triggerLabel) + ' ↔ ' + esc(c.second.triggerLabel) +
      (c.shared.length ? ' · ' + c.shared.length + ' shared target' + (c.shared.length === 1 ? '' : 's') : '') +
      '</span></span>' +
      '<span class="pright"><span class="pstatus">' + esc(right) + '</span></span>' +
      '<ha-icon class="pchev" icon="mdi:chevron-down"></ha-icon></button>' +
      (open
        ? '<div class="details">' +
          '<div class="creasons">' + c.reasons.map((r) =>
            '<div class="creason">' + esc(r) + '</div>').join('') + '</div>' +
          '<div class="cdetail">' +
          conflictRunDetail(c.first, 'First run') +
          '<div class="csep"></div>' +
          conflictRunDetail(c.second, 'Second run') +
          '</div>' +
          (c.shared.length
            ? '<div class="cshared"><span class="ck">Shared targets</span>' +
              c.shared.map((t) =>
                '<div class="ctarget' + (t.opposing ? ' is-opposing' : '') + '">' +
                '<span class="mono">' + esc(t.id) + '</span>' +
                '<span class="cserv">' + esc(t.services.join(' · ')) + '</span>' +
                (t.opposing ? '<span class="cflag">opposing</span>' : '') +
                '</div>').join('') + '</div>'
            : '') +
          (c.approximate
            ? '<div class="cnote">One of these is a sun-based trigger, so the times shift a little each day.</div>'
            : '') +
          '<div class="clinks">' +
          conflictLink(c.first) + (c.internal ? '' : conflictLink(c.second)) +
          '</div>' +
          '</div>'
        : '') +
      '</div>'
    );
  }

  /**
   * Opens the automation's own editor. The numeric id comes from the fetched
   * configuration rather than from the entity id, because the two are unrelated:
   * `automation.evening_lights` is edited at `/config/automation/edit/1712…`.
   */
  function conflictLink(run) {
    if (!run.automationId) {
      return '<button class="devbtn" type="button" data-entity="' + esc(run.entityId) + '">' +
        '<ha-icon icon="mdi:information-outline"></ha-icon>Open ' + esc(run.name) + '</button>';
    }
    return '<button class="devbtn" type="button" data-nav="/config/automation/edit/' + esc(run.automationId) + '">' +
      '<ha-icon icon="mdi:pencil-outline"></ha-icon>Edit ' + esc(run.name) + '</button>';
  }

  function conflictsSection(model, state) {
    const con = model.conflicts;
    if (!con) return '';
    if (!con.ready) {
      return sectionHtml('Automation conflicts', '',
        '<div class="scanning"><ha-icon icon="mdi:progress-clock"></ha-icon>' +
        '<span>Reading automation schedules…</span></div>', 'sec-conflicts');
    }

    const checked = 'Last checked ' + clockOf(con.analysedAt);
    const scanned = con.scanned.runs + ' scheduled run' + (con.scanned.runs === 1 ? '' : 's') +
      ' across ' + con.scanned.automations + ' automations';

    if (!con.conflicts.length) {
      return sectionHtml('Automation conflicts', checked,
        '<div class="allgood"><ha-icon icon="mdi:check-circle-outline"></ha-icon>' +
        '<span><strong>No automation conflicts detected</strong>' +
        '<small>' + esc(scanned) + '. No two scheduled runs are estimated to overlap.</small></span></div>',
        'sec-conflicts');
    }

    /* Info on its own is worth knowing but is not a fault, so the section says
       so rather than showing a red count of things that are fine. */
    const c = con.counts;
    const headline = [];
    if (c.critical) headline.push(c.critical + ' critical');
    if (c.warning) headline.push(c.warning + ' warning');
    if (c.info) headline.push(c.info + ' info');

    const chip = state.conflictChip || 'all';
    const shown = con.conflicts.filter((x) => matchesConflictChip(x, chip));

    return sectionHtml('Automation conflicts', headline.join(' · ') + ' · ' + checked,
      chipsHtml(conflictChips(con.conflicts), chip, 'confl') +
      '<div class="list">' +
      shown.map((x) => conflictItemHtml(x, state.open.has(x.key))).join('') +
      '</div>' +
      '<div class="cfoot">' +
      '<span>' + esc(scanned) + '</span>' +
      (con.scanned.dynamic
        ? '<span>' + con.scanned.dynamic + ' dynamic trigger' + (con.scanned.dynamic === 1 ? '' : 's') +
          ' not schedulable</span>'
        : '') +
      (con.scanned.unanalysable
        ? '<span>' + con.scanned.unanalysable + ' trigger' + (con.scanned.unanalysable === 1 ? '' : 's') +
          ' could not be read</span>'
        : '') +
      (con.scanned.tooShort
        ? '<span>' + con.scanned.tooShort + ' run' + (con.scanned.tooShort === 1 ? '' : 's') +
          ' under a minute, not compared</span>'
        : '') +
      '<button class="rescan" type="button" data-rescan="1">' +
      '<ha-icon icon="mdi:refresh"></ha-icon>Refresh</button>' +
      '</div>',
      'sec-conflicts');
  }

  const clockOf = (ms) => {
    const d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  };

  /**
   * The scopes on offer when a finding is dismissed, each with what it would
   * actually hide.
   *
   * The count is not decoration. A wildcard is the one scope that can bury a
   * hundred real problems in a single tap, so the number of findings it covers
   * is shown before it is written, not after.
   */
  function ignoreScopeOptions(conf, issue, item, hass) {
    const opts = [];
    const add = (label, rule) => {
      const p = ignorePreview(conf, rule, hass);
      if (!p.findings) return;
      opts.push({ label, rule, preview: p });
    };
    if (issue.ref) add('This reference, everywhere', { scope: 'ref', value: String(issue.ref) });
    add('Findings like this one, here', { scope: 'kind', value: issue.kind, item: item.key });
    add('Everything on this item', { scope: 'item', value: item.key });
    /* A pattern is only worth offering when it covers more than the exact
       reference already does - otherwise it is a wildcard with no upside. */
    const pattern = suggestPattern(issue.ref);
    if (pattern) {
      const p = ignorePreview(conf, { scope: 'pattern', value: pattern }, hass);
      if (p.refs > 1) opts.push({ label: 'Pattern ' + pattern, rule: { scope: 'pattern', value: pattern }, preview: p, wide: true });
    }
    return opts;
  }

  /** `sensor.hall_battery` suggests `sensor.*_battery`, and nothing else does. */
  function suggestPattern(ref) {
    if (!ref || !ENTITY_ID_RE.test(String(ref))) return null;
    const dot = ref.indexOf('.');
    const parts = ref.slice(dot + 1).split('_');
    if (parts.length < 2) return null;
    return ref.slice(0, dot) + '.*_' + parts[parts.length - 1];
  }

  function ignoreChooserHtml(conf, issue, item, hass) {
    const opts = ignoreScopeOptions(conf, issue, item, hass);
    if (!opts.length) return '';
    return (
      '<div class="ignwrap">' +
      '<div class="ignq">Stop reporting this?</div>' +
      opts.map((o) =>
        '<button class="ignopt' + (o.wide ? ' wide' : '') + '" type="button" data-ignoreapply="' +
        esc(JSON.stringify(o.rule)) + '">' +
        '<span class="ignlabel">' + esc(o.label) + '</span>' +
        '<span class="ignhit">hides ' + o.preview.findings +
        (o.preview.findings === 1 ? ' finding' : ' findings') +
        (o.preview.items > 1 ? ' across ' + o.preview.items + ' items' : '') + '</span></button>'
      ).join('') +
      '<button class="ignopt ignx" type="button" data-ignorecancel="1">Cancel</button>' +
      '</div>'
    );
  }

  /**
   * The rules currently in force, and what each of them is hiding.
   *
   * Ignored findings are set aside rather than deleted, so this is the whole
   * of what the page is not telling you - and every rule can be taken back
   * from the same place it is listed.
   */
  function ignoredHtml(conf, state) {
    const rules = conf.ignoreRules || [];
    if (!rules.length) return '';
    const hidden = new Map();
    for (const item of conf.items) {
      for (const issue of item.ignoredIssues || []) {
        const key = issue.ignoredBy;
        if (!hidden.has(key)) hidden.set(key, []);
        hidden.get(key).push({ item, issue });
      }
    }
    const open = state.open.has('ignored');
    const rows = rules.map((rule) => {
      const id = rule.id || rule.scope + ':' + rule.value;
      const hits = hidden.get(id) || [];
      return (
        '<div class="ignrule">' +
        '<div class="ignrtext"><span class="ignrscope">' + esc(rule.scope) + '</span>' +
        '<span class="mono">' + esc(rule.value) + (rule.item ? ' · ' + esc(rule.item) : '') + '</span>' +
        '<span class="ignrhits">' + (hits.length
          ? hits.length + (hits.length === 1 ? ' finding hidden' : ' findings hidden')
          : 'nothing matches it now') + '</span>' +
        (hits.length
          ? '<span class="ignrsample">' + esc(hits.slice(0, 3).map((h) => h.item.name + ' — ' + h.issue.message).join(' · ')) +
            (hits.length > 3 ? ' …' : '') + '</span>'
          : '') +
        '</div>' +
        '<button class="devbtn" type="button" data-unignore="' + esc(id) + '">' +
        '<ha-icon icon="mdi:eye-outline"></ha-icon>Show again</button>' +
        '</div>'
      );
    });
    return (
      '<div class="ignsec' + (open ? ' is-open' : '') + '">' +
      '<button class="probhead" type="button" data-toggle="ignored" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span class="picon cdot">🙈</span>' +
      '<span class="ptext"><span class="pname">Ignored</span>' +
      '<span class="pmeta">' + rules.length + (rules.length === 1 ? ' rule' : ' rules') + '</span>' +
      '<span class="pissue">' +
      (conf.counts.ignoredFindings === 1 ? 'one finding is' : 'findings are') +
      ' being held back</span></span>' +
      /* The same four cells every other row has. Three of them place wrongly
         under the narrow-width rules, which reposition `picon` and `pchev`
         across two rows and expect a fourth child to occupy the gap. */
      '<span class="pright"><span class="pstatus">' + (conf.counts.ignoredFindings || 0) + '</span></span>' +
      '<ha-icon class="pchev" icon="mdi:chevron-down"></ha-icon></button>' +
      (open ? '<div class="ignrules">' + rows.join('') + '</div>' : '') +
      '</div>'
    );
  }

  /* ================================================================== *
   * OPERATIONAL HEALTH
   *
   * Three things the configuration scanner cannot see, because none of them
   * is a question about configuration.
   *
   * EXECUTION ERRORS. An automation whose references are all valid, whose
   * entities all exist, which ran exactly when it was supposed to - and
   * whose action failed. On 2026-08-29 a water-safety automation tried to
   * switch off a running pump 94 times in 93 minutes and failed every time,
   * while this page said the configuration was healthy. It was. The action
   * was not.
   *
   * SYSTEM. Add-ons, backups, repairs and the supervisor: the machinery the
   * house runs on rather than anything the house contains.
   *
   * UNSTABLE DEVICES. The same devices the page already lists, seen over a
   * day instead of at an instant. A device that is up right now and was
   * offline for six hours this morning is invisible to every other section
   * here.
   *
   * The first two are computed in the backend and read from its published
   * state; the third is computed here, because it needs a history query and
   * that is cheap enough to do in the browser and works on an install with
   * no backend at all.
   * ================================================================== */

  const OPS_ENTITY = 'pyscript.config_health_ops';

  /** What the backend published, or null on an install without one. */
  function opsModel(hass) {
    const st = hass && hass.states && hass.states[OPS_ENTITY];
    if (!st || st.state === UNAVAILABLE) return null;
    const a = st.attributes || {};
    return {
      generated: a.generated || null,
      execution: Array.isArray(a.execution) ? a.execution : [],
      integrations: Array.isArray(a.integrations) ? a.integrations : [],
      system: Array.isArray(a.system) ? a.system : [],
    };
  }

  /* --- unstable devices ---------------------------------------------- *
   *
   * "Was it working" rather than "is it working". Availability over a day,
   * how many times it dropped, and how long the worst gap was.
   *
   * Two things make this honest. The first is which entity is asked: one
   * per device, chosen to be the least chatty one it has, which turned a
   * 17.2 MB / 7.2 s sweep of every entity into 0.22 MB / 176 ms without
   * changing a single answer - availability is a property of the device,
   * so any of its entities can report it, and a power sensor writing a row
   * a second reports it 80 times more expensively than a switch.
   *
   * The second is what is thrown away. A Home Assistant restart takes every
   * device unavailable at once, and counting that as instability reported 26
   * perfectly healthy Zigbee devices as flapping six times a day. Rather
   * than trying to know when Home Assistant restarted - which would still
   * miss a Zigbee coordinator restart, and there is no entity for that at
   * all - the mass event is recognised from its own shape: when a third of
   * the devices in the house go unavailable inside the same minute, that
   * minute is not about any of them.
   */

  const UNSTABLE_WINDOW_MS = 24 * 3600 * 1000;
  /* Fraction of sampled devices dropping inside one bucket that means the
     cause is upstream of all of them. A third is well above anything a real
     shared fault produced here and well below a restart, which takes
     essentially everything. */
  const UNSTABLE_MASS_RATIO = 0.3;
  const UNSTABLE_MASS_BUCKET_MS = 60 * 1000;
  const UNSTABLE_MASS_PAD_MS = 3 * 60 * 1000;
  const UNSTABLE_WARN_AVAILABILITY = 0.95;
  const UNSTABLE_CRITICAL_AVAILABILITY = 0.80;
  const UNSTABLE_MIN_TRANSITIONS = 4;
  const UNSTABLE_DISCONNECT_ANOMALY = 6;
  /* How long a device has to have been steady before its bad day stops being
     a current problem.
     A flat 24-hour window has no idea what time it is. It reported a plug as
     unstable at five in the afternoon on the strength of an outage that ended
     at half past eleven that morning, and a pump plug as unstable because of
     the hour in which it was being paired. Both were true about the day and
     false about the house. Two hours is long enough that a device dropping
     every twenty minutes never escapes, and short enough that a fault fixed
     over lunch is not still red at bedtime. */
  const UNSTABLE_QUIET_MS = 2 * 3600 * 1000;
  /* A device's first hour after it joins is commissioning, not instability.
     A Zigbee plug being paired rejoins, re-announces and re-reads its way
     through several transitions before it settles - twelve in the first
     fifty-seven minutes, on the device that prompted this. The registry
     records when the device was created, which is the moment it joined, so
     this needs no guessing from names or entity ids. */
  const UNSTABLE_COMMISSION_MS = 60 * 60 * 1000;
  /* Long enough that a page open all day is not re-querying, short enough
     that pressing Rescan after fixing something shows the change. */
  const UNSTABLE_TTL_MS = 15 * 60 * 1000;

  /* Entities that write a row a second are the wrong ones to ask. Lower
     sorts first. */
  function unstableRank(entityId) {
    if (/_(power|energy|current|voltage|temperature|humidity|illuminance|pressure|rssi|lqi|signal)\b/.test(entityId)) return 9;
    const domain = domainOf(entityId);
    if (domain === 'binary_sensor') return 0;
    if (domain === 'switch' || domain === 'light' || domain === 'lock' || domain === 'cover') return 1;
    if (domain === 'climate' || domain === 'fan' || domain === 'media_player') return 2;
    if (domain === 'sensor') return 5;
    return 6;
  }

  /** One cheap entity per device: {entityId -> deviceId}. */
  function unstableProbes(hass) {
    const states = hass.states || {};
    const entities = hass.entities || {};
    const best = new Map();
    for (const id in states) {
      const reg = entities[id];
      if (!reg || !reg.device_id || reg.disabled_by) continue;
      const cur = best.get(reg.device_id);
      if (!cur || unstableRank(id) < unstableRank(cur)) best.set(reg.device_id, id);
    }
    const probes = {};
    for (const [deviceId, entityId] of best) probes[entityId] = deviceId;
    return probes;
  }

  /**
   * Turn raw history into per-device stability. Pure, so the restart rule can
   * be tested against a synthetic house rather than waited out.
   *
   * `history` is what `history/history_during_period` returns with
   * `minimal_response`: {entity_id: [{s, lu}, ...]}, `lu` in seconds.
   */
  function computeUnstable(history, probes, now, opts) {
    const options = typeof opts === 'number' ? { windowMs: opts } : (opts || {});
    const span = options.windowMs || UNSTABLE_WINDOW_MS;
    /* deviceId -> epoch ms the device joined. Absent for anything the
       registry has no creation time for, and absence simply means no grace. */
    const created = options.created || {};
    const start = now - span;
    const series = {};
    const drops = [];

    for (const entityId in history) {
      const rows = history[entityId] || [];
      const points = [];
      for (const row of rows) {
        const value = row.s !== undefined ? row.s : row.state;
        const at = row.lu !== undefined ? row.lu * 1000
          : (row.last_updated ? Date.parse(row.last_updated) : null);
        if (at === null || isNaN(at)) continue;
        points.push({ at: Math.max(at, start), down: value === UNAVAILABLE });
      }
      if (!points.length) continue;
      series[entityId] = points;
      for (let i = 1; i < points.length; i++) {
        if (points[i].down && !points[i - 1].down) drops.push(points[i].at);
      }
    }

    /* Buckets holding a drop from a large fraction of the house at once. */
    const buckets = new Map();
    for (const at of drops) {
      const b = Math.floor(at / UNSTABLE_MASS_BUCKET_MS);
      buckets.set(b, (buckets.get(b) || 0) + 1);
    }
    const sampled = Object.keys(series).length;
    const threshold = Math.max(3, Math.ceil(sampled * UNSTABLE_MASS_RATIO));
    const masked = [];
    for (const [b, n] of buckets) {
      if (n >= threshold) {
        const centre = b * UNSTABLE_MASS_BUCKET_MS;
        masked.push([centre - UNSTABLE_MASS_PAD_MS, centre + UNSTABLE_MASS_BUCKET_MS + UNSTABLE_MASS_PAD_MS]);
      }
    }
    masked.sort((a, b) => a[0] - b[0]);
    const inMask = (at) => masked.some((m) => at >= m[0] && at <= m[1]);
    const maskedMs = masked.reduce((sum, m) => sum + (m[1] - m[0]), 0);

    const out = [];
    for (const entityId in series) {
      const points = series[entityId];
      const deviceId = probes[entityId] || null;
      /* The device's first hour on the network, if the registry knows when
         that was. Everything inside it is commissioning. */
      const joined = deviceId && created[deviceId] ? created[deviceId] : null;
      const commissionTo = joined === null ? null : joined + UNSTABLE_COMMISSION_MS;
      const commissioning = (at) => commissionTo !== null && at >= joined && at <= commissionTo;
      const excused = (at) => inMask(at) || commissioning(at);
      let transitions = 0;
      let downMs = 0;
      let longest = 0;
      /* The last moment this device's availability genuinely changed, in
         either direction. A device that dropped at nine and came back at ten
         has been steady since ten, not since nine. */
      let lastChange = null;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const until = i + 1 < points.length ? points[i + 1].at : now;
        if (i > 0 && points[i - 1].down !== p.down && !excused(p.at)) lastChange = p.at;
        if (p.down) {
          /* An outage that began inside a mass window belongs to the mass
             event, not to this device - including however long it took this
             particular device to come back. The same is true of an outage
             during commissioning. */
          if (excused(p.at)) continue;
          const length = until - p.at;
          downMs += length;
          if (length > longest) longest = length;
          if (i > 0 && !points[i - 1].down) transitions++;
        }
      }
      /* The window shrinks by whatever was masked, so a restart costs no
         device any availability at all - and a device still inside its own
         commissioning hour loses that hour too. */
      const commissionOverlap = commissionTo === null ? 0
        : Math.max(0, Math.min(now, commissionTo) - Math.max(start, joined));
      const measured = Math.max(1, span - maskedMs - commissionOverlap);
      out.push({
        entityId,
        deviceId,
        transitions,
        downMs,
        longestMs: longest,
        /* Whether it is unavailable right now, which decides whose finding
           this is rather than how bad it is. */
        down: points[points.length - 1].down,
        lastChange,
        /* How long it has been steady. Null when nothing countable ever
           happened, which is not the same as "steady for zero seconds". */
        quietMs: lastChange === null ? null : now - lastChange,
        commissioning: commissionTo !== null && now <= commissionTo,
        availability: Math.max(0, Math.min(1, (measured - downMs) / measured)),
      });
    }
    return {
      devices: out,
      sampled,
      maskedWindows: masked.length,
      maskedMs,
      threshold,
      window: span,
    };
  }

  /**
   * warning / critical / null for one device's 24h record.
   *
   * Two exclusions, both of them about not saying the same thing twice.
   *
   * A device that is unavailable right now belongs to the offline list,
   * which already says so at the top of the page; repeating it here as
   * "10.8% available" would be a second row for one problem. And a device
   * that never transitioned at all is not unstable in any sense - it was
   * either up the whole day or down the whole day, and measured against the
   * live house that second case was twelve of the eighteen rows this
   * produced: televisions, beacons and a car key that simply are not here.
   */
  function unstableBand(row) {
    if (row.down || row.transitions < 1) return null;
    let band = null;
    if (row.availability < UNSTABLE_CRITICAL_AVAILABILITY) band = 'critical';
    else if (row.transitions >= UNSTABLE_DISCONNECT_ANOMALY) band = 'warning';
    else if (row.availability < UNSTABLE_WARN_AVAILABILITY && row.transitions >= UNSTABLE_MIN_TRANSITIONS) band = 'warning';
    if (!band) return null;
    /* The day was bad and the last two hours were not. The figures stay on
       the page - they are true, and they are the reason to keep an eye on it -
       but a device that has been steady since lunchtime is not a thing to do
       something about now, and a red row that outlives its own cause teaches
       people to stop reading red rows. */
    if (row.quietMs !== null && row.quietMs >= UNSTABLE_QUIET_MS) return 'recovered';
    return band;
  }

  /** True for the bands that mean "this is happening now". */
  function unstableActive(band) {
    return band === 'critical' || band === 'warning';
  }

  /**
   * deviceId -> the epoch millisecond the device joined, for every device the
   * registry can actually date.
   *
   * `created_at` is written by the device registry itself when the device is
   * first added, so it is the moment of pairing rather than an inference from
   * a name or an entity id. Devices without it - an older registry entry, or
   * an integration that never set it - simply get no grace, which is the
   * safe direction to fail in.
   */
  function unstableCreated(hass) {
    const devices = (hass && hass.devices) || {};
    const out = {};
    for (const id in devices) {
      const at = devices[id].created_at;
      if (typeof at !== 'number' || !isFinite(at) || at <= 0) continue;
      /* The registry stores epoch seconds. Anything that looks like it is
         already milliseconds, or is in the future, is not trusted. */
      const ms = at > 1e11 ? at : at * 1000;
      if (ms > Date.now() + 60000) continue;
      out[id] = ms;
    }
    return out;
  }

  const unstableCache = { at: 0, data: null, running: false };
  /* Every connected card, so the one query benefits all of them. Without
     this, a page holding more than one card gave the section to whichever
     card happened to ask first and left the others waiting for their next
     tick - the answer was already in hand and simply not delivered. */
  const liveCards = new Set();

  /**
   * One history query for the whole house, cached.
   *
   * Failure is silent by design: an install with the recorder switched off,
   * or a user without history access, simply has no UNSTABLE section rather
   * than an error where a section should be.
   */
  function getUnstable(hass, force) {
    const now = Date.now();
    if (!force && unstableCache.data && now - unstableCache.at < UNSTABLE_TTL_MS) {
      return Promise.resolve(unstableCache.data);
    }
    if (unstableCache.running) return Promise.resolve(unstableCache.data);
    unstableCache.running = true;
    const probes = unstableProbes(hass);
    const created = unstableCreated(hass);
    const ids = Object.keys(probes);
    if (!ids.length) {
      unstableCache.running = false;
      return Promise.resolve(null);
    }
    const started = performance.now ? performance.now() : now;
    return hass.callWS({
      type: 'history/history_during_period',
      start_time: new Date(now - UNSTABLE_WINDOW_MS).toISOString(),
      end_time: new Date(now).toISOString(),
      entity_ids: ids,
      minimal_response: true,
      no_attributes: true,
      significant_changes_only: false,
    }).then((history) => {
      const result = computeUnstable(history, probes, now, { created });
      result.queryMs = Math.round((performance.now ? performance.now() : Date.now()) - started);
      result.probes = ids.length;
      unstableCache.running = false;
      /* An empty answer is not an answer. The recorder can be starting up, or
         briefly unavailable, and caching "no history at all" for a quarter of
         an hour would hide a genuine outage for exactly as long as it takes
         someone to give up looking. */
      if (!result.sampled) return unstableCache.data;
      unstableCache.at = Date.now();
      unstableCache.data = result;
      return result;
    }).catch(() => {
      unstableCache.running = false;
      unstableCache.at = Date.now();
      return unstableCache.data;
    });
  }

  /* --- rendering ------------------------------------------------------ */

  const SYSTEM_ICON = {
    addon: 'mdi:puzzle-outline',
    backup: 'mdi:backup-restore',
    repairs: 'mdi:wrench-outline',
    supervisor: 'mdi:shield-outline',
    integration: 'mdi:power-plug-outline',
  };

  const SYSTEM_BAND = {
    actionable: 'critical',
    critical: 'critical',
    warning: 'warn',
  };

  /**
   * One row per current system problem, and nothing at all when there are
   * none. Five separate sections would have been five headings to skip past
   * on a healthy day; this is one, and on a healthy day it is not there.
   */
  function systemSection(model) {
    const ops = model.ops;
    if (!ops) return '';
    const rows = ops.system.slice();
    /* An integration failing behind a config entry that still says `loaded`
       belongs here rather than with the devices: the fault is in the
       integration, and the devices it owns look perfectly fine. */
    for (const i of ops.integrations) {
      const status = i.status || i.severity;
      /* A restart empties Home Assistant's error store, so an integration
         that was failing before it simply stops producing evidence. Calling
         that healthy is how a camera that had been broken for four days
         quietly vanished from this page. `pending` says what is actually
         true: it was failing, and nothing has checked since. */
      const pending = status === 'pending';
      if (status === 'recovered') continue;
      rows.push({
        kind: 'integration',
        name: i.entry || i.domain,
        detail: pending
          ? 'Previous failure · awaiting post-restart validation'
          : i.errors + ' error' + (i.errors === 1 ? '' : 's') +
            (i.entries > 1 ? ' · ' + i.domain + ', entry not identified' : '') +
            ' · still failing',
        severity: pending ? 'warning' : status,
        url: '/config/integrations/integration/' + i.domain,
        note: pending ? (i.errors + ' errors up to ' + String(i.last || '').slice(11, 16)) : i.message,
      });
    }
    if (!rows.length) return '';
    /* `|| 2` here put the actionable rows last, because their rank is 0. */
    const order = { actionable: 0, critical: 0, warning: 1 };
    const rank = (r) => (r.severity in order ? order[r.severity] : 2);
    rows.sort((a, b) => rank(a) - rank(b));
    const body = rows.map((r) => {
      const band = SYSTEM_BAND[r.severity] || 'warn';
      /* The supervisor's one issue is its own summary, so listing it under
         itself just says the same word twice. */
      const listed = (Array.isArray(r.items) ? r.items : [])
        .filter((x) => String(x) !== String(r.detail));
      const items = listed.length
        ? '<span class="sysitems">' + esc(listed.join(' · ')) + '</span>' : '';
      const note = r.note ? '<span class="sysitems">' + esc(String(r.note).slice(0, 120)) + '</span>' : '';
      return '<button class="sysrow band-' + band + '" type="button"' +
        (r.url ? ' data-nav="' + esc(r.url) + '"' : '') + '>' +
        '<ha-icon icon="' + esc(SYSTEM_ICON[r.kind] || 'mdi:alert-outline') + '"></ha-icon>' +
        '<span class="systext"><span class="sysname">' + esc(r.name) + '</span>' +
        '<span class="sysdetail">' + esc(r.detail) + '</span>' + items + note + '</span>' +
        '<ha-icon class="syschev" icon="mdi:chevron-right"></ha-icon></button>';
    }).join('');
    return sectionHtml('System', rows.length + (rows.length === 1 ? ' finding' : ' findings'),
      '<div class="sysrows">' + body + '</div>', 'sec-system');
  }

  /**
   * Execution errors, as their own tier inside configuration health.
   *
   * They are deliberately not folded in with BROKEN or IMPAIRED. Those two
   * say something about what the configuration refers to; this says the
   * configuration is entirely sound and the house would not do as it was
   * told. Ninety-four failures are one row, because they were one incident.
   */
  function executionHtml(ops, state) {
    if (!ops || !ops.execution.length) return '';
    const statusOf = (e) => e.status || e.severity;
    const live = ops.execution.filter((e) => statusOf(e) === 'actionable');
    const held = ops.execution.filter((e) => statusOf(e) === 'pending');
    const past = ops.execution.filter((e) => statusOf(e) === 'recovered' || statusOf(e) === 'diagnostic');
    const row = (e) => {
      const status = statusOf(e);
      const current = status === 'actionable';
      const band = current ? (e.safety ? 'critical' : 'exec') : status === 'pending' ? 'exec' : 'muted';
      const tail = status === 'pending' ? ' · awaiting validation after restart'
        : current ? ' · latest ' + esc(String(e.last || '').slice(11, 16))
        : ' · stopped ' + esc(String(e.last || '').slice(11, 16));
      const when = e.failures + ' failed action' + (e.failures === 1 ? '' : 's') + tail;
      const open = state && state.open && state.open.has('exec:' + e.entity_id);
      return '<div class="execrow band-' + band + (open ? ' is-open' : '') + '" data-exec="' + esc(e.entity_id) + '">' +
        '<div class="exchead">' +
        '<ha-icon icon="' + (e.type === 'script' ? 'mdi:script-text-outline' : 'mdi:robot-outline') + '"></ha-icon>' +
        '<span class="extext"><span class="exname">' + esc(e.name) +
        (e.safety ? '<span class="exsafety">safety</span>' : '') + '</span>' +
        '<span class="exwhen">' + when + '</span></span>' +
        '<span class="excount">' + e.failures + '</span>' +
        '<ha-icon class="exchev" icon="mdi:chevron-down"></ha-icon></div>' +
        (open
          ? '<div class="exbody">' +
            (e.where ? '<div class="exline"><span>Step</span><span>' + esc(e.where) + '</span></div>' : '') +
            (e.step ? '<div class="exline"><span>Action</span><span>' + esc(e.step) + '</span></div>' : '') +
            '<div class="exline"><span>Error</span><span>' + esc(e.error) + '</span></div>' +
            '<div class="exline"><span>First</span><span>' + esc(e.first || '?') + '</span></div>' +
            '<div class="exline"><span>Latest</span><span>' + esc(e.last || '?') + '</span></div>' +
            '<div class="exline"><span>In the last hour</span><span>' + e.recent + '</span></div>' +
            '<div class="exline"><span>Still recurring</span><span>' + (e.recurring ? 'yes' : 'no') + '</span></div>' +
            (e.enabled ? '' : '<div class="exline"><span>Automation</span><span>currently switched off</span></div>') +
            '<div class="exact"><button class="exopen" type="button" data-execopen="' + esc(e.entity_id) + '">' +
            '<ha-icon icon="mdi:open-in-new"></ha-icon>Open ' + (e.type === 'script' ? 'script' : 'automation') +
            '</button>' +
            /* Home Assistant keeps only the last five runs of an item, so on
               something that runs every minute the traces cover five minutes
               and this incident is already older than all of them. The link
               is still the right place to look at what it is doing NOW. */
            '<button class="exopen" type="button" data-exectrace="' + esc(e.entity_id) + '">' +
            '<ha-icon icon="mdi:history"></ha-icon>Traces</button>' +
            '</div></div>'
          : '') +
        '</div>';
    };
    let html = '';
    if (live.length) {
      html += '<div class="exgroup"><span class="exlabel">Execution errors</span>' +
        live.map(row).join('') + '</div>';
    }
    if (held.length) {
      html += '<div class="exgroup"><span class="exlabel">Unverified since restart · ' +
        held.length + '</span>' + held.map(row).join('') + '</div>';
    }
    if (past.length) {
      html += '<div class="exgroup is-past"><span class="exlabel">Recently recovered · ' +
        past.length + '</span>' + past.map(row).join('') + '</div>';
    }
    return html;
  }

  /**
   * Devices worth looking at because of how the last day went, not because
   * of how they are right now.
   */
  function unstableSection(model) {
    const un = model.unstable;
    if (!un || !un.devices) return '';
    const devices = (model.hassDevices) || {};
    /* Skip means skipped everywhere, including here: a printer that spends
       half its life in another house is not an unstable device. */
    const skipped = model.skipped || new Set();
    const rows = un.devices
      .map((r) => ({ ...r, band: unstableBand(r) }))
      .filter((r) => r.band && !(r.deviceId && skipped.has(r.deviceId)))
      .sort((a, b) => a.availability - b.availability || b.transitions - a.transitions);
    if (!rows.length) return '';
    const row = (r) => {
      const dev = r.deviceId && devices[r.deviceId];
      const name = dev ? (dev.name_by_user || dev.name || r.entityId) : r.entityId;
      const pct = Math.round(r.availability * 1000) / 10;
      const band = r.band === 'critical' ? 'critical' : r.band === 'warning' ? 'warn' : 'muted';
      /* A recovered row keeps the whole day's figures. Deleting them the
         moment a device settles would throw away the only evidence that
         anything happened. */
      const last = r.band === 'recovered'
        ? '<span class="unlongest">Stable for ' + esc(durationText(r.quietMs)) + '</span>'
        : '<span class="unlongest">Longest outage ' + esc(durationText(r.longestMs)) + '</span>';
      return '<div class="unrow band-' + band + '">' +
        '<ha-icon icon="' + (r.band === 'recovered' ? 'mdi:check-circle-outline' : 'mdi:transit-connection-variant') + '"></ha-icon>' +
        '<span class="untext"><span class="unname">' + esc(name) + '</span>' +
        '<span class="undetail">' + pct + '% today · ' + r.transitions +
        ' disconnect' + (r.transitions === 1 ? '' : 's') + ' · ' +
        esc(durationText(r.downMs)) + ' offline</span>' + last + '</span></div>';
    };
    const active = rows.filter((r) => unstableActive(r.band));
    const past = rows.filter((r) => r.band === 'recovered');
    const note = un.maskedWindows
      ? un.maskedWindows + ' restart window' + (un.maskedWindows === 1 ? '' : 's') + ' excluded'
      : 'last 24 hours';
    let body = '';
    if (active.length) body += '<div class="unrows">' + active.map(row).join('') + '</div>';
    if (past.length) {
      body += '<div class="exgroup is-past" style="margin-top:' + (active.length ? '10px' : '0') + '">' +
        '<span class="exlabel">Recently recovered · ' + past.length + '</span>' +
        '<div class="unrows">' + past.map(row).join('') + '</div></div>';
    }
    return sectionHtml('Unstable devices', note, body, 'sec-unstable');
  }

  function configSection(model, state) {
    const conf = model.config;
    if (!conf || !conf.ready) return '';
    const ignored = ignoredHtml(conf, state);
    /* Execution errors belong to configuration health but not to any of its
       existing tiers, so they render above the reference findings with their
       own heading rather than being mixed into them. */
    const execution = executionHtml(model.ops, state);

    if (!conf.problems.length) {
      /* Saying "healthy" while an automation is failing every minute would be
         the same blind spot this feature was built to close. */
      if (execution) {
        return sectionHtml(
          'Configuration issues', 'execution',
          execution + ignored, 'sec-config'
        );
      }
      return sectionHtml(
        'Configuration issues', '',
        '<div class="allgood"><ha-icon icon="mdi:check-circle-outline"></ha-icon>' +
        '<span><strong>Configuration looks healthy</strong>' +
        '<small>Every entity, device, area, script, scene and action referenced by ' +
        conf.counts.scanned.automation + ' automations, ' + conf.counts.scanned.script +
        ' scripts and ' + conf.counts.scanned.cards + ' dashboard cards still exists.</small></span></div>' +
        ignored,
        'sec-config'
      );
    }

    const chips = CONFIG_CHIPS
      .map((c) => ({ ...c, n: conf.problems.filter((p) => configChipMatches(p, c.id)).length }))
      .filter((c) => c.n > 0);
    const active = chips.some((c) => c.id === state.confChip) ? state.confChip : 'all';

    const rows = conf.problems
      .filter((p) => configChipMatches(p, active))
      .map((p) => configItemHtml(p, state.open.has(p.key), state, conf));

    return sectionHtml(
      'Configuration issues',
      rows.length + (rows.length === 1 ? ' item' : ' items'),
      execution +
      (chips.length > 2 ? chipsHtml(chips, active, 'confchip') : '') +
      '<div class="probs">' + rows.join('') + '</div>' + ignored,
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

    /* Sits beside the device button because it answers the same question -
       "this one is not really broken" - and the reader is already here having
       decided that. */
    const skipButton =
      '<button class="devbtn" type="button" data-skip="' + esc(p.deviceId) + '" ' +
      'title="Stop reporting the health of this device">' +
      '<ha-icon icon="mdi:eye-off-outline"></ha-icon><span>Skip</span></button>';

    return (
      '<div class="details">' +
      '<div class="dtop"><div class="dfacts">' + facts.join('') + '</div>' +
      '<div class="dbtns">' + deviceButton + skipButton + '</div></div>' +
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

  /**
   * Every device the user has told the card to leave alone. Hidden entirely
   * when there is nothing skipped, like every other section here.
   *
   * Each row says what the skip is currently suppressing, so the list can be
   * reviewed rather than just accumulated - a device skipped a year ago that
   * is now genuinely dead should be easy to notice.
   */
  function skippedSection(model) {
    if (!model.skipped || !model.skipped.length) return '';
    const rows = model.skipped.map((d) => {
      const state = d.wouldBe
        ? '<span class="skipwould band-' + d.wouldBe.band + '">' + esc(d.wouldBe.label) + '</span>'
        : '<span class="skipok">Responding</span>';
      const bits = [esc(d.integration)];
      if (d.area) bits.push(esc(d.area));
      return (
        '<div class="rec is-skipped">' +
        '<ha-icon icon="mdi:eye-off-outline"></ha-icon>' +
        '<span class="rectext"><span class="recname">' + esc(d.name) + '</span>' +
        '<span class="recmeta">' + bits.join(' &middot; ') + '</span></span>' +
        state +
        '<button class="devbtn skipundo" type="button" data-unskip="' + esc(d.deviceId) + '" ' +
        'title="Check this device again">' +
        '<ha-icon icon="mdi:eye-outline"></ha-icon><span>Un-skip</span></button>' +
        '</div>'
      );
    }).join('');
    const n = model.skipped.length;
    return sectionHtml(
      'Skipped devices',
      n + (n === 1 ? ' device not checked' : ' devices not checked'),
      '<div class="recs recs-skipped">' + rows + '</div>',
      'sec-skipped'
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
/* Impaired sits between broken and warning, and its colour says so. */
.band-impaired { --dh-accent: #e8710a; }
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
  font: inherit; text-align: left; cursor: default;
  /* The pill fills the card here rather than sitting inside a summary strip,
     so the icon would otherwise start hard against the card's own edge. */
  padding: 8px 7px 8px 12px;
}
/* Only a tile with somewhere to go offers to be tapped. Without a
   navigation_path it is a readout, and says so by not reacting.
   No backticks in here: this block is a template literal. */
ha-card.mini .pill.is-tappable { cursor: pointer; }
ha-card.mini .pill.is-tappable:hover { background: color-mix(in srgb, var(--dh-accent) 20%, transparent); }
/* The detail row is always on for a mini tile - it is the tile's only prose -
   and only steps aside when the track is too narrow to hold a word of it. */
ha-card.mini .pnote {
  display: block; font-size: 0.62rem; color: var(--secondary-text-color);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
@container dhpill (max-width: 110px) { ha-card.mini .pnote { display: none; } }


/* ---- the overall card ----
   The Health page's verdict row, followed by one line per group that has
   something in it. Same words, same colours, a third of the height. */
ha-card.mini.overall { overflow: hidden; }
.ocard {
  display: block; width: 100%; padding: 10px 12px 11px; border: 0;
  border-radius: var(--ha-card-border-radius, 12px);
  font: inherit; color: inherit; text-align: left; cursor: default;
  background: color-mix(in srgb, var(--dh-accent) 12%, transparent);
}
.ocard.is-tappable { cursor: pointer; }
.ocard.is-tappable:hover { background: color-mix(in srgb, var(--dh-accent) 20%, transparent); }
.ohead { display: flex; align-items: center; gap: 9px; }
.ocard .hicon { --mdc-icon-size: 24px; color: var(--dh-accent); }
.ocard .hword { font-size: 0.95rem; font-weight: 700; color: var(--primary-text-color); }
.ogroups { display: flex; flex-direction: column; gap: 3px; margin: 7px 0 0 33px; }
.ogroup { display: grid; grid-template-columns: 7px minmax(64px, auto) minmax(0, 1fr); align-items: baseline; gap: 8px; }
.odot { width: 6px; height: 6px; border-radius: 50%; background: var(--dh-accent); transform: translateY(-1px); }
.olabel { font-size: 0.73rem; font-weight: 600; color: var(--primary-text-color); }
.oitems { font-size: 0.73rem; color: var(--secondary-text-color); overflow-wrap: anywhere; }
/* On a narrow card the group name sits above its counts rather than beside. */
@container dhcard (max-width: 300px) {
  .ogroups { margin-left: 0; }
  .ogroup { grid-template-columns: 7px minmax(0, 1fr); }
  .oitems { grid-column: 2; }
}

/* ---- automation conflicts ----
   The two execution windows are the point of a conflict row, so they get a
   line of their own rather than being buried in the detail panel. */
.cwins { display: flex; flex-direction: column; gap: 2px; margin: 3px 0 1px; }
.cwin { display: flex; align-items: center; gap: 6px; font-size: 0.72rem; }
.ctime { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--primary-text-color); }
.cbar {
  flex: 1 1 auto; min-width: 14px; max-width: 120px; height: 2px; border-radius: 1px;
  background: color-mix(in srgb, var(--dh-accent) 55%, transparent);
}
.clen { color: var(--secondary-text-color); font-size: 0.68rem; white-space: nowrap; }
.creasons { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.creason {
  font-size: 0.76rem; line-height: 1.45; padding: 7px 9px; border-radius: 8px;
  background: color-mix(in srgb, var(--dh-accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--dh-accent) 25%, transparent);
}
.cdetail { display: flex; flex-direction: column; gap: 3px; }
.crow { display: grid; grid-template-columns: minmax(88px, auto) minmax(0, 1fr); gap: 8px; font-size: 0.74rem; }
.ck { color: var(--secondary-text-color); }
.cv { color: var(--primary-text-color); overflow-wrap: anywhere; }
.csep { height: 1px; background: var(--divider-color); margin: 6px 0; }
.cshared { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.ctarget {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px;
  font-size: 0.72rem; padding: 5px 8px; border-radius: 7px;
  background: var(--dh-soft); border: 1px solid var(--divider-color);
}
.ctarget.is-opposing { border-color: color-mix(in srgb, var(--error-color) 45%, transparent); }
.cserv { color: var(--secondary-text-color); }
.cflag {
  font-size: 0.62rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: var(--error-color);
}
.cnote { margin-top: 8px; font-size: 0.72rem; color: var(--secondary-text-color); }
.clinks { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.cfoot {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 10px;
  font-size: 0.7rem; color: var(--secondary-text-color);
}
.cfoot .rescan { margin-left: auto; }
/* Narrow cards put the windows under the name rather than squeezing them. */
@container dhcard (max-width: 360px) {
  .cbar { max-width: 40px; }
  .clen { font-size: 0.64rem; }
  .crow { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .ck { font-size: 0.68rem; }
}

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
/* The two operational facts sit on the same line as the coverage note when
   there is room. They are the first thing to go when there is not: the page
   is about findings, and a scan timestamp is not worth a line of its own on a
   304px tile. */
/* Inline, inside the note's own text run, so they reflow with it instead of
   becoming flex items that force a line of their own. */
/* --- system, execution errors and unstable devices ----------------- */
.sysrows, .unrows { display: flex; flex-direction: column; gap: 6px; }
.sysrow {
  display: grid; grid-template-columns: 20px 1fr 18px; gap: 10px; align-items: center;
  width: 100%; text-align: left; padding: 9px 10px; border-radius: 10px; cursor: pointer;
  border: 1px solid var(--divider-color, #444); background: transparent;
  color: var(--primary-text-color); font: inherit;
}
.sysrow ha-icon { --mdc-icon-size: 20px; }
.systext { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sysname { font-weight: 600; font-size: 0.95em; }
.sysdetail, .sysitems { font-size: 0.82em; opacity: 0.78; }
.sysitems { opacity: 0.6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.syschev { opacity: 0.5; --mdc-icon-size: 18px; }
.unrow {
  display: grid; grid-template-columns: 20px 1fr; gap: 10px; align-items: center;
  padding: 9px 10px; border-radius: 10px; border: 1px solid var(--divider-color, #444);
}
.untext { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.unname { font-weight: 600; font-size: 0.95em; }
.undetail { font-size: 0.82em; opacity: 0.8; }
.unlongest { font-size: 0.78em; opacity: 0.6; }

.exgroup { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.exlabel {
  font-size: 0.72em; letter-spacing: 0.08em; text-transform: uppercase;
  opacity: 0.65; font-weight: 700;
}
.exgroup.is-past .exlabel { opacity: 0.45; }
.execrow { border: 1px solid var(--divider-color, #444); border-radius: 10px; overflow: hidden; }
.exchead {
  display: grid; grid-template-columns: 20px 1fr auto 18px; gap: 10px; align-items: center;
  padding: 9px 10px; cursor: pointer;
}
.exchead ha-icon { --mdc-icon-size: 20px; }
.extext { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.exname { font-weight: 600; font-size: 0.95em; display: flex; align-items: center; gap: 6px; }
.exsafety {
  font-size: 0.62em; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700;
  padding: 1px 5px; border-radius: 5px; background: var(--error-color, #db4437); color: #fff;
}
.exwhen { font-size: 0.82em; opacity: 0.8; }
.excount { font-variant-numeric: tabular-nums; font-weight: 700; opacity: 0.8; }
.exchev { opacity: 0.5; --mdc-icon-size: 18px; transition: transform 0.15s ease; }
.execrow.is-open .exchev { transform: rotate(180deg); }
.exbody {
  border-top: 1px solid var(--divider-color, #444); padding: 8px 10px 10px;
  display: flex; flex-direction: column; gap: 4px;
}
.exline { display: grid; grid-template-columns: 128px 1fr; gap: 8px; font-size: 0.82em; }
.exline > span:first-child { opacity: 0.6; }
.exline > span:last-child { word-break: break-word; }
.exact { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }
.exopen {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer; font: inherit;
  font-size: 0.82em; padding: 5px 10px; border-radius: 8px; background: transparent;
  border: 1px solid var(--divider-color, #444); color: var(--primary-text-color);
}
.exopen ha-icon { --mdc-icon-size: 16px; }
.execrow.band-critical, .sysrow.band-critical, .unrow.band-critical {
  border-color: var(--error-color, #db4437);
  box-shadow: inset 3px 0 0 var(--error-color, #db4437);
}
.execrow.band-exec {
  border-color: var(--warning-color, #ffa726);
  box-shadow: inset 3px 0 0 var(--warning-color, #ffa726);
}
.sysrow.band-warn, .unrow.band-warn {
  box-shadow: inset 3px 0 0 var(--warning-color, #ffa726);
}
.execrow.band-muted, .unrow.band-muted { opacity: 0.7; }
.unrow.band-muted ha-icon { color: var(--success-color, #43a047); }
@container dhcard (max-width: 420px) {
  .exline { grid-template-columns: 1fr; gap: 0; }
  .sysitems { white-space: normal; }
}

.opswhen, .opsnext { opacity: 0.85; white-space: nowrap; }
.opswhen::before, .opsnext::before { content: " · "; }
@container dhcard (max-width: 560px) {
  .opsnext { display: none; }
}
@container dhcard (max-width: 340px) {
  .opswhen { display: none; }
}
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
  display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 7px;
  padding: 6px 8px; border-radius: 8px;
  background: color-mix(in srgb, var(--dh-accent) 6%, transparent);
}
.issue.is-unvalidated { background: none; border: 1px dashed var(--divider-color); }
.idot { font-size: 0.7rem; line-height: 1.5; }
.itext { min-width: 0; display: flex; flex-direction: column; }
.imsg { font-size: 0.76rem; color: var(--primary-text-color); overflow-wrap: anywhere; }
.iloc { font-size: 0.69rem; color: var(--secondary-text-color); }
.ihint { font-size: 0.69rem; color: var(--primary-color, #03a9f4); overflow-wrap: anywhere; }

/* ---- ignore controls ----
   The arm button is a quiet glyph until the row is hovered or focused, so a
   page of findings does not read as a page of buttons. The chooser that opens
   underneath it is a single column: at 304px there is no room for a row of
   scopes, and a scope picked by accident is exactly what this must not do. */
.ignbtn {
  align-self: start; flex: none; cursor: pointer;
  background: none; border: 0; border-radius: 6px; padding: 2px;
  color: var(--secondary-text-color); opacity: 0.45; transition: opacity 0.12s;
}
.ignbtn ha-icon { --mdc-icon-size: 15px; display: block; }
.issue:hover .ignbtn, .ignbtn:focus-visible { opacity: 1; }
.ignwrap {
  display: grid; gap: 4px; margin-top: 6px; padding-top: 6px;
  border-top: 1px dashed var(--divider-color);
}
.ignq { font-size: 0.69rem; color: var(--secondary-text-color); }
.ignopt {
  display: flex; flex-direction: column; gap: 1px; text-align: left; cursor: pointer;
  padding: 5px 8px; border-radius: 7px; min-height: 34px;
  border: 1px solid var(--divider-color); background: transparent;
  color: var(--primary-text-color); font: inherit;
}
.ignopt:hover { border-color: var(--dh-accent); background: color-mix(in srgb, var(--dh-accent) 14%, transparent); }
.ignlabel { font-size: 0.72rem; overflow-wrap: anywhere; }
.ignhit { font-size: 0.66rem; color: var(--secondary-text-color); }
.ignopt.wide .ignlabel { font-family: var(--code-font-family, monospace); }
.ignopt.ignx { align-items: center; color: var(--secondary-text-color); min-height: 30px; }
.ignopt.is-busy { opacity: 0.5; pointer-events: none; }
.ignopt.is-failed { border-color: var(--error-color, #db4437); color: var(--error-color, #db4437); }
.ignsec { margin-top: 10px; border: 1px dashed var(--divider-color); border-radius: 12px; overflow: hidden; }
.ignsec .probhead { opacity: 0.75; }
.ignsec.is-open .probhead { opacity: 1; }
.ignrules { display: grid; gap: 6px; padding: 0 9px 9px; }
.ignrule {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center;
  padding: 6px 8px; border-radius: 8px; background: color-mix(in srgb, var(--dh-accent) 5%, transparent);
}
.ignrtext { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ignrscope {
  font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--secondary-text-color);
}
.ignrtext .mono { font-family: var(--code-font-family, monospace); font-size: 0.74rem; overflow-wrap: anywhere; }
.ignrhits { font-size: 0.68rem; color: var(--secondary-text-color); }
.ignrsample { font-size: 0.66rem; color: var(--secondary-text-color); opacity: 0.8; overflow-wrap: anywhere; }
@container dhcard (max-width: 420px) {
  .ignrule { grid-template-columns: minmax(0, 1fr); }
  .ignrule .devbtn { justify-self: start; }
}
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
/* Two buttons where there was one: they stack rather than squeeze the facts
   column, which is the part that has to stay readable. */
.dbtns { display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
/* .devbtn carries align-self: start for its solo uses; stacked, the two have
   to share an edge or the pair reads as an accident. */
.dbtns .devbtn { justify-content: center; align-self: stretch; }
.devbtn.is-busy { opacity: 0.5; pointer-events: none; }
.devbtn.is-failed { border-color: var(--error-color, #db4437); color: var(--error-color, #db4437); }
/* A skipped row is a record, not an alert: neutral, with the suppressed
   verdict shown in its own colour so a skip that now hides a real fault is
   still legible. */
.recs-skipped .rec { grid-template-columns: 22px minmax(0, 1fr) auto auto; gap: 8px; }
.rec.is-skipped ha-icon { color: var(--secondary-text-color); }
.rec.is-skipped .recname { color: var(--primary-text-color); }
.skipwould { font-size: 0.72rem; font-weight: 700; color: var(--dh-accent); white-space: nowrap; }
.skipok { font-size: 0.72rem; font-weight: 600; color: var(--success-color, #43a047); white-space: nowrap; }
.skipundo { padding: 2px 8px; font-size: 0.68rem; }
.skipundo ha-icon { --mdc-icon-size: 14px; }
@container dhcard (max-width: 420px) {
  .recs-skipped .rec { grid-template-columns: 22px minmax(0, 1fr) auto; }
  .recs-skipped .skipundo { grid-column: 2 / -1; justify-self: start; }
}
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
/* The device behind an impaired reference: a link, not a decoration. */
.idev { display: inline-flex; align-items: baseline; gap: 4px; flex-wrap: wrap; }
.devlink {
  border: 0; background: none; padding: 0; font: inherit; font-size: inherit;
  color: var(--primary-color, #03a9f4); cursor: pointer; text-decoration: underline;
}
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

  /** The entity the backend scan publishes on. */
  const SCAN_ENTITY = 'pyscript.config_health';

  /* Rules written from this browser that the backend has not republished yet,
     and rules withdrawn from this browser that it still publishes. Both drain
     themselves the moment the published list agrees, so a rule saved on the
     phone and a rule saved here converge without either of them winning. */
  const pendingIgnores = [];
  const pendingUnignores = new Set();

  /** The broken references the file scanner published, as the card sees them. */
  function backendMissing(hass) {
    const st = hass && hass.states && hass.states[SCAN_ENTITY];
    const list = st && st.attributes && st.attributes.missing;
    return Array.isArray(list) ? list : [];
  }

  function ignoreRulesOf(hass) {
    const st = hass && hass.states && hass.states[SCAN_ENTITY];
    const published = (st && st.attributes && st.attributes.ignores) || [];
    const rules = (Array.isArray(published) ? published : []).filter((r) => {
      const id = r.id || r.scope + ':' + r.value;
      if (!pendingUnignores.has(id)) return true;
      return false;
    });
    /* Anything the backend now carries is no longer pending. */
    for (let i = pendingIgnores.length - 1; i >= 0; i--) {
      if (rules.some((r) => (r.id || r.scope + ':' + r.value) === pendingIgnores[i].id)) pendingIgnores.splice(i, 1);
    }
    for (const id of Array.from(pendingUnignores)) {
      if (!(Array.isArray(published) ? published : []).some((r) => (r.id || r.scope + ':' + r.value) === id)) {
        pendingUnignores.delete(id);
      }
    }
    return rules.concat(pendingIgnores);
  }

  /**
   * The two passes that turn a scan into what the page shows: join current
   * state onto the dependency index, then set aside whatever the user has
   * chosen to ignore. Always in that order - a rule can cover a runtime
   * finding, so the finding has to exist before it can be hidden.
   */
  function joinRuntime(config, hass, cfg) {
    if (!config || !config.items) return config;
    /* The ignore chooser has to say what a rule would hide, which means asking
       about labels - so the model keeps the hass it was last joined against. */
    config.hass = hass;
    applyRuntime(config, hass, dependencyDeviceIndex(hass), cfg);
    applyIgnores(config, ignoreRulesOf(hass), hass);
    return config;
  }

  /**
   * Events that mean "something the inspector reads has been rewritten".
   * `lovelace_updated` fires when any dashboard is saved; `automation_reloaded`
   * fires when automations are reloaded, which is what saving one does.
   */
  const CONFIG_EVENTS = ['lovelace_updated', 'automation_reloaded', 'scene_reloaded'];

  /**
   * Events that change what a reference *means* without changing a line of
   * configuration. Deleting, renaming, disabling or re-enabling an entity, or
   * an integration registering and withdrawing its actions - after any of
   * those the fetched configuration is still current and only the existence
   * index is stale, so these take the cheap path: one round trip for the
   * registry and a re-judge of what is already in hand.
   *
   * `service_registered` / `service_removed` are also how a script reload
   * announces itself, since Home Assistant registers one action per script and
   * emits no reload event of its own.
   */
  const REGISTRY_EVENTS = ['entity_registry_updated', 'service_registered', 'service_removed'];

  /* Registry events arrive in bursts - reloading an integration can emit
     dozens - so they are collected for longer than a dashboard save is. */
  const REGISTRY_DEBOUNCE_MS = 2000;

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
        unavailable_is_fault_domains: c.unavailable_is_fault_domains === undefined
          ? DEFAULT_UNAVAILABLE_IS_FAULT : c.unavailable_is_fault_domains,
        exclude_integrations: c.exclude_integrations || DEFAULT_EXCLUDED_INTEGRATIONS,
        skip_label: c.skip_label || DEFAULT_SKIP_LABEL,
        exclude_devices: c.exclude_devices || [],
        exclude: c.exclude || [],
        cluster: Object.assign({}, DEFAULT_CLUSTER, c.cluster || {}),
        manifests: {},
      };
      this._state = { chip: 'all', confChip: 'all', conflictChip: 'all', open: new Set(), ignoring: null };
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
      liveCards.add(this);
      if (this._config && isCompact(this._config.mode)) compactPeers.add(this);
    }

    disconnectedCallback() {
      if (this._timer) window.clearInterval(this._timer);
      this._timer = null;
      liveCards.delete(this);
      /* A tile that leaves the page must stop propping its peer up. */
      if (compactPeers.delete(this)) {
        this._compactHasProblem = false;
        for (const card of compactPeers) card._renderCompact(true);
      }
      window.clearTimeout(this._changeTimer);
      window.clearTimeout(this._registryTimer);
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
      const keep = (un) => {
        /* The card may have been detached while the subscription was in
           flight, which would otherwise leak it. */
        if (this._unsubs) this._unsubs.push(un);
        else un();
      };
      for (const type of CONFIG_EVENTS) {
        Promise.resolve(conn.subscribeEvents(() => this._configChanged(), type))
          .then(keep)
          .catch(() => { /* unknown event type on this version: stay quiet */ });
      }
      for (const type of REGISTRY_EVENTS) {
        Promise.resolve(conn.subscribeEvents(() => this._registryChanged(), type))
          .then(keep)
          .catch(() => { /* unknown event type on this version: stay quiet */ });
      }
    }

    /**
     * A registry change: re-judge, do not re-fetch.
     *
     * The audit found the browser model could sit on a deleted entity until
     * the page was reopened, because nothing in the state machine changes when
     * an entity is removed from the registry. Answering it with a full rescan
     * would mean 132 round trips every time an integration reloads, so the
     * cached sources are re-inspected against a fresh registry instead.
     */
    /**
     * The backend scan republished: fold its new answer in.
     *
     * Its broken-reference list and its dependency universe both go into the
     * model at scan time, so a rescan that finds one fewer problem has to be
     * re-merged rather than merely re-drawn. Re-inspecting from the cached
     * sources is what makes that cheap enough to do on every republish.
     */
    _refreshFromBackend() {
      if (this._config.mode === 'device-compact') return;
      const previous = configCache.model;
      if (!previous || !previous.sources || configCache.running) { this._render(); return; }
      reinspectConfiguration(this._hass, this._config, previous, { refetchDeps: true })
        .then((m) => {
          if (!m || configCache.model !== previous) return;
          configCache.model = m;
          if (!this._model) return;
          this._model.config = m;
          joinRuntime(m, this._hass, this._config);
          this._render();
        })
        .catch(() => { this._render(); });
    }

    _registryChanged() {
      if (this._config.mode === 'device-compact') return;
      window.clearTimeout(this._registryTimer);
      this._registryTimer = window.setTimeout(() => {
        const previous = configCache.model;
        if (!previous || !previous.sources || configCache.running) return;
        reinspectConfiguration(this._hass, this._config, previous)
          .then((m) => {
            if (!m) return;
            /* Only if nothing else has replaced the scan in the meantime. */
            if (configCache.model !== previous) return;
            configCache.model = m;
            if (!this._model) return;
            this._model.config = m;
            joinRuntime(m, this._hass, this._config);
            this._render();
          })
          .catch(() => { /* a failed re-judge leaves the old model standing */ });
      }, REGISTRY_DEBOUNCE_MS);
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
      if (this._config.mode === 'overall-compact') {
        /* A grouped list needs the width of a row, not half of one. */
        return { rows: 'auto', columns: 'full', min_columns: 6, min_rows: 1 };
      }
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
      const mode = this._config.mode;
      /* The overall card reads the runtime model too, so it stays on the
         state-driven path and only the configuration-only tiles opt out. */
      if (mode === 'configuration-compact' || mode === 'conflicts-compact') {
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
      const noRuntime = mode === 'configuration-compact' || mode === 'conflicts-compact';
      const model = noRuntime
        ? { problems: [], lowBatteries: [], counts: {}, _now: now }
        : analyse(this._hass, this._config, now);
      model.batteryThreshold = this._config.battery_threshold;
      /* Recovery tracking is a side effect on shared storage, so it belongs to
         the modes that actually own a device model. The compact device tile
         doing it too is deliberate: it lives on a dashboard that is open all
         day, so it observes far more transitions than the Health page ever
         does, and the two agree because they compute the same set. */
      if (!noRuntime) trackRecoveries(model, this._config, now);
      model._now = now;
      /* Whatever the shared scan has produced so far; null means it is still
         running and the configuration sections say so. */
      model.config = configCache.model;
      /* The runtime join. Rewritten here rather than during the scan because
         it answers to state, not to configuration: the scan runs once, this
         runs whenever an entity a configuration item depends on changes. It
         costs a lookup per unavailable entity, not a walk of anything. */
      if (model.config) joinRuntime(model.config, this._hass, this._config);
      model.conflicts = configCache.model && configCache.model.conflicts;
      model.ops = opsModel(this._hass);
      model.hassDevices = this._hass.devices || {};
      model.skipped = skippedDevices(this._hass, this._config);
      model.unstable = unstableCache.data;
      this._model = model;
      this._render();
      /* The history sweep is one query for the whole house and it does not
         block anything: the page paints from state first and the section
         appears when the answer arrives. */
      this._scanUnstable(false);
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
          if (m) joinRuntime(m, this._hass, this._config);
          this._model.conflicts = m && m.conflicts;
          this._render();
        });
      if (force) run();
      else window.setTimeout(run, 60);
    }

    /**
     * The 24-hour availability sweep. Cached across every card on the page
     * and every render, because it answers a question about yesterday and
     * yesterday does not change every time a light switches on.
     */
    _scanUnstable(force) {
      if (!this._hass || !this._model) return;
      /* Only the modes that can show the answer pay for it. The configuration
         and conflict tiles never mention a device. */
      const mode = this._config.mode;
      if (mode === 'configuration-compact' || mode === 'conflicts-compact') return;
      if (!force && unstableCache.data &&
          Date.now() - unstableCache.at < UNSTABLE_TTL_MS) {
        /* Already answered, possibly for a different card. */
        if (this._model.unstable !== unstableCache.data) {
          this._model.unstable = unstableCache.data;
          this._render();
        }
        return;
      }
      if (this._unstabling) return;
      this._unstabling = true;
      getUnstable(this._hass, force).then((result) => {
        this._unstabling = false;
        if (!result) return;
        for (const card of liveCards) {
          if (!card._model) continue;
          card._model.unstable = result;
          card._render();
        }
      });
    }

    /** Ages only: no model rebuild, no innerHTML churn on the whole page. */
    _tick() {
      if (!this._model) return;
      /* The one exception. Availability answers a question about the last
         day, so nothing in the state machine ever prompts a refresh - a house
         where nothing changes is exactly the house whose overnight outage
         would otherwise stay on the page forever. The cache decides whether
         this actually queries anything. */
      this._scanUnstable(false);
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
        else if (name === 'system') parts.push(systemSection(model));
        else if (name === 'unstable') parts.push(unstableSection(model));
        else if (name === 'summary') parts.push(summarySection(model, cfg));
        else if (name === 'config_summary') parts.push(configSummarySection(model));
        else if (name === 'config') parts.push(configSection(model, this._state));
        else if (name === 'conflicts') parts.push(conflictsSection(model, this._state));
        else if (name === 'clusters') parts.push(clustersSection(model));
        else if (name === 'attention') parts.push(attentionSection(model, this._state, cfg));
        else if (name === 'battery') parts.push(this._state.chip === 'battery' ? '' : batterySection(model, cfg));
        else if (name === 'recovered') parts.push(recoveredSection(model, cfg));
        else if (name === 'deleted') parts.push(deletedSection(model, cfg));
        else if (name === 'skipped') parts.push(skippedSection(model));
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

      /* The overall card stands alone: it already contains every group, so it
         has no partner to keep a row even with. */
      if (mode === 'overall-compact') {
        const view = overallCompact(this._model);
        this.hidden = !view && !this._inEditor();
        const root = this._ensureRoot();
        const wrap = root.querySelector('.wrap');
        wrap.innerHTML = view ? overallHtml(view, this._config.navigation_path) : '';
        if (view) {
          const card = root.querySelector('ha-card');
          if (card) {
            card.title = view.word + ' — ' +
              view.groups.map((g) => g.label + ': ' + g.items.join(', ')).join(' · ');
          }
        }
        return;
      }

      const problem = mode === 'device-compact'
        ? deviceCompact(this._model, this._config)
        : mode === 'conflicts-compact'
          ? conflictsCompact(this._model.conflicts)
          : configCompact(this._model.config, this._model.ops);

      /* Published before the peers are consulted, so they read the current
         answer rather than the previous one. */
      const changed = this._compactHasProblem !== !!problem;
      this._compactHasProblem = !!problem;

      const show = visibleCompactModes().has(mode);
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

      /* One tile's verdict changing can change which tiles the whole group
         shows, so the peers re-render. A peer re-render never changes its own
         verdict, so this recurses exactly one level and cannot loop. */
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
    /**
     * Adds or removes the skip label on a device.
     *
     * The label is created on first use rather than requiring the user to make
     * one by hand, and the write goes through the device registry so every
     * browser and tablet sees the same list. `hass.devices` is replaced by the
     * registry subscription once the write lands, which is what re-renders the
     * page - there is nothing to poll and no local copy to keep in step.
     */
    /**
     * Write an ignore rule, and show its effect immediately.
     *
     * The store is on the Home Assistant side, not in this browser: the same
     * answer has to hold on every wall tablet, and this install has thirteen
     * accounts. The backend rescans and republishes after every change, but
     * that round trip takes a second or two, so the rule is applied locally
     * first and drops out of `pendingIgnores` as soon as the published list
     * carries it.
     */
    async _ignore(rule, button) {
      const hass = this._hass;
      if (!hass) return;
      if (button) button.classList.add('is-busy');
      const id = rule.id || rule.scope + ':' + rule.value + ':' + (rule.item || '') + ':' + (rule.kind || '');
      try {
        pendingIgnores.push({ ...rule, id });
        this._state.ignoring = null;
        if (this._model && this._model.config) joinRuntime(this._model.config, hass, this._config);
        this._render();
        await hass.callWS({
          type: 'call_service', domain: 'pyscript', service: 'config_health_ignore',
          service_data: { scope: rule.scope, value: rule.value, item: rule.item || null },
        });
      } catch (e) {
        /* The rule never landed, so it must not keep hiding anything. */
        const at = pendingIgnores.findIndex((r) => r.id === id);
        if (at >= 0) pendingIgnores.splice(at, 1);
        if (this._model && this._model.config) joinRuntime(this._model.config, hass, this._config);
        this._render();
        if (button) {
          button.classList.remove('is-busy');
          button.classList.add('is-failed');
          button.setAttribute('title', 'Could not save the rule: ' + (e && e.message ? e.message : e));
        }
      }
    }

    async _unignore(ruleId, button) {
      const hass = this._hass;
      if (!hass || !ruleId) return;
      if (button) button.classList.add('is-busy');
      try {
        pendingUnignores.add(ruleId);
        const at = pendingIgnores.findIndex((r) => r.id === ruleId);
        if (at >= 0) pendingIgnores.splice(at, 1);
        if (this._model && this._model.config) joinRuntime(this._model.config, hass, this._config);
        this._render();
        await hass.callWS({
          type: 'call_service', domain: 'pyscript', service: 'config_health_unignore',
          service_data: { rule_id: ruleId },
        });
      } catch (e) {
        pendingUnignores.delete(ruleId);
        if (this._model && this._model.config) joinRuntime(this._model.config, hass, this._config);
        this._render();
        if (button) {
          button.classList.remove('is-busy');
          button.classList.add('is-failed');
          button.setAttribute('title', 'Could not remove the rule: ' + (e && e.message ? e.message : e));
        }
      }
    }

    async _setSkipped(deviceId, on, button) {
      const hass = this._hass;
      if (!hass || !deviceId) return;
      const label = this._config.skip_label;
      if (button) button.classList.add('is-busy');
      try {
        if (on) {
          /* Creating it every time would fail on the second device, so the
             registry is consulted first. */
          const labels = await hass.callWS({ type: 'config/label_registry/list' });
          if (!labels.some((l) => l.label_id === label)) {
            await hass.callWS({
              type: 'config/label_registry/create',
              name: SKIP_LABEL_NAME,
              icon: 'mdi:eye-off-outline',
              color: 'grey',
            });
          }
        }
        const device = (hass.devices || {})[deviceId] || {};
        const current = device.labels || [];
        const next = on
          ? (current.indexOf(label) >= 0 ? current : current.concat(label))
          : current.filter((l) => l !== label);
        await hass.callWS({ type: 'config/device_registry/update', device_id: deviceId, labels: next });
        /* The registry push is what normally redraws the page, but a card
           whose config named the device statically would never see one. */
        this._signature = null;
        this._update();
      } catch (e) {
        if (button) {
          button.classList.remove('is-busy');
          button.classList.add('is-failed');
          button.setAttribute('title', 'Could not update the device: ' + (e && e.message ? e.message : e));
        }
      }
    }

    /**
     * Open the editor for an automation or script named by entity id.
     *
     * Automations are edited by the numeric id the state machine carries and
     * scripts by their object id, so the route cannot be built from the
     * entity id alone - and an item whose id is missing still has a
     * more-info dialog, which beats doing nothing.
     */
    _openItem(entityId) {
      const st = this._hass && this._hass.states[entityId];
      const domain = domainOf(entityId);
      if (domain === 'script') {
        return this._navigate('/config/script/edit/' + entityId.split('.')[1]);
      }
      const id = st && st.attributes && st.attributes.id;
      if (id) return this._navigate('/config/automation/edit/' + id);
      this.dispatchEvent(new CustomEvent('hass-more-info', {
        detail: { entityId }, bubbles: true, composed: true,
      }));
    }

    /** The trace list for an automation or script. */
    _openTraces(entityId) {
      const domain = domainOf(entityId);
      if (domain === 'script') {
        return this._navigate('/config/script/trace/' + entityId.split('.')[1]);
      }
      const st = this._hass && this._hass.states[entityId];
      const id = st && st.attributes && st.attributes.id;
      if (id) this._navigate('/config/automation/trace/' + id);
    }

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
        const skip = ev.target.closest('[data-skip]');
        if (skip) {
          ev.stopPropagation();
          this._setSkipped(skip.dataset.skip, true, skip);
          return;
        }
        const unskip = ev.target.closest('[data-unskip]');
        if (unskip) {
          ev.stopPropagation();
          this._setSkipped(unskip.dataset.unskip, false, unskip);
          return;
        }
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
        const execTrace = ev.target.closest('[data-exectrace]');
        if (execTrace) {
          ev.stopPropagation();
          this._openTraces(execTrace.dataset.exectrace);
          return;
        }
        const execOpen = ev.target.closest('[data-execopen]');
        if (execOpen) {
          ev.stopPropagation();
          this._openItem(execOpen.dataset.execopen);
          return;
        }
        const exec = ev.target.closest('[data-exec]');
        if (exec) {
          const key = 'exec:' + exec.dataset.exec;
          if (this._state.open.has(key)) this._state.open.delete(key);
          else this._state.open.add(key);
          this._render();
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
        const conflChip = ev.target.closest('[data-confl]');
        if (conflChip) {
          this._state.conflictChip = conflChip.dataset.confl;
          this._render();
          return;
        }
        const arm = ev.target.closest('[data-ignorearm]');
        if (arm) {
          ev.stopPropagation();
          this._state.ignoring = arm.dataset.ignorearm;
          this._render();
          return;
        }
        if (ev.target.closest('[data-ignorecancel]')) {
          ev.stopPropagation();
          this._state.ignoring = null;
          this._render();
          return;
        }
        const apply = ev.target.closest('[data-ignoreapply]');
        if (apply) {
          ev.stopPropagation();
          let rule = null;
          try { rule = JSON.parse(apply.dataset.ignoreapply); } catch (e) { rule = null; }
          if (rule) this._ignore(rule, apply);
          return;
        }
        const unignore = ev.target.closest('[data-unignore]');
        if (unignore) {
          ev.stopPropagation();
          this._unignore(unignore.dataset.unignore, unignore);
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
    applyRuntime, buildDependencyIndex, dependencyDeviceIndex,
    mergeFileDeps, mergeFileMissing, applyIgnores, ignorePreview, globToRe, summariseConfig,
    inspectSources, joinRuntime, ignoreRulesOf,
    HEALTH_SIGNALS, SEVERITY,
    buildIndex, inspectConfiguration, walkRefs, judge, findingsOf,
    analyseConflicts, conflictsCompact, overallCompact, sequenceDuration, durationSeconds, triggerOccurrences,
    collectTargets, areOpposites, clockToMinutes, minutesToClock, DEFAULT_CONFLICTS,
    deviceCompact, configCompact,
    opsModel, computeUnstable, unstableBand, unstableActive, unstableProbes, unstableRank,
    unstableCreated,
    systemSection, executionHtml, unstableSection,
    UNSTABLE: {
      warn: UNSTABLE_WARN_AVAILABILITY,
      critical: UNSTABLE_CRITICAL_AVAILABILITY,
      minTransitions: UNSTABLE_MIN_TRANSITIONS,
      disconnectAnomaly: UNSTABLE_DISCONNECT_ANOMALY,
      massRatio: UNSTABLE_MASS_RATIO,
      massPadMs: UNSTABLE_MASS_PAD_MS,
      windowMs: UNSTABLE_WINDOW_MS,
      quietMs: UNSTABLE_QUIET_MS,
      commissionMs: UNSTABLE_COMMISSION_MS,
    },
    DEFAULTS: {
      ignored_domains: DEFAULT_IGNORED_DOMAINS,
      unavailable_is_fault_domains: DEFAULT_UNAVAILABLE_IS_FAULT,
      exclude_integrations: DEFAULT_EXCLUDED_INTEGRATIONS,
      skip_label: DEFAULT_SKIP_LABEL,
      exclude_devices: [],
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

/* ---- CONFIG_HEALTH_PATCH v2 -------------------------------------------
 * Verifies the card's "unvalidated" config issues against the server-side
 * scan published on pyscript.config_health, fills the CONFIGURATION HEALTH
 * counters, and adds a BROKEN REFERENCES panel with a Fix action.
 * Additive only - delete this block to revert.
 * -------------------------------------------------------------------- */
(function () {
  "use strict";
  var ENTITY = "pyscript.config_health";
  function findings(hass) {
    var st = hass && hass.states && hass.states[ENTITY];
    var list = (st && st.attributes && st.attributes.missing) || [];
    var byRef = {};
    list.forEach(function (m) { byRef[m.entity_id] = m; });
    return { st: st, list: list, byRef: byRef };
  }

  /**
   * Links each published finding to the card item that owns it.
   *
   * It used to recompute the counters here as well, which made the file
   * scanner authoritative and quietly discarded anything only the browser had
   * found. The card now folds the published list into its own model - one
   * finding per reference per item, whichever scanner saw it - so all this has
   * to do is give the BROKEN REFERENCES panel a route back to the item.
   */
  function merge(card) {
    var cfg = card._model && card._model.config;
    if (!cfg || !cfg.counts) return;
    var f = findings(card._hass);
    if (!f.st) return;
    (cfg.items || []).forEach(function (item) {
      (item.issues || []).forEach(function (iss) {
        var rec = f.byRef[iss.ref];
        if (!rec) return;
        /* The card already worked out what this item is and how to open it.
           Keeping the link means the panel never has to re-derive a route
           from a file path and a line number. */
        if (!rec.chItem) rec.chItem = item;
      });
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var BTN = "cursor:pointer;border-radius:8px;border:1px solid var(--divider-color,#444);background:transparent;padding:4px 10px;";

  /**
   * Where the thing holding this broken reference can be edited.
   *
   * A reference the card cannot safely repair is not a dead end - it is a
   * signpost. Every kind of holder has somewhere a person can go and fix it by
   * hand, and that beats a dropdown of every sensor in the house.
   *
   * Returns {label, open(card)} or null when there is genuinely nowhere to go.
   */
  function destination(m) {
    var item = m.chItem;

    /* Automations, scripts and scenes have real editors, keyed on the id the
       state machine carries rather than the file line the scan recorded. */
    if (item && item.entityId) {
      var dom = item.entityId.split(".")[0];
      var editor = { automation: "automation", script: "script", scene: "scene" }[dom];
      if (editor) {
        return {
          label: "Open " + editor,
          open: function (card) {
            var st = card._hass.states[item.entityId];
            var id = st && st.attributes && st.attributes.id;
            /* Scripts are edited by object_id; the other two by their numeric
               id. Without one, the more-info dialog is still a way in. */
            if (dom === "script") id = item.entityId.split(".")[1];
            if (!id) return moreInfo(card, item.entityId);
            go(card, "/config/" + editor + "/edit/" + id);
          }
        };
      }
    }

    /* Dashboards: the card knows the url_path, and so does the scan. */
    var occ = (m.occurrences && m.occurrences[0]) || {};
    var urlPath = (item && item.urlPath) ||
      (String(occ.file || "").indexOf(".storage/lovelace") === 0 ? (m.dashboard || "lovelace") : null);
    if (urlPath) {
      return {
        label: "Open dashboard",
        open: function (card) { go(card, "/" + urlPath); }
      };
    }

    /* Helpers built in the UI. Home Assistant has no URL for a single config
       entry - /config/helpers/edit/<id> renders the plain list - so the way in
       is the helper's own entity, whose more-info dialog carries the settings
       cog. The entity is found through the registry, which is the only place
       config_entry_id is exposed. */
    var own = (m.owners || [])[0];
    if (own && own.entry_id) {
      return {
        label: "Open helper",
        open: function (card) {
          return card._hass.callWS({ type: "config/entity_registry/list" }).then(function (reg) {
            var hit = reg.filter(function (e) { return e.config_entry_id === own.entry_id; })[0];
            if (hit) return moreInfo(card, hit.entity_id);
            go(card, "/config/helpers");
          }).catch(function () { go(card, "/config/helpers"); });
        }
      };
    }
    return null;
  }

  function go(card, path) {
    if (typeof card._navigate === "function") return card._navigate(path);
    history.pushState(null, "", path);
    window.dispatchEvent(new CustomEvent("location-changed", { bubbles: true, composed: true }));
  }

  function moreInfo(card, entityId) {
    card.dispatchEvent(new CustomEvent("hass-more-info", {
      detail: { entityId: entityId }, bubbles: true, composed: true
    }));
  }

  function paint(card) {
    var root = card.shadowRoot;
    if (!root) return;
    var f = findings(card._hass);
    var panel = root.getElementById("ch-panel");
    /* The patch wraps _render on the prototype, so every instance runs it -
       including the one-line alert tiles on a main dashboard. Only the full
       page has room for the detail; a compact tile keeps the count, which
       merge() still supplies, and links through. */
    var mode = (card._config && card._config.mode) || "full";
    if (mode !== "full") { if (panel) panel.remove(); return; }
    if (!f.st) { if (panel) panel.remove(); return; }
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "ch-panel";
      panel.style.cssText = "margin:12px 0 0;padding:12px 14px;border-radius:12px;" +
        "background:var(--ha-card-background,var(--card-background-color,#1c1c1e));" +
        "border:1px solid var(--divider-color,#333);font-size:14px";
      root.appendChild(panel);
    }
    var rows = f.list.map(function (m) {
      var occ = (m.occurrences && m.occurrences[0]) || {};
      var where = occ.file ? esc(occ.file) + ":" + esc(occ.line) : "";
      var dup = m.malformed && m.entity_id.split(".")[0] === m.entity_id.split(".")[1];
      /* A button that says Fix should fix. When the card is not confident
         enough to rewrite anything, the honest offer is to open whatever holds
         the reference so it can be corrected in Home Assistant's own editor. */
      var dest = (dup || (m.suggestion && m.confidence >= 0.9)) ? null : destination(m);
      var label = dup ? "Fix typo"
        : (m.suggestion && m.confidence >= 0.9) ? "Fix"
        : dest ? dest.label
        : "Choose";
      /* A helper or script that nothing references, pointing at something that
         no longer exists, is a dead end rather than a repair job. Offering to
         remove it is usually the honest answer - but only when the scan has
         actually established it is unreferenced. */
      var idx = f.list.indexOf(m);
      var dead = (m.holders || []).filter(function (h) { return h.unused; });
      var dels = dead.map(function (h, hi) {
        var name = h.title || h.entity_id || "";
        var lbl = dead.length > 1
          ? "Delete " + (name.length > 16 ? name.slice(0, 15) + "…" : name)
          : "Delete";
        return '<button data-del="' + idx + ":" + hi + '" title="' +
          esc("Delete the " + h.kind + " “" + name + "”, which nothing references") +
          '" style="' + BTN + 'margin-left:6px;color:var(--error-color,#db4437)">' + esc(lbl) + "</button>";
      }).join("");
      var action = '<span data-slot="1"><button data-idx="' + idx +
        '" style="' + BTN + 'color:var(--primary-color,#03a9f4)">' + label + "</button>" + dels + "</span>";
      var hint = m.suggestion
        ? '<div style="opacity:.65;font-size:12px">&rarr; ' + esc(m.suggestion) +
          " (" + Math.round((m.confidence || 0) * 100) + "%)</div>"
        : "";
      return '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;' +
        'border-top:1px solid var(--divider-color,#2a2a2a)">' +
        '<div style="flex:1;min-width:0"><div style="overflow-wrap:anywhere">' +
        esc(m.entity_id) + '</div><div style="opacity:.55;font-size:12px;overflow-wrap:anywhere">' +
        where + "</div>" + hint + "</div>" + action + "</div>";
    });
    panel.innerHTML = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
      '<span style="letter-spacing:.08em;opacity:.7">BROKEN REFERENCES</span>' +
      '<span style="opacity:.5;font-size:12px">' + f.list.length + " found &middot; " +
      esc(f.st.attributes.dynamic_refs || 0) + " dynamic skipped</span>" +
      '<span style="flex:1"></span>' +
      '<button id="ch-rescan" style="' + BTN + 'color:inherit">Rescan</button></div>' +
      (rows.length ? rows.join("") : '<div style="padding:8px 0;opacity:.6">No broken references.</div>');
    var rescan = root.getElementById("ch-rescan");
    if (rescan) rescan.onclick = function () {
      rescanAndRedraw(card, rescan);
    };
    Array.prototype.forEach.call(panel.querySelectorAll("button[data-idx]"), function (btn) {
      btn.onclick = function () {
        onFix(card, f.list[Number(btn.getAttribute("data-idx"))], btn);
      };
    });
    Array.prototype.forEach.call(panel.querySelectorAll("button[data-del]"), function (btn) {
      btn.onclick = function () {
        var parts = btn.getAttribute("data-del").split(":");
        var rec = f.list[Number(parts[0])];
        var dead = (rec.holders || []).filter(function (h) { return h.unused; });
        onDelete(card, dead[Number(parts[1])], btn);
      };
    });
  }

  function wrap(proto, name, after) {
    var orig = proto[name];
    if (typeof orig !== "function" || orig.__chPatched) return;
    function patched() {
      var out = orig.apply(this, arguments);
      var self = this;
      function run() {
        try { after(self); } catch (e) { console.warn("[config-health]", e); }
      }
      if (out && typeof out.then === "function") {
        return out.then(function (v) { run(); return v; });
      }
      run();
      return out;
    }
    patched.__chPatched = true;
    proto[name] = patched;
  }

  function install() {
    var Ctor = customElements.get("device-health-card");
    if (!Ctor) return false;
    var proto = Ctor.prototype;
    var orig = proto._render;
    if (typeof orig === "function" && !orig.__chPatched) {
      var patched = function () {
        try { merge(this); } catch (e) { console.warn("[config-health]", e); }
        var out = orig.apply(this, arguments);
        try { paint(this); } catch (e) { console.warn("[config-health]", e); }
        return out;
      };
      patched.__chPatched = true;
      proto._render = patched;
    }

    /* Follow the scan entity.
     *
     * The card decides whether to re-render from a signature over the states
     * that can change what it draws, and pyscript.config_health is not one of
     * them - it is neither unavailable, unknown, a battery nor a connectivity
     * sensor. So a finished rescan republished without anything redrawing, and
     * a reference that had just been deleted sat on screen looking undeleted.
     *
     * Hooking the hass setter catches it whoever asked for the scan: this
     * card, another tab, or the nightly one. Cheaper than a subscription, and
     * it is one string compare per state change. */
    var desc = Object.getOwnPropertyDescriptor(proto, "hass");
    if (desc && typeof desc.set === "function" && !desc.set.__chPatched) {
      var origSet = desc.set;
      var patchedSet = function (hass) {
        var prev = this.__chGeneration;
        origSet.call(this, hass);
        var st = hass && hass.states && hass.states[ENTITY];
        var gen = (st && st.attributes && st.attributes.generated) || null;
        if (gen === prev) return;
        this.__chGeneration = gen;
        /* Not on the first sighting: the card is about to render anyway, and
           rendering before it has a model throws. */
        if (prev === undefined || !this._model) return;
        try {
          /* A republished scan is new data, not just a repaint: its broken
             references and its dependency edges both have to be folded back
             into the model before anything is drawn. */
          if (typeof this._refreshFromBackend === "function") this._refreshFromBackend();
          else this._render();
        } catch (e) { console.warn("[config-health]", e); }
      };
      patchedSet.__chPatched = true;
      Object.defineProperty(proto, "hass", {
        get: desc.get,
        set: patchedSet,
        enumerable: desc.enumerable,
        configurable: true,
      });
    }
    return true;
  }


  function busy(btn, text) { btn.disabled = true; btn.textContent = text; }

  function arm(btn, go) {
    if (btn.getAttribute("data-armed") !== "1") {
      var was = btn.textContent;
      btn.setAttribute("data-armed", "1");
      btn.textContent = "Confirm?";
      setTimeout(function () {
        if (btn.isConnected && btn.getAttribute("data-armed") === "1") {
          btn.setAttribute("data-armed", "0");
          btn.textContent = was;
        }
      }, 4000);
      return;
    }
    go();
  }

  function run(card, m, replacement, dedup, btn) {
    busy(btn, "Fixing...");
    applyFix(card, m, replacement, dedup).then(
      function () {
        btn.textContent = "Done";
      },
      function (e) {
        btn.disabled = false;
        btn.textContent = "Failed";
        btn.title = String(e && e.message ? e.message : e);
        console.warn("[config-health]", e);
      }
    );
  }

  /**
   * Removes a helper or script that nothing references.
   *
   * Deleting is irreversible, so it goes through the same two-step confirm the
   * fix button uses, and Home Assistant performs the removal through its own
   * APIs rather than anything here touching a file.
   */
  function generatedAt(card) {
    var st = card._hass && card._hass.states && card._hass.states[ENTITY];
    return (st && st.attributes && st.attributes.generated) || null;
  }

  /**
   * Asks for a rescan and redraws once it lands.
   *
   * Neither half happens on its own. The scan walks the whole configuration,
   * so it finishes seconds after the service call returns; and the entity it
   * republishes to is not part of the card's render signature, so the new
   * state alone would never repaint anything. Without this, a deleted
   * reference sits on screen looking undeleted.
   *
   * The redraw is a full `_render` rather than just the panel, because the
   * CONFIGURATION HEALTH counters are filled in by merge() on render and would
   * otherwise keep counting what is gone.
   */
  function rescanAndRedraw(card, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Rescanning…"; }
    return card._hass.callService("pyscript", "config_health_rescan", {});
  }

  function onDelete(card, holder, btn) {
    if (!holder) return;
    arm(btn, function () {
      busy(btn, "Deleting...");
      var done;
      if (holder.kind === "helper" && holder.entry_id) {
        /* Deleting a config entry is REST, not websocket - there is no
           `config_entries/delete` command, and asking for one fails with
           `unknown_command`. */
        done = card._hass.callApi("DELETE", "config/config_entries/entry/" + holder.entry_id);
      } else if (holder.kind === "script" && holder.object_id) {
        done = card._hass.callApi("DELETE", "config/script/config/" + holder.object_id);
      } else {
        done = Promise.reject(new Error("nothing identified to delete"));
      }
      done.then(function () {
        btn.textContent = "Deleted";
        /* Home Assistant writes .storage on a delay, and the scanner reads
           those files rather than the running registry. Rescanning the
           instant the delete returns can therefore read the pre-delete file
           and leave the row on screen, which looks exactly like the delete
           having failed. A short wait costs nothing and removes the race. */
        if (btn) { btn.disabled = true; btn.textContent = "Rescanning…"; }
        return new Promise(function (resolve) { setTimeout(resolve, 10000); })
          .then(function () { return rescanAndRedraw(card, btn); });
      }, function (e) {
        btn.disabled = false;
        btn.textContent = "Failed";
        var why = String((e && (e.message || e.body || e.error)) || e);
        btn.title = why;
        /* A tooltip is not a report. Say what went wrong where it can be
           read, or the next person has to come and ask. */
        var row = btn.parentNode && btn.parentNode.parentNode;
        var text = row && row.querySelector("div");
        if (text) {
          var note = document.createElement("div");
          note.style.cssText = "color:var(--error-color,#db4437);font-size:12px;margin-top:2px";
          note.textContent = "Delete failed: " + why;
          text.appendChild(note);
        }
        console.warn("[config-health]", e);
      });
    });
  }

  function onFix(card, m, btn) {
    if (!m) return;
    var dup = m.malformed && m.entity_id.split(".")[0] === m.entity_id.split(".")[1];
    if (dup || (m.suggestion && m.confidence >= 0.9)) {
      arm(btn, function () { run(card, m, dup ? null : m.suggestion, dup, btn); });
      return;
    }
    /* Not confident enough to rewrite: take the reader to the holder instead.
       The picker below stays only for the case with nowhere to go. */
    var dest = destination(m);
    if (dest) { dest.open(card); return; }
    var slot = btn.parentNode;
    var dom = m.entity_id.split(".")[0];
    var sel = document.createElement("select");
    sel.style.cssText = "max-width:180px;border-radius:8px;padding:3px;margin-right:6px";
    var blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "pick replacement...";
    sel.appendChild(blank);
    Object.keys(card._hass.states).filter(function (id) {
      return id.indexOf(dom + ".") === 0;
    }).sort().forEach(function (id) {
      var o = document.createElement("option");
      o.value = id;
      o.textContent = id;
      if (id === m.suggestion) o.selected = true;
      sel.appendChild(o);
    });
    var go = document.createElement("button");
    go.textContent = "Apply";
    go.setAttribute("style", btn.getAttribute("style"));
    go.onclick = function () {
      if (!sel.value) return;
      run(card, m, sel.value, false, go);
    };
    slot.innerHTML = "";
    slot.appendChild(sel);
    slot.appendChild(go);
  }

  function swap(text, m, replacement, dedup) {
    if (dedup) {
      var dom = m.entity_id.split(".")[0];
      return text.split(dom + "." + dom + ".").join(dom + ".");
    }
    var esc2 = m.entity_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(esc2 + "(?![A-Za-z0-9_])", "g"), replacement);
  }

  function fixDashboard(card, m, replacement, dedup) {
    var url = m.dashboard || null;
    return card._hass.callWS({ type: "lovelace/config", url_path: url }).then(function (cfg) {
      var before = JSON.stringify(cfg);
      var after = swap(before, m, replacement, dedup);
      if (after === before) throw new Error("no match in dashboard " + (url || "default"));
      return card._hass.callWS({ type: "lovelace/config/save", url_path: url, config: JSON.parse(after) });
    }).then(function () {
      return card._hass.callService("pyscript", "config_health_rescan", {});
    });
  }

  var OPT = "config/config_entries/options/flow";

  function applyFix(card, m, replacement, dedup) {
    var file = (m.occurrences && m.occurrences[0] && m.occurrences[0].file) || "";
    if (file.indexOf(".storage/lovelace") === 0) return fixDashboard(card, m, replacement, dedup);
    if (file === ".storage/core.config_entries") return fixHelper(card, m, replacement);
    return card._hass.callService("pyscript", "config_health_fix",
      { entity_id: m.entity_id, replacement: replacement });
  }

  function rebuild(fields, m, replacement, missing) {
    var data = {};
    (fields || []).forEach(function (fld) {
      var cur = fld.description && fld.description.suggested_value;
      if (fld.type === "expandable") {
        var sub = rebuild(fld.schema, m, replacement, missing);
        if (Object.keys(sub).length) data[fld.name] = sub;
        return;
      }
      if (cur !== undefined) {
        data[fld.name] = typeof cur === "string" ? swap(cur, m, replacement, false) : cur;
      } else if (fld.required) {
        missing.push(fld.name);
      }
    });
    return data;
  }

  function fixHelper(card, m, replacement) {
    var own = (m.owners || [])[0];
    if (!own) return Promise.reject(new Error("no owning helper recorded"));
    var hass = card._hass;
    return hass.callApi("POST", OPT, { handler: own.entry_id }).then(function (step) {
      var missing = [];
      var data = rebuild(step.data_schema, m, replacement, missing);
      if (missing.length) {
        return hass.callApi("DELETE", OPT + "/" + step.flow_id).then(function () {
          throw new Error("form not reproducible; missing " + missing.join(","));
        });
      }
      return hass.callApi("POST", OPT + "/" + step.flow_id, data);
    }).then(function () {
      return card._hass.callService("pyscript", "config_health_rescan", {});
    });
  }

  if (!install()) {
    customElements.whenDefined("device-health-card").then(install);
  }
})();
