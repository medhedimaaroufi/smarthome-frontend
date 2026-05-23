// ─── Config & device definitions ─────────────────────────────────────────────

const DEFAULTS = {
  url:    'wss://f2cc1208.ala.eu-central-1.emqxsl.com:8084/mqtt',
  prefix: 'smarthome/controller1',
  user:   'medhedi',
  pass:   'Dhri6qKELqbLRUf',
};

const INTERACTIVE = [
  { id: 'light1', name: 'Living Room', icon: '💡' },
  { id: 'light2', name: 'Kitchen',     icon: '💡' },
  { id: 'light3', name: 'Bedroom',     icon: '🌙' },
  { id: 'light4', name: 'Hallway',     icon: '🏠' },
  { id: 'light5', name: 'Bathroom',    icon: '🚿' },
  { id: 'light6', name: 'Garage',      icon: '🚗' },
];

const REMOTE = [
  { id: 'pump1',      name: 'Pool Pump',  icon: '🌊' },
  { id: 'tree_light', name: 'Tree Light', icon: '🌳' },
  { id: 'jacuzzi',    name: 'Jacuzzi',    icon: '♨️'  },
  { id: 'wall_light', name: 'Wall Light', icon: '🔆' },
];

// ─── App state ────────────────────────────────────────────────────────────────

let client           = null;
let deviceState      = {};   // id → 'ON' | 'OFF'
let optimisticTimers = {};

// ─── Config persistence ───────────────────────────────────────────────────────

function loadConfig() {
  try {
    const stored = JSON.parse(localStorage.getItem('casa_cfg') || '{}');
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  localStorage.setItem('casa_cfg', JSON.stringify(cfg));
}

// ─── Toast notification ───────────────────────────────────────────────────────

function toast(msg, ms = 2400) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove('show'), ms);
}

// ─── Connection status indicator ──────────────────────────────────────────────

function setConnStatus(status) {
  const pill  = document.getElementById('conn-pill');
  const label = document.getElementById('conn-label');
  pill.className = status;
  label.textContent =
    status === 'connected'  ? 'online'       :
    status === 'connecting' ? 'connecting…'  :
                              'offline';
}

// ─── Card rendering ───────────────────────────────────────────────────────────

function renderAll() {
  renderGrid('interactive-grid', INTERACTIVE);
  renderGrid('remote-grid',      REMOTE);
}

function renderGrid(containerId, devices) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = '';
  devices.forEach(d => grid.appendChild(makeCard(d)));
}

function makeCard(d) {
  const isOn = deviceState[d.id] === 'ON';
  const div  = document.createElement('div');

  div.className = `card${isOn ? ' on' : ''}`;
  div.id        = `card-${d.id}`;
  div.setAttribute('role',        'button');
  div.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  div.setAttribute('aria-label',  `${d.name}: ${isOn ? 'ON' : 'OFF'}`);

  div.innerHTML = `
    <div class="card-icon">${d.icon}</div>
    <div class="card-name">${d.name}</div>
    <div class="card-status">
      <div class="status-dot"></div>
      <span class="status-text" id="badge-${d.id}">${isOn ? 'ON' : 'OFF'}</span>
    </div>`;

  div.addEventListener('click', () => {
    const currentOn = deviceState[d.id] === 'ON';
    handleToggle(d.id, !currentOn);
  });

  return div;
}

function updateCard(id, isOn) {
  const card  = document.getElementById(`card-${id}`);
  const badge = document.getElementById(`badge-${id}`);
  if (!card) return;

  card.classList.toggle('on', isOn);
  card.classList.remove('optimistic');
  card.setAttribute('aria-pressed', isOn ? 'true' : 'false');
  card.setAttribute('aria-label',   `${id}: ${isOn ? 'ON' : 'OFF'}`);
  if (badge) badge.textContent = isOn ? 'ON' : 'OFF';
}

// ─── MQTT toggle with optimistic UI ──────────────────────────────────────────

function handleToggle(id, desiredOn) {
  const cfg      = loadConfig();
  const newState = desiredOn ? 'ON' : 'OFF';

  // Apply optimistic update immediately
  deviceState[id] = newState;
  updateCard(id, desiredOn);
  document.getElementById(`card-${id}`)?.classList.add('optimistic');

  // Revert if broker doesn't confirm within 3 s
  clearTimeout(optimisticTimers[id]);
  optimisticTimers[id] = setTimeout(() => {
    const prevOn = !desiredOn;
    deviceState[id] = prevOn ? 'ON' : 'OFF';
    updateCard(id, prevOn);
    toast(`⚠ ${id}: no confirmation — reverted`);
  }, 3000);

  if (client && client.connected) {
    const topic   = `${cfg.prefix}/devices/${id}/set`;
    const payload = JSON.stringify({ state: newState });
    client.publish(topic, payload, { qos: 1 }, err => {
      if (err) toast(`Publish error: ${err.message}`);
    });
  } else {
    toast('Not connected to broker');
  }
}

