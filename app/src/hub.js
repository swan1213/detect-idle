// Runs inside the CLIENT app.
// Freelancer apps on the same network connect here (WebSocket) and report their idle time.
// Several Client apps can share one project code; each runs its own hub, and the freelancer
// connects to all of them. Each client decides per freelancer whether it is monitoring
// (isMonitored) and uses its own idle limit (getThreshold).
// The hub also answers UDP discovery so freelancers find this PC without typing an IP.

const { WebSocketServer } = require('ws');
const dgram = require('dgram');
const crypto = require('crypto');

const WS_PORT = 47800;
const DISCOVERY_PORT = 47801;
const OFFLINE_AFTER_MS = 60 * 1000; // no heartbeat for 60s => offline
const CHECK_EVERY_MS = 5 * 1000;

function createHub({
  teamCode, getClientName, getThreshold, isMonitored,
  onAlert, onList, onError, port = WS_PORT, discovery = true,
}) {
  const freelancers = new Map(); // name -> state
  const hubId = crypto.randomUUID(); // lets freelancers de-duplicate replies from PCs with several network adapters

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const configFor = f => ({
    type: 'config',
    thresholdMinutes: getThreshold(),
    monitoring: isMonitored(f.name),
    clientName: getClientName(),
  });

  const list = () => [...freelancers.values()].map(f => ({
    name: f.name, online: f.online, monitored: isMonitored(f.name),
    idleSeconds: f.idleSeconds, status: f.status, lastSeen: f.lastSeen,
  }));
  const pushList = () => onList(list());

  // announceBack=false when the status changed only because of a settings change.
  function evaluate(f, announceBack = true) {
    const limit = getThreshold() * 60;
    let status;
    if (!isMonitored(f.name)) status = 'paused';
    else if (!f.online || Date.now() - f.lastSeen > OFFLINE_AFTER_MS) status = 'offline';
    else if (f.idleSeconds >= limit) status = 'idle';
    else status = 'active';

    if (status === f.status) return false;
    const prev = f.status;
    f.status = status;
    if (status === 'idle') {
      onAlert({ kind: 'idle', name: f.name, text: `${f.name} has been idle for ${Math.floor(f.idleSeconds / 60)} min (limit ${getThreshold()} min).` });
    } else if (status === 'offline' && prev !== undefined && prev !== 'paused') {
      onAlert({ kind: 'offline', name: f.name, text: `${f.name} went offline (Freelancer app closed or PC disconnected).` });
    } else if (announceBack && status === 'active' && (prev === 'idle' || prev === 'offline')) {
      onAlert({ kind: 'back', name: f.name, text: `${f.name} is active again.` });
    }
    return true;
  }

  // ----- WebSocket: freelancer connections -----
  const wss = new WebSocketServer({ port });
  wss.on('error', err => onError(err.code === 'EADDRINUSE'
    ? `Port ${port} is already in use. Is another Client app running on this PC?`
    : `Network error: ${err.message}`));

  wss.on('connection', ws => {
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'freelancer-hello') {
        if (String(msg.teamCode || '').toUpperCase().trim() !== teamCode) {
          return send(ws, { type: 'error', error: 'Wrong project code.' });
        }
        const name = String(msg.name || '').trim().slice(0, 40);
        if (!name) return send(ws, { type: 'error', error: 'Name is required.' });
        const existing = freelancers.get(name);
        if (existing && existing.online && existing.ws !== ws) {
          return send(ws, { type: 'error', error: 'Someone with this name is already connected.' });
        }
        const f = existing || { name, idleSeconds: 0 };
        Object.assign(f, { ws, online: true, lastSeen: Date.now() });
        freelancers.set(name, f);
        ws.fname = name;
        send(ws, { ...configFor(f), type: 'welcome-freelancer' });
        evaluate(f);
        pushList();
        return;
      }

      if (msg.type === 'status' && ws.fname) {
        const f = freelancers.get(ws.fname);
        if (!f || f.ws !== ws) return;
        f.idleSeconds = Math.max(0, Number(msg.idleSeconds) || 0);
        f.lastSeen = Date.now();
        f.online = true;
        evaluate(f);
        pushList();
      }
    });

    ws.on('close', () => {
      const f = ws.fname && freelancers.get(ws.fname);
      if (f && f.ws === ws) {
        f.online = false;
        f.ws = null;
        evaluate(f);
        pushList();
      }
    });
  });

  // Catches freelancers whose PC slept or lost network without a clean disconnect.
  const timer = setInterval(() => {
    let changed = false;
    for (const f of freelancers.values()) changed = evaluate(f) || changed;
    if (changed) pushList();
  }, CHECK_EVERY_MS);

  // ----- UDP discovery: answer freelancers looking for this project code -----
  const udp = discovery ? dgram.createSocket({ type: 'udp4', reuseAddr: true }) : null;
  if (udp) {
    udp.on('message', (buf, rinfo) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (msg.t === 'detect-idle-discover' && String(msg.code || '').toUpperCase() === teamCode) {
        udp.send(JSON.stringify({ t: 'detect-idle-here', port, id: hubId }), rinfo.port, rinfo.address);
      }
    });
    udp.on('error', err => onError(`Discovery error: ${err.message}`));
    udp.bind(DISCOVERY_PORT);
  }

  return {
    // limit, monitoring switches or client name changed -> tell freelancers, re-check status
    settingsChanged() {
      for (const f of freelancers.values()) {
        send(f.ws, configFor(f));
        evaluate(f, false);
      }
      pushList();
    },
    remove(name) {
      const f = freelancers.get(name);
      if (f && !f.online) freelancers.delete(name);
      pushList();
    },
    close() {
      clearInterval(timer);
      for (const c of wss.clients) c.terminate();
      wss.close();
      try { udp?.close(); } catch {}
    },
  };
}

module.exports = { createHub, WS_PORT, DISCOVERY_PORT };
