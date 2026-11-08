const $ = id => document.getElementById(id);
let current = null;
let lastAlertAt = 0;

const RING_C = 2 * Math.PI * 88; // ring circumference (r=88)
const STATUS_LABEL = { active: 'Active', idle: 'Idle', offline: 'Offline', paused: 'Paused' };

const ICONS = {
  idle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.3-1.6M12 20h.01"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

// ---------- helpers ----------
function clock(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function initials(name) {
  return String(name).split(/[\s\-_]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
}
function hue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}
function paintAvatar(el, name, key = name) {
  el.textContent = initials(name);
  const h = hue(key);
  el.style.background = `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 48%))`;
}
function restartAnim(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth; // reflow so the animation plays again
  el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), 700);
}
function showFormError(id, msg) {
  $(id).textContent = msg || '';
  $(id).classList.toggle('hidden', !msg);
}
// Client side: freelancers report every 10s; between reports keep counting if they were idle.
function liveIdle(f) {
  if (!f.online) return 0;
  const extra = f.idleSeconds >= 10 ? (Date.now() - f.lastSeen) / 1000 : 0;
  return f.idleSeconds + Math.max(0, extra);
}

// ---------- render ----------
function render(s) {
  const first = !current;
  current = s;
  const isF = s.role === 'freelancer';

  if (first) {
    document.title = s.appTitle;
    $('roleLabel').textContent = isF ? 'Freelancer' : 'Client dashboard';
    $('logo').src = `assets/icon-${s.role}.png`;
    if (isF) $('name').value = s.name;
  }

  // connection pill
  let text, cls;
  if (isF) {
    const clients = s.projects.flatMap(p => p.clients);
    const online = clients.filter(c => c.connected).length;
    if (!s.setupDone) { text = 'Not set up'; cls = ''; }
    else if (!s.projects.length) { text = 'No projects'; cls = ''; }
    else if (online) { text = `${online} client${online > 1 ? 's' : ''} connected`; cls = 'ok'; }
    else if (s.projects.some(p => p.searching)) { text = 'Searching…'; cls = 'search'; }
    else { text = 'No clients found'; cls = 'bad'; }
  } else {
    text = s.connected ? 'Listening on network' : 'Network error';
    cls = s.connected ? 'ok' : 'bad';
  }
  $('connText').textContent = text;
  $('conn').className = 'conn ' + cls;

  $('errorText').textContent = s.error || '';
  $('error').classList.toggle('hidden', !s.error);

  $('setup').classList.toggle('hidden', !isF || s.setupDone);
  $('freelancer').classList.toggle('hidden', !isF || !s.setupDone);
  $('client').classList.toggle('hidden', isF);
  $('resetBtn').classList.toggle('hidden', !isF || !s.setupDone);

  if (isF && s.setupDone) renderFreelancer(s);
  if (!isF) renderClient(s);
}

// =====================================================================
// FREELANCER
// =====================================================================
// level for one client: off (not monitoring) / ok / warn / danger
function clientLevel(c, idle) {
  if (!c.connected || !c.monitoring) return 'off';
  const limit = (c.thresholdMinutes || 0) * 60;
  if (!limit) return 'ok';
  const r = idle / limit;
  return r >= 1 ? 'danger' : r >= 0.7 ? 'warn' : 'ok';
}
const LEVEL_RANK = { off: 0, ok: 1, warn: 2, danger: 3 };

const pcards = new Map(); // project id -> card element

function buildProjectCard(p) {
  const el = document.createElement('div');
  el.className = 'card pcard';
  el.innerHTML = `
    <div class="pcard-head">
      <div class="pmeta"><div class="pname"></div><div class="pcode"></div></div>
      <button class="btn btn-ghost btn-sm premove" title="Leave project">Leave</button>
    </div>
    <div class="pclients"></div>`;
  el.querySelector('.premove').onclick = () => {
    const now = current.projects.find(x => x.id === p.id);
    const label = now ? (now.label || now.teamCode) : p.teamCode;
    if (confirm(`Leave project "${label}"? Its clients will no longer see you.`)) window.api.removeProject(p.id);
  };
  return el;
}