// ─── MQTT connection ──────────────────────────────────────────────────────────

function connect() {
  if (client) {
    try { client.end(true); } catch { /* ignore */ }
    client = null;
  }

  const cfg = loadConfig();
  setConnStatus('connecting');

  const opts = {
    keepalive:       30,
    connectTimeout:  10_000,
    reconnectPeriod: 4_000,
    clean:           true,
    clientId:        'casa_' + Math.random().toString(36).slice(2, 9),
  };
  if (cfg.user) opts.username = cfg.user;
  if (cfg.pass) opts.password = cfg.pass;

  try {
    client = mqtt.connect(cfg.url, opts);
  } catch (e) {
    setConnStatus('disconnected');
    toast('Connection failed: ' + e.message);
    return;
  }

  client.on('connect', () => {
    setConnStatus('connected');

    // Subscribe to individual per-device state confirmations
    client.subscribe(`${cfg.prefix}/devices/+/state`, { qos: 1 }, err => {
      if (err) toast('Subscribe error: ' + err.message);
    });

    // Subscribe to the retained bulk-state snapshot  (delivered immediately by broker)
    client.subscribe(`${cfg.prefix}/devices/state/all`, { qos: 1 }, err => {
      if (err) toast('Subscribe (all) error: ' + err.message);
    });

    // Also ask the firmware to re-publish a fresh snapshot right now
    // (covers the case where the retained message is stale / missing)
    const getAll = `${cfg.prefix}/devices/state/getAll`;
    client.publish(getAll, '', { qos: 1 }, err => {
      if (err) console.warn('getAll publish error:', err.message);
    });
  });

  client.on('reconnect', () => setConnStatus('connecting'));
  client.on('offline',   () => setConnStatus('disconnected'));
  client.on('error', e  => {
    setConnStatus('disconnected');
    toast('MQTT: ' + (e.message || e));
  });

  client.on('message', (topic, message) => {
    const activeCfg = loadConfig();

    // ── Bulk snapshot: devices/state/all ──────────────────────────────────
    const allTopic = `${activeCfg.prefix}/devices/state/all`;
    if (topic === allTopic) {
      let bulk;
      try { bulk = JSON.parse(message.toString()); } catch { return; }

      Object.entries(bulk).forEach(([id, rawState]) => {
        const isOn = (rawState || '').toUpperCase() === 'ON';

        // Cancel any pending optimistic revert — the broker is now authoritative
        clearTimeout(optimisticTimers[id]);
        delete optimisticTimers[id];

        deviceState[id] = isOn ? 'ON' : 'OFF';
        updateCard(id, isOn);
      });
      return;
    }

    // ── Individual per-device confirmation: devices/<id>/state ────────────
    const re    = new RegExp(`^${escapeRe(activeCfg.prefix)}/devices/status`);
    const match = topic.match(re);
    if (!match) return;

    const id = match[1];
    let payload;
    try { payload = JSON.parse(message.toString()); } catch { return; }

    const isOn = (payload.state || '').toUpperCase() === 'ON';

    // Broker confirmed — cancel the revert timer
    clearTimeout(optimisticTimers[id]);
    delete optimisticTimers[id];

    deviceState[id] = isOn ? 'ON' : 'OFF';
    updateCard(id, isOn);
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Settings panel ───────────────────────────────────────────────────────────

const overlay   = document.getElementById('settings-overlay');
const gearBtn   = document.getElementById('gear-btn');
const cancelBtn = document.getElementById('cancel-btn');
const saveBtn   = document.getElementById('save-btn');

function openSettings() {
  const cfg = loadConfig();
  document.getElementById('s-url').value    = cfg.url;
  document.getElementById('s-prefix').value = cfg.prefix;
  document.getElementById('s-user').value   = cfg.user;
  document.getElementById('s-pass').value   = cfg.pass;
  overlay.classList.add('open');
}

function closeSettings() {
  overlay.classList.remove('open');
}

gearBtn.addEventListener('click',   openSettings);
cancelBtn.addEventListener('click', closeSettings);
overlay.addEventListener('click', e => {
  if (e.target === overlay) closeSettings();
});

saveBtn.addEventListener('click', () => {
  const cfg = {
    url:    document.getElementById('s-url').value.trim()    || DEFAULTS.url,
    prefix: document.getElementById('s-prefix').value.trim() || DEFAULTS.prefix,
    user:   document.getElementById('s-user').value,
    pass:   document.getElementById('s-pass').value,
  };
  saveConfig(cfg);
  closeSettings();

  // Reset device state and reconnect
  deviceState = {};
  renderAll();
  connect();
  toast('Connecting to broker…');
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

renderAll();
connect();