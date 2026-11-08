// Detect Idle - Electron main process
// Two apps from one codebase (role fixed at build time):
//   client:     belongs to a project (shared code). Turns monitoring ON/OFF per freelancer,
//               sets its own idle limit and shows the red alert popup.
//   freelancer: joins one or more projects and reports Windows idle time (no keylogging)
//               to EVERY client of each project. The freelancer has no on/off control.

const { app, BrowserWindow, Tray, Menu, ipcMain, powerMonitor, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const { createHub, WS_PORT } = require('./hub');
const { findClients } = require('./discover');
const { ActivityTracker } = require('./activity');
const { startAutoUpdate } = require('./updater');

// ---------- role ----------
const roleArg = (process.argv.find(a => a.startsWith('--role=')) || '').slice(7);
const ROLE = require('../package.json').detectIdleRole
  || (roleArg === 'freelancer' ? 'freelancer' : 'client');
const APP_TITLE = ROLE === 'client' ? 'Detect Idle - Client' : 'Detect Idle - Freelancer';
const APP_ID = `com.detectidle.${ROLE}`;
// Separate settings folder per role, so both apps can run side by side on one PC.
// --profile=name gives a separate settings folder (to test next to an installed copy, also in built apps).
const profileArg = (process.argv.find(a => a.startsWith('--profile=')) || '').slice(10);
app.setPath('userData', path.join(app.getPath('appData'),
  `detect-idle-${ROLE}${profileArg ? '-' + profileArg.replace(/[^\w-]/g, '') : ''}`));
// Dev only: --port=N runs the Client hub on another port (to test several clients on one PC).
const portArg = !app.isPackaged && Number((process.argv.find(a => a.startsWith('--port=')) || '').slice(7));

const APP_ICON = path.join(__dirname, 'assets', `icon-${ROLE}.ico`);
const HEARTBEAT_MS = 10 * 1000;
const REDISCOVER_MS = 20 * 1000; // look for newly joined clients of a project
// Let the alert popup play its warning sound without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let win = null;
let tray = null;
let quitting = false;

// ---------- config ----------
const configPath = () => path.join(app.getPath('userData'), 'config.json');
let config = {};
function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
}
function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

const CODE_RE = /^[A-Z0-9]{6}$/;
const normCode = c => String(c || '').trim().toUpperCase();

// ---------- UI state ----------
const state = {
  connected: false, // client: hub listening
  error: null,
  idleSeconds: 0,   // freelancer
  freelancers: [],  // client
  alerts: [],       // client
};

function localIPs() {
  const ips = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  // Prefer normal private LAN ranges; hide VPN/proxy ranges like 198.18.x.x.
  const lan = ips.filter(ip => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip));
  return lan.length ? lan : ips;
}

function publicState() {
  const base = { ...state, role: ROLE, appTitle: APP_TITLE, appVersion: app.getVersion() };
  if (ROLE === 'client') {
    return {
      ...base,
      setupDone: true,
      teamCode: config.teamCode || '',
      clientName: clientName(),
      thresholdMinutes: config.thresholdMinutes,
      localIPs: localIPs(),
    };
  }
  return {
    ...base,
    setupDone: !!config.name,
    name: config.name || '',
    projects: [...projects.values()].map(p => p.view()),
    presence,
    suspicious: suspiciousNow(),
    fakeReason: tracker.fakeReason,
    smartDetection: hookOk,
  };
}

function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
  updateTray();
}

// ---------- push alerts: animated popup at bottom-right, above all windows ----------
const POPUP_W = 350;
const POPUP_H = 158;
const MAX_POPUPS = 4;
const popups = []; // newest first

function layoutPopups() {
  const { workArea } = screen.getPrimaryDisplay();
  popups.forEach((p, i) => {
    if (p.isDestroyed()) return;
    p.setBounds({
      x: workArea.x + workArea.width - POPUP_W - 8,
      y: workArea.y + workArea.height - (i + 1) * (POPUP_H - 10) - 8,
      width: POPUP_W,
      height: POPUP_H,
    });
  });
}