function renderProjectClients(box, p, idle) {
  box.replaceChildren();
  if (!p.clients.length) {
    const d = document.createElement('div');
    d.className = 'pc-empty';
    d.textContent = p.searching ? 'Searching for clients on the network…' : 'No clients found yet. Their Client app must be running on this network.';
    box.append(d);
    return;
  }
  for (const c of p.clients) {
    const level = clientLevel(c, idle);
    const row = document.createElement('div');
    row.className = 'pc-row lvl-' + level + (c.connected ? '' : ' is-off');
    row.innerHTML = `
      <div class="avatar sm"></div>
      <div class="pc-meta"><div class="pc-name"></div><div class="pc-sub"></div></div>
      <span class="mon"></span>`;
    paintAvatar(row.querySelector('.avatar'), c.name, c.id);
    row.querySelector('.pc-name').textContent = c.name;
    let sub;
    if (!c.connected) sub = c.error === 'ECONNREFUSED' || !c.error ? 'Offline — reconnecting…' : `Offline — ${c.error}`;
    else if (!c.monitoring) sub = `Limit ${c.thresholdMinutes} min`;
    else if (level === 'danger') sub = `Idle over ${c.thresholdMinutes} min — notified`;
    else sub = `Limit ${c.thresholdMinutes} min`;
    row.querySelector('.pc-sub').textContent = sub;
    const mon = row.querySelector('.mon');
    mon.className = 'mon ' + (!c.connected ? 'm-off' : c.monitoring ? 'm-on' : 'm-paused');
    mon.textContent = !c.connected ? 'Offline' : c.monitoring ? 'Monitoring' : 'Paused';
    box.append(row);
  }
}

function renderFreelancer(s) {
  const idle = s.idleSeconds || 0;
  const list = $('projectList');
  const ids = new Set(s.projects.map(p => p.id));
  for (const [id, el] of pcards) if (!ids.has(id)) { el.remove(); pcards.delete(id); }

  let worst = 'off', worstClient = null;
  const watching = [], notified = [];
  for (const p of s.projects) {
    let el = pcards.get(p.id);
    if (!el) { el = buildProjectCard(p); pcards.set(p.id, el); list.append(el); }
    el.querySelector('.pname').textContent = p.label || `Project ${p.teamCode}`;
    const n = p.clients.length;
    el.querySelector('.pcode').textContent = `Code ${p.teamCode} · ${n} client${n === 1 ? '' : 's'}`;
    renderProjectClients(el.querySelector('.pclients'), p, idle);

    let projWorst = 'off';
    for (const c of p.clients) {
      const lv = clientLevel(c, idle);
      if (c.connected && c.monitoring) watching.push(c.name);
      if (lv === 'danger') notified.push(c.name);
      if (LEVEL_RANK[lv] > LEVEL_RANK[worst]) { worst = lv; worstClient = c; }
      if (LEVEL_RANK[lv] > LEVEL_RANK[projWorst]) projWorst = lv;
    }
    el.classList.toggle('is-danger', projWorst === 'danger');
  }
  $('noProjects').classList.toggle('hidden', s.projects.length > 0);

  // idle summary — the strictest monitoring client decides the color
  const monitored = watching.length > 0;
  const limit = worstClient && worstClient.thresholdMinutes ? worstClient.thresholdMinutes * 60 : 0;
  const ratio = limit ? Math.min(idle / limit, 1) : 0;
  const fg = $('ringFg');
  fg.style.strokeDasharray = RING_C;
  fg.style.strokeDashoffset = RING_C * (1 - (monitored ? Math.max(ratio, 0.002) : 0));
  $('ringWrap').className = 'ring-wrap ring-sm s-' + worst;
  $('idleHero').className = 'idle-hero card' + (worst === 'danger' ? ' s-danger' : '');
  $('fIdle').textContent = clock(idle);

  const uniq = a => [...new Set(a)];
  if (!monitored) {
    $('heroTitle').textContent = 'Not monitored right now';
    $('heroSub').textContent = s.projects.length ? 'Your clients turn monitoring on and off.' : 'Join a project to get started.';
  } else if (notified.length) {
    $('heroTitle').textContent = 'Idle — clients notified';
    $('heroSub').textContent = `Notified: ${uniq(notified).join(', ')}`;
  } else {
    const n = uniq(watching).length;
    $('heroTitle').textContent = `Monitored by ${n} client${n > 1 ? 's' : ''}`;
    $('heroSub').textContent = worst === 'warn' ? 'Close to an idle limit. Move the mouse or type.' : 'Each client uses its own idle limit.';
  }

  const info = $('fInfo');
  info.replaceChildren();
  const chip = document.createElement('span');
  chip.className = 'chip';
  chip.append('Signed in as ');
  const b = document.createElement('b');
  b.textContent = s.name;
  chip.append(b);
  info.append(chip);
}

// =====================================================================
// CLIENT
// =====================================================================
const cards = new Map(); // freelancer name -> row element

