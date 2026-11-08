// Fully automatic updates from GitHub Releases (https://github.com/swan1213/detect-idle).
//
// Installed copy (Setup.exe): electron-updater downloads the new installer in the background,
//   then installs it silently and restarts the app.
// Portable copy: downloads the new portable .exe, checks its SHA-512, then a tiny helper script
//   swaps the file after the app quits and starts the new version.
//
// The Client and Freelancer apps each follow their own channel ("client" / "freelancer"),
// so each one only ever installs its own app.
//
// Testing: --update-url=http://host/folder/ uses another update source (a local test server).

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'swan1213/detect-idle';
const FIRST_CHECK_MS = 30 * 1000;            // shortly after start
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;   // then every 4 hours
const RESTART_DELAY_MS = 5 * 1000;           // show "restarting to update" for a moment

const argValue = name => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=').slice(1).join('=');

// Newer if any part of x.y.z is higher.
function isNewer(remote, local) {
  const a = String(remote).split('.').map(Number);
  const b = String(local).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) > (b[i] || 0)) return true;
    if ((a[i] || 0) < (b[i] || 0)) return false;
  }
  return false;
}

// GET with redirects (GitHub release downloads redirect to a CDN).
function request(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'detect-idle-updater' } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(request(new URL(res.headers.location, url).toString(), redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve(res);
    });
    req.setTimeout(60 * 1000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function getText(url) {
  const res = await request(url);
  let body = '';
  for await (const chunk of res) body += chunk;
  return body;
}

// Downloads to `file` and returns the SHA-512 (base64) of what was written.
async function download(url, file) {
  const res = await request(url);
  const hash = crypto.createHash('sha512');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    res.on('data', d => hash.update(d));
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  return hash.digest('base64');
}

function startAutoUpdate({ role, onStatus = () => {}, beforeRestart = () => {}, log = console.log }) {
  const testUrl = argValue('update-url');
  if (!app.isPackaged && !testUrl) return; // nothing to update while developing
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE; // set by the portable launcher
  let busy = false;

  const restart = fn => {
    onStatus({ status: 'restarting', version: restart.version });
    setTimeout(() => { beforeRestart(); fn(); }, RESTART_DELAY_MS);
  };

  // ----- installed copy -----
  let autoUpdater = null;
  if (!portableExe) {
    ({ autoUpdater } = require('electron-updater'));
    autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
    if (testUrl) autoUpdater.setFeedURL({ provider: 'generic', url: testUrl, channel: role });
    autoUpdater.channel = role;          // client.yml / freelancer.yml
    autoUpdater.allowDowngrade = false;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-available', info => onStatus({ status: 'downloading', version: info.version }));
    autoUpdater.on('update-downloaded', info => {
      restart.version = info.version;
      if (process.argv.includes('--update-no-install')) return onStatus({ status: 'ready', version: info.version }); // tests
      restart(() => autoUpdater.quitAndInstall(true, true)); // silent install, then start the app again
    });
    autoUpdater.on('error', err => { busy = false; log(`update error: ${err.message}`); });
  }

  // ----- portable copy -----
  async function checkPortable() {
    const base = testUrl || `https://github.com/${REPO}/releases/latest/download/`;
    const manifest = JSON.parse(await getText(`${base}portable-${role}.json`));
    if (!isNewer(manifest.version, app.getVersion())) return;

    onStatus({ status: 'downloading', version: manifest.version });
    const tmp = path.join(os.tmpdir(), `detect-idle-${role}-${manifest.version}.exe`);
    const sha512 = await download(base + manifest.file, tmp);
    if (sha512 !== manifest.sha512) {
      fs.rmSync(tmp, { force: true });
      throw new Error('downloaded file failed the SHA-512 check; update skipped');
    }

    // Helper: wait until this app has fully quit (the .exe is unlocked), swap it, start the new one.
    const args = process.argv.slice(1).filter(a => !a.startsWith('--update-url=')).map(a => `"${a.replace(/"/g, '')}"`).join(' ');
    const helper = path.join(os.tmpdir(), `detect-idle-update-${role}.cmd`);
    fs.writeFileSync(helper, [
      '@echo off',
      'set tries=0',
      ':retry',
      'ping -n 3 127.0.0.1 >nul',
      `move /y "${tmp}" "${portableExe}" >nul 2>&1`,
      'if not errorlevel 1 goto ok',
      'set /a tries+=1',
      'if %tries% lss 30 goto retry',
      'goto end',
      ':ok',
      `start "" "${portableExe}" ${args}${testUrl ? ` "--update-url=${testUrl}"` : ''}`,
      ':end',
      'del "%~f0"',
    ].join('\r\n'));

    restart.version = manifest.version;
    restart(() => {
      spawn('cmd.exe', ['/c', helper], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      app.quit();
    });
  }

  async function check() {
    if (busy) return;
    busy = true;
    try {
      if (portableExe) await checkPortable();
      else await autoUpdater.checkForUpdates();
    } catch (err) {
      log(`update check failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  const firstDelay = Number(argValue('update-check-delay')) * 1000 || FIRST_CHECK_MS;
  setTimeout(check, firstDelay);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { startAutoUpdate };