function notify(alert) {
  while (popups.length >= MAX_POPUPS) popups.pop().destroy();
  const p = new BrowserWindow({
    width: POPUP_W,
    height: POPUP_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  p.setAlwaysOnTop(true, 'screen-saver'); // stay above full-screen apps too
  p.loadFile(path.join(__dirname, 'alert.html'), {
    query: { kind: alert.kind, name: alert.name || '', text: alert.text, at: String(alert.at || Date.now()) },
  });
  p.once('ready-to-show', () => p.showInactive());
  p.on('closed', () => {
    const i = popups.indexOf(p);
    if (i >= 0) popups.splice(i, 1);
    layoutPopups();
  });
  popups.unshift(p);
  layoutPopups();

  // Flash the taskbar button for danger alerts.
  if ((alert.kind === 'idle' || alert.kind === 'asleep') && win && !win.isDestroyed()) win.flashFrame(true);
}

// =====================================================================
// CLIENT
// =====================================================================
let hub = null;

function newTeamCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(6), b => chars[b % chars.length]).join('');
}

function clientName() {
  return config.clientName || os.userInfo().username || os.hostname();
}

// Monitoring is ON by default; config.paused lists the freelancers this client paused.
const isMonitored = name => !(config.paused || []).includes(name);

function startHub() {
  hub?.close();
  state.freelancers = [];
  state.error = null;
  hub = createHub({
    teamCode: config.teamCode,
    getClientName: clientName,
    getThreshold: () => config.thresholdMinutes,
    isMonitored,
    port: portArg || undefined,
    onAlert: a => {
      const alert = { ...a, at: Date.now() };
      state.alerts.unshift(alert);
      state.alerts = state.alerts.slice(0, 100);
      notify(alert);
      pushState();
    },
    onList: list => { state.freelancers = list; pushState(); },
    onError: msg => { state.error = msg; state.connected = false; pushState(); },
  });
  state.connected = true;
  pushState();
}

function startClient() {
  if (!config.teamCode) config.teamCode = newTeamCode();
  if (!config.thresholdMinutes) config.thresholdMinutes = 10;
  if (!Array.isArray(config.paused)) config.paused = [];
  saveConfig();
  startHub();
}

// =====================================================================
// FREELANCER — joins projects; connects to every client of each project
// =====================================================================
const projects = new Map(); // project id -> Project
let heartbeatTimer = null;

const withPort = host => (/:\d+$/.test(host) ? host : `${host}:${WS_PORT}`);

// ----- real vs automatic activity (see activity.js) -----
// Dev only: --presence-after=S / --presence-timeout=S shorten these for testing.
const devNum = name => !app.isPackaged && Number((process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1]);
const PRESENCE_AFTER_S = devNum('presence-after') || 120;   // automatic-looking input for 2 min -> presence check
const PRESENCE_TIMEOUT_S = devNum('presence-timeout') || 60; // seconds the freelancer has to respond
const tracker = new ActivityTracker();
let hookOk = false;
let uIOhook = null;
let presence = 'none'; // none | pending | failed
let presenceStart = 0;
let presenceWin = null;

function startInputHook() {
  try {
    ({ uIOhook } = require('uiohook-napi'));
    uIOhook.on('keydown', e => tracker.keyDown(e.keycode));
    uIOhook.on('keyup', e => tracker.keyUp(e.keycode));
    // Dev only: --test-ignore-mouse lets automated tests run while someone uses the PC's mouse.
    if (app.isPackaged || !process.argv.includes('--test-ignore-mouse')) {
      uIOhook.on('mousemove', e => tracker.mouseMove(e.x, e.y));
      uIOhook.on('mousedown', () => tracker.click());
      uIOhook.on('wheel', () => tracker.wheel());
    }
    uIOhook.start();
    hookOk = true;
  } catch (err) {
    // Fall back to plain Windows idle time if the hook can't load.
    console.error('Input hook unavailable, using basic idle detection:', err.message);
    hookOk = false;
  }
}

// Idle seconds = time since the last REAL activity. Without the hook: plain Windows idle time
// (seconds since any keyboard/mouse input, GetLastInputInfo).
function idleNow() {
  const os = powerMonitor.getSystemIdleTime();
  return hookOk ? Math.max(os, Math.floor(tracker.idleSeconds())) : os;
}

const suspiciousNow = () => hookOk && tracker.suspiciousSeconds() > 0;
const anyoneMonitoring = () => allLinks().some(l => l.connected && l.monitoring);