function buildCard(f) {
  const el = document.createElement('div');
  el.className = 'card frow';
  el.innerHTML = `
    <div class="frow-top">
      <div class="avatar"></div>
      <div class="fmeta"><div class="fname"></div><div class="badge"><span class="bdot"></span><span class="btext"></span></div></div>
      <b class="fval" title="Idle time">0:00</b>
      <button class="btn btn-ghost btn-sm fremove hidden" title="Remove from list">✕</button>
      <button class="switch" title="Monitoring ON/OFF"></button>
    </div>
    <div class="bar"><div class="bar-fill"></div></div>`;
  paintAvatar(el.querySelector('.avatar'), f.name);
  el.querySelector('.fname').textContent = f.name;
  el.querySelector('.fremove').onclick = () => window.api.removeFreelancer(f.name);
  el.querySelector('.switch').onclick = () => {
    const now = current.freelancers.find(x => x.name === f.name);
    window.api.setMonitoring(f.name, !(now && now.monitored));
  };
  return el;
}

function renderClient(s) {
  $('cTeam').textContent = s.teamCode || '------';
  $('emptyCode').textContent = s.teamCode || '';
  $('cAddr').textContent = s.localIPs.length ? `This PC: ${s.localIPs.join(', ')}` : '';
  if (document.activeElement !== $('limit') && s.thresholdMinutes) $('limit').value = s.thresholdMinutes;
  if (document.activeElement !== $('clientNameInput')) $('clientNameInput').value = s.clientName || '';

  const limit = (s.thresholdMinutes || 1) * 60;
  const grid = $('grid');
  const names = new Set(s.freelancers.map(f => f.name));
  for (const [name, el] of cards) if (!names.has(name)) { el.remove(); cards.delete(name); }

  let nActive = 0, nIdle = 0, nOffline = 0;
  const idleNames = [];
  for (const f of s.freelancers) {
    let el = cards.get(f.name);
    if (!el) { el = buildCard(f); cards.set(f.name, el); grid.append(el); }
    const idle = liveIdle(f);
    const ratio = Math.min(idle / limit, 1);
    const tracked = f.monitored && f.online;

    el.classList.toggle('is-idle', f.status === 'idle');
    el.classList.toggle('is-offline', f.status === 'offline');
    el.classList.toggle('is-not-working', f.status === 'paused');
    const badge = el.querySelector('.badge');
    badge.className = 'badge ' + f.status;
    badge.querySelector('.btext').textContent = STATUS_LABEL[f.status] || f.status;
    el.querySelector('.fval').textContent = f.online ? clock(idle) : '—';
    const fill = el.querySelector('.bar-fill');
    fill.style.width = (tracked ? ratio * 100 : 0) + '%';
    fill.className = 'bar-fill' + (!tracked ? '' : ratio >= 1 ? ' danger' : ratio >= 0.7 ? ' warn' : '');
    el.querySelector('.fremove').classList.toggle('hidden', f.online);
    el.querySelector('.switch').classList.toggle('on', f.monitored);

    if (f.status === 'active') nActive++;
    if (f.status === 'idle') { nIdle++; idleNames.push(f.name); }
    if (f.status === 'offline') nOffline++;
  }
  $('nActive').textContent = nActive;
  $('nIdle').textContent = nIdle;
  $('nOffline').textContent = nOffline;
  $('idleCount').classList.toggle('hot', nIdle > 0);
  $('empty').classList.toggle('hidden', s.freelancers.length > 0);

  // danger banner
  const banner = $('dangerBanner');
  banner.classList.toggle('hidden', nIdle === 0);
  if (nIdle) {
    $('dangerTitle').textContent = nIdle === 1 ? 'Idle alert' : `${nIdle} freelancers idle`;
    $('dangerText').textContent = nIdle === 1
      ? `${idleNames[0]} has had no keyboard or mouse activity for more than ${s.thresholdMinutes} min.`
      : `${idleNames.join(', ')} have been idle for more than ${s.thresholdMinutes} min.`;
  }

  // new idle alert -> shake banner + row
  const newest = s.alerts[0];
  if (newest && newest.at > lastAlertAt) {
    if (lastAlertAt && newest.kind === 'idle') {
      restartAnim(banner, 'shake');
      const card = cards.get(newest.name);
      if (card) restartAnim(card, 'shake');
    }
    lastAlertAt = newest.at;
    renderTimeline(s.alerts);
  } else if (!s.alerts.length && !$('alerts').children.length) {
    renderTimeline([]);
  }
}

