// Runs inside the FREELANCER app.
// Broadcasts the project code on the local network. Every Client app in that project answers,
// so one search finds ALL clients of the project.

const dgram = require('dgram');
const os = require('os');
const { DISCOVERY_PORT } = require('./hub');

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((b, i) => (b | (~mask[i] & 255))).join('.'));
    }
  }
  return [...out];
}

// Resolves to [{ id, host: "ip:port" }], one per Client app (de-duplicated by hub id).
function findClients(teamCode, timeoutMs = 2500) {
  return new Promise(resolve => {
    const found = new Map(); // hub id -> host:port (first answer wins)
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch {}
      resolve([...found].map(([id, host]) => ({ id, host })));
    };
    setTimeout(finish, timeoutMs);

    sock.on('message', (buf, rinfo) => {
      try {
        const msg = JSON.parse(buf.toString());
        if (msg.t === 'detect-idle-here') {
          const key = msg.id || `${rinfo.address}:${msg.port}`;
          if (!found.has(key)) found.set(key, `${rinfo.address}:${msg.port}`);
        }
      } catch {}
    });
    sock.on('error', finish);
    sock.bind(() => {
      sock.setBroadcast(true);
      const payload = Buffer.from(JSON.stringify({ t: 'detect-idle-discover', code: teamCode }));
      for (const addr of broadcastAddresses()) sock.send(payload, DISCOVERY_PORT, addr, () => {});
    });
  });
}

module.exports = { findClients };