function openPresenceCheck() {
  if (presenceWin && !presenceWin.isDestroyed()) return;
  const W = 380, H = 100;
  const { workArea } = screen.getPrimaryDisplay();
  presenceWin = new BrowserWindow({
    width: W, height: H,
    x: workArea.x + workArea.width - W - 8,
    y: workArea.y + workArea.height - H - 8,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, skipTaskbar: true,
    alwaysOnTop: true, show: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  presenceWin.setAlwaysOnTop(true, 'screen-saver');
  presenceWin.loadFile(path.join(__dirname, 'presence.html'), { query: { seconds: String(PRESENCE_TIMEOUT_S) } });
  presenceWin.once('ready-to-show', () => presenceWin?.showInactive()); // never steals focus
  presenceWin.on('closed', () => { presenceWin = null; });
}

function closePresenceCheck() {
  if (presenceWin && !presenceWin.isDestroyed()) presenceWin.destroy();
  presenceWin = null;
}

function setPresence(next) {
  if (presence === next) return;
  presence = next;
  const idle = idleNow();
  for (const l of allLinks()) l.sendStatus(idle); // tell clients right away
  pushState();
}

// Runs every second (freelancer).
function presenceTick() {
  if (!hookOk) return;
  if (presence === 'none') {
    if (anyoneMonitoring() && tracker.suspiciousSeconds() >= PRESENCE_AFTER_S) {
      presenceStart = Date.now();
      openPresenceCheck();
      setPresence('pending');
    }
  } else if (tracker.lastReal > presenceStart || !anyoneMonitoring()) {
    // Real mouse movement, typing or the "I'm here" button -> present (or nobody is monitoring).
    closePresenceCheck();
    setPresence('none');
  } else if (presence === 'pending' && Date.now() - presenceStart > PRESENCE_TIMEOUT_S * 1000) {
    closePresenceCheck();
    setPresence('failed'); // clients get the "possibly asleep" alert
  }
}

// One connection to one Client app.
class Link {
  constructor(project, id, host) {
    this.project = project;
    this.id = id;
    this.host = host;
    this.ws = null;
    this.timer = null;
    this.closed = false;
    this.connected = false;
    this.error = null;
    this.clientName = null;
    this.thresholdMinutes = null;
    this.monitoring = false;
    this.lostSince = null; // when the connection was lost (to drop clients that left)
    this.connect();
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  sendStatus(idleSeconds = idleNow()) {
    this.send({ type: 'status', idleSeconds, asleep: presence === 'failed', suspicious: suspiciousNow() });
  }

  dropSocket() {
    clearTimeout(this.timer);
    if (this.ws) { this.ws.removeAllListeners(); try { this.ws.terminate(); } catch {} this.ws = null; }
  }

  connect() {
    this.dropSocket();
    if (this.closed) return;
    const socket = new WebSocket(`ws://${this.host}`, { handshakeTimeout: 5000 });
    this.ws = socket;

    socket.on('open', () => {
      this.send({ type: 'freelancer-hello', teamCode: this.project.entry.teamCode, name: config.name });
    });

    socket.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'welcome-freelancer' || msg.type === 'config') {
        this.connected = true;
        this.error = null;
        this.lostSince = null;
        this.thresholdMinutes = msg.thresholdMinutes;
        this.monitoring = !!msg.monitoring;
        if (msg.clientName) this.clientName = msg.clientName;
        if (msg.type === 'welcome-freelancer') this.sendStatus();
      } else if (msg.type === 'error') {
        this.error = msg.error;
        this.connected = false;
        // This client is no longer in the project -> forget it.
        if (/project code/i.test(msg.error)) return this.project.dropLink(this.id);
      }
      pushState();
    });

    socket.on('close', () => {
      if (this.ws !== socket) return;
      if (this.connected || !this.lostSince) this.lostSince = Date.now();
      this.connected = false;
      pushState();
      if (!this.closed) this.timer = setTimeout(() => this.connect(), 5000);
    });

    socket.on('error', err => {
      this.error = err.code || err.message;
    });
  }

  close() {
    this.closed = true;
    this.dropSocket();
  }

  view() {
    return {
      id: this.id,
      name: this.clientName || this.host.replace(/:\d+$/, ''),
      host: this.host,
      connected: this.connected,
      error: this.error,
      thresholdMinutes: this.thresholdMinutes,
      monitoring: this.monitoring,
    };
  }
}

// One project = one code, possibly several Client apps.
class Project {
  constructor(entry) {
    this.entry = entry; // saved in config.projects: { id, teamCode, label, clientAddress }
    this.links = new Map(); // hub id -> Link
    this.searching = false;
    this.lastSearch = 0;
    this.closed = false;
    this.discover();
    this.discoverTimer = setInterval(() => this.discover(), REDISCOVER_MS);
  }