function renderTimeline(alerts) {
  const ul = $('alerts');
  ul.replaceChildren();
  if (!alerts.length) {
    const li = document.createElement('li');
    li.className = 'timeline-empty';
    li.textContent = 'No alerts yet. Idle and offline events will appear here.';
    ul.append(li);
    return;
  }
  for (const a of alerts) {
    const li = document.createElement('li');
    li.className = 'tl-' + a.kind;
    li.innerHTML = `<div class="tl-icon">${ICONS[a.kind] || ''}</div><div class="tl-text"></div><div class="tl-time"></div>`;
    li.querySelector('.tl-text').textContent = a.text;
    li.querySelector('.tl-time').textContent = new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    ul.append(li);
  }
}

// ---------- events: freelancer ----------
$('setupForm').onsubmit = async e => {
  e.preventDefault();
  const opts = {
    name: $('name').value,
    teamCode: $('teamCode').value,
    label: $('projectLabel').value,
    clientAddress: $('clientAddress').value,
  };
  if (!opts.name.trim()) return $('name').focus();
  if (opts.teamCode.trim().length !== 6) return showFormError('setupError', 'Project code must be 6 letters/numbers.');
  const r = await window.api.setup(opts);
  showFormError('setupError', r && r.error);
  if (r && !r.error) for (const id of ['teamCode', 'projectLabel', 'clientAddress']) $(id).value = '';
};

function toggleAddForm(open) {
  $('addForm').classList.toggle('hidden', !open);
  showFormError('addError', '');
  if (open) { $('addCode').value = ''; $('addLabel').value = ''; $('addAddress').value = ''; $('addCode').focus(); }
}
$('addToggle').onclick = () => toggleAddForm($('addForm').classList.contains('hidden'));
$('addCancel').onclick = () => toggleAddForm(false);
$('addForm').onsubmit = async e => {
  e.preventDefault();
  const r = await window.api.addProject({ teamCode: $('addCode').value, label: $('addLabel').value, clientAddress: $('addAddress').value });
  if (r && r.error) return showFormError('addError', r.error);
  toggleAddForm(false);
};

$('resetBtn').onclick = () => {
  if (confirm('Sign out? This removes your name and leaves all projects on this PC.')) window.api.reset();
};

// ---------- events: client ----------
let saveTimer;
function flashSaved() {
  const note = $('savedNote');
  note.classList.add('show');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => note.classList.remove('show'), 1500);
}
function saveLimit(m) {
  m = Math.max(1, Math.min(480, Math.round(m || 0)));
  $('limit').value = m;
  window.api.setThreshold(m);
  flashSaved();
}
$('minusBtn').onclick = () => saveLimit(Number($('limit').value) - 1);
$('plusBtn').onclick = () => saveLimit(Number($('limit').value) + 1);
$('limit').onchange = () => saveLimit(Number($('limit').value));
$('limit').onkeydown = e => { if (e.key === 'Enter') $('limit').blur(); };

$('copyBtn').onclick = async () => {
  await navigator.clipboard.writeText(current.teamCode);
  $('copyText').textContent = 'Copied';
  setTimeout(() => ($('copyText').textContent = 'Copy'), 1500);
};
$('testBtn').onclick = () => window.api.testNotification();

// project settings
function toggleSettings(open) {
  $('settingsPanel').classList.toggle('hidden', !open);
  showFormError('joinError', '');
  $('joinCode').value = '';
}
$('settingsToggle').onclick = () => toggleSettings($('settingsPanel').classList.contains('hidden'));
$('settingsDone').onclick = () => toggleSettings(false);
$('clientNameInput').onchange = () => window.api.setClientName($('clientNameInput').value);
$('clientNameInput').onkeydown = e => { if (e.key === 'Enter') $('clientNameInput').blur(); };
$('joinBtn').onclick = async () => {
  const code = $('joinCode').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return showFormError('joinError', 'Project code must be 6 letters/numbers.');
  if (!confirm(`Join project ${code}? You will leave your current project ${current.teamCode}.`)) return;
  const r = await window.api.joinProject(code);
  if (r && r.error) return showFormError('joinError', r.error);
  toggleSettings(false);
};
$('newProjectBtn').onclick = () => {
  if (confirm(`Start a new project with a new code? You will leave project ${current.teamCode}.`)) {
    window.api.newProject();
    toggleSettings(false);
  }
};

// ---------- custom title bar ----------
$('minBtn').onclick = () => window.api.winMinimize();
$('closeBtn').onclick = () => window.api.winClose();

// ---------- wiring ----------
window.api.onState(render);
window.api.getState().then(render);
// Smooth 1-second updates of idle timers on the client dashboard.
setInterval(() => { if (current && current.role === 'client') renderClient(current); }, 1000);