  async discover() {
    if (this.closed || this.searching) return;
    this.searching = true;
    pushState();
    const found = await findClients(this.entry.teamCode);
    if (this.entry.clientAddress) {
      const host = withPort(this.entry.clientAddress.trim());
      found.push({ id: `manual:${host}`, host });
    }
    this.searching = false;
    this.lastSearch = Date.now();
    if (this.closed) return;

    for (const { id, host } of found) {
      const link = this.links.get(id);
      if (!link) this.links.set(id, new Link(this, id, host));
      else if (link.host !== host && !link.connected) { link.host = host; link.connect(); }
    }
    // Forget clients that have been unreachable for 2+ minutes and no longer answer discovery.
    const ids = new Set(found.map(f => f.id));
    for (const [id, link] of this.links) {
      if (!ids.has(id) && !link.connected && link.lostSince && Date.now() - link.lostSince > 120000) {
        this.dropLink(id);
      }
    }
    pushState();
  }

  dropLink(id) {
    this.links.get(id)?.close();
    this.links.delete(id);
    pushState();
  }

  reconnectAll() {
    for (const l of this.links.values()) l.connect();
    this.discover();
  }

  close() {
    this.closed = true;
    clearInterval(this.discoverTimer);
    for (const l of this.links.values()) l.close();
    this.links.clear();
  }

  view() {
    return {
      id: this.entry.id,
      teamCode: this.entry.teamCode,
      label: this.entry.label || '',
      searching: this.searching,
      clients: [...this.links.values()].map(l => l.view()),
    };
  }
}

function migrateFreelancerConfig() {
  // v1 stored one client as config.teamCode; v2 stored config.clients. Both become projects.
  if (!Array.isArray(config.projects)) {
    const old = Array.isArray(config.clients) ? config.clients
      : config.teamCode ? [{ teamCode: config.teamCode, clientAddress: config.clientAddress || '' }] : [];
    config.projects = old.map(c => ({
      id: c.id || crypto.randomUUID(), teamCode: c.teamCode, label: c.label || '', clientAddress: c.clientAddress || '',
    }));
    for (const k of ['clients', 'teamCode', 'clientAddress', 'lastHost']) delete config[k];
    saveConfig();
  }
}

function addProject({ teamCode, label, clientAddress }) {
  teamCode = normCode(teamCode);
  if (!CODE_RE.test(teamCode)) return { error: 'Project code must be 6 letters/numbers.' };
  if (config.projects.some(p => p.teamCode === teamCode)) return { error: 'You are already in this project.' };
  const entry = {
    id: crypto.randomUUID(),
    teamCode,
    label: String(label || '').trim().slice(0, 40),
    clientAddress: String(clientAddress || '').trim(),
  };
  config.projects.push(entry);
  saveConfig();
  projects.set(entry.id, new Project(entry));
  pushState();
  return { ok: true };
}

function removeProject(id) {
  projects.get(id)?.close();
  projects.delete(id);
  config.projects = config.projects.filter(p => p.id !== id);
  saveConfig();
  pushState();
}

function allLinks() {
  return [...projects.values()].flatMap(p => [...p.links.values()]);
}

function startFreelancer() {
  migrateFreelancerConfig();
  if (config.name) for (const entry of config.projects) projects.set(entry.id, new Project(entry));

  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    const idle = idleNow();
    for (const l of allLinks()) l.sendStatus(idle);
  }, HEARTBEAT_MS);

  startInputHook();

  // Every second: presence check + refresh the on-screen idle timer (sent to clients every 10s).
  setInterval(() => {
    presenceTick();
    state.idleSeconds = idleNow();
    if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('state', publicState());
  }, 1000);
}

// =====================================================================
// WINDOW + TRAY
// =====================================================================
function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    // +16px for the 8px transparent margin that holds the rounded card's shadow
    width: ROLE === 'client' ? 476 : 376,
    height: ROLE === 'client' ? 664 : 600,
    resizable: false,
    title: APP_TITLE,
    frame: false,       // custom title bar inside the app (see .topbar in styles.css)
    transparent: true,  // needed for rounded corners on Windows
    backgroundColor: '#00000000',
    hasShadow: false,   // the shadow is drawn in CSS around the rounded card
    autoHideMenuBar: true,
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  // Closing the window keeps the app running in the tray.
  win.on('close', e => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
}

function updateTray() {
  if (!tray) return;
  let tip = APP_TITLE;
  if (ROLE === 'freelancer') {
    const watching = allLinks().filter(l => l.connected && l.monitoring).length;
    tip += watching ? ` - Monitored by ${watching} client${watching > 1 ? 's' : ''}` : ' - Not monitored';
  } else {
    tip += state.connected ? ` - Project ${config.teamCode}` : ' - Error';
  }
  tray.setToolTip(tip);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open', click: showWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// =====================================================================
// IPC from the UI
// =====================================================================
ipcMain.handle('get-state', () => publicState());

// ----- freelancer -----
ipcMain.handle('setup', (_e, opts) => {
  if (ROLE !== 'freelancer') return { error: 'Not a freelancer app.' };
  const name = String(opts.name || '').trim().slice(0, 40);
  if (!name) return { error: 'Enter your name.' };
  config.name = name;
  saveConfig();
  return addProject(opts);
});
ipcMain.handle('add-project', (_e, opts) => (ROLE === 'freelancer' ? addProject(opts) : { error: 'Not a freelancer app.' }));
ipcMain.handle('remove-project', (_e, id) => removeProject(id));
ipcMain.handle('presence-confirm', () => {
  tracker.confirmPresence();
  presenceTick(); // closes the card and clears the state right away
});
ipcMain.handle('reset', () => {
  if (ROLE !== 'freelancer') return;
  for (const p of projects.values()) p.close();
  projects.clear();
  config = { projects: [] };
  saveConfig();
  pushState();
});

// ----- client -----
ipcMain.handle('set-threshold', (_e, minutes) => {
  if (ROLE !== 'client') return;
  config.thresholdMinutes = Math.max(1, Math.min(480, Math.round(Number(minutes) || 0)));
  saveConfig();
  hub?.settingsChanged();
  pushState();
});
ipcMain.handle('set-monitoring', (_e, name, on) => {
  if (ROLE !== 'client') return;
  const paused = new Set(config.paused || []);
  if (on) paused.delete(name); else paused.add(name);
  config.paused = [...paused];
  saveConfig();
  hub?.settingsChanged();
  pushState();
});
ipcMain.handle('set-client-name', (_e, name) => {
  if (ROLE !== 'client') return;
  config.clientName = String(name || '').trim().slice(0, 40);
  saveConfig();
  hub?.settingsChanged();
  pushState();
});
ipcMain.handle('join-project', (_e, code) => {
  if (ROLE !== 'client') return { error: 'Not a client app.' };
  code = normCode(code);
  if (!CODE_RE.test(code)) return { error: 'Project code must be 6 letters/numbers.' };
  if (code === config.teamCode) return { error: 'You are already in this project.' };
  config.teamCode = code;
  saveConfig();
  startHub();
  return { ok: true };
});
ipcMain.handle('new-project', () => {
  if (ROLE !== 'client') return;
  config.teamCode = newTeamCode();
  saveConfig();
  startHub();
});
ipcMain.handle('remove-freelancer', (_e, name) => hub?.remove(name));
ipcMain.handle('test-notification', () => notify({
  kind: 'idle', name: 'Test alert', text: 'This is how an idle alert looks. Alerts are working.', at: Date.now(),
}));

// ----- window -----
ipcMain.handle('win-minimize', () => win?.minimize());
ipcMain.handle('win-close', () => win?.hide()); // keeps running in the tray
ipcMain.handle('popup-close', e => BrowserWindow.fromWebContents(e.sender)?.destroy());
ipcMain.handle('popup-view', () => { showWindow(); win?.flashFrame(false); });

// =====================================================================
// LIFECYCLE
// =====================================================================
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.setAppUserModelId(APP_ID); // required for Windows notifications

  app.whenReady().then(() => {
    loadConfig();
    tray = new Tray(APP_ICON);
    tray.on('click', showWindow);
    createWindow();
    // Start with Windows so tracking/alerts keep running.
    // Portable copies run from a temporary unpacked folder, so register the portable .exe itself.
    if (app.isPackaged && !profileArg) { // not for test copies
      const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
      app.setLoginItemSettings(portableExe ? { openAtLogin: true, path: portableExe } : { openAtLogin: true });
    }

    if (ROLE === 'client') startClient();
    else startFreelancer();
    updateTray();

    // Fully automatic updates from GitHub Releases (see updater.js).
    startAutoUpdate({
      role: ROLE,
      onStatus: s => {
        state.update = s;
        // Freelancer: tell clients this is an update restart, so they show "Updating…" instead of an offline alert.
        if (s.status === 'restarting' && ROLE === 'freelancer') for (const l of allLinks()) l.send({ type: 'updating' });
        pushState();
      },
      beforeRestart: () => { quitting = true; },
    });

    powerMonitor.on('resume', () => { for (const p of projects.values()) p.reconnectAll(); });
  });

  app.on('before-quit', () => {
    quitting = true;
    hub?.close();
    try { uIOhook?.stop(); } catch {}
  });
  app.on('window-all-closed', () => { /* keep running in tray */ });
}
