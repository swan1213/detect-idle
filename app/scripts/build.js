// Builds the Client and Freelancer apps (installer + portable) with auto-update settings.
//
//   node scripts/build.js            -> build everything into dist/
//   node scripts/build.js --release  -> build, then publish a GitHub Release (needs `gh auth login`)
//   node scripts/build.js --only=client:nsis   -> build just one (for testing)
//
// Output in dist/release/ (exactly what gets uploaded to the GitHub Release):
//   Detect-Idle-Client-Setup-<ver>.exe (+ .blockmap), client.yml           <- installed Client updates
//   Detect-Idle-Freelancer-Setup-<ver>.exe (+ .blockmap), freelancer.yml   <- installed Freelancer updates
//   Detect-Idle-Client-Portable.exe, portable-client.json                  <- portable Client updates
//   Detect-Idle-Freelancer-Portable.exe, portable-freelancer.json          <- portable Freelancer updates

const builder = require('electron-builder');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const VERSION = pkg.version;
const REPO = { owner: 'swan1213', repo: 'detect-idle' };
const APPS = {
  client: { productName: 'Detect Idle Client', file: 'Detect-Idle-Client' },
  freelancer: { productName: 'Detect Idle Freelancer', file: 'Detect-Idle-Freelancer' },
};
const OUT = path.join(ROOT, 'dist');
const RELEASE_DIR = path.join(OUT, 'release');

function config(role, target) {
  const a = APPS[role];
  return {
    ...pkg.build,
    appId: `com.detectidle.${role}`,
    productName: a.productName,
    // own internal name per app -> separate update download folders (detect-idle-client-updater, ...)
    extraMetadata: { detectIdleRole: role, name: `detect-idle-${role}` },
    directories: { output: path.join(OUT, `${target}-${role}`) },
    win: { target, icon: `src/assets/icon-${role}.ico` },
    nsis: { ...pkg.build.nsis, artifactName: `${a.file}-Setup-\${version}.\${ext}` },
    portable: { artifactName: `${a.file}-Portable.\${ext}` }, // fixed name -> stable download URL
    // Each app has its own update channel: client.yml / freelancer.yml in the same GitHub Release.
    publish: [{ provider: 'github', owner: REPO.owner, repo: REPO.repo, channel: role }],
  };
}

const sha512 = file => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  const files = [];

  // --only=freelancer:portable (testing) builds just one of the four.
  const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7);
  for (const role of Object.keys(APPS)) {
    for (const target of ['nsis', 'portable']) {
      if (only && only !== `${role}:${target}`) continue;
      console.log(`\n=== ${APPS[role].productName} (${target}) v${VERSION} ===`);
      await builder.build({
        targets: builder.Platform.WINDOWS.createTarget(target, builder.Arch.x64),
        publish: 'never',
        config: config(role, target),
      });
      const dir = path.join(OUT, `${target}-${role}`);
      const copy = name => {
        fs.copyFileSync(path.join(dir, name), path.join(RELEASE_DIR, name));
        files.push(name);
      };
      if (target === 'nsis') {
        const exe = `${APPS[role].file}-Setup-${VERSION}.exe`;
        copy(exe);
        copy(`${exe}.blockmap`);
        copy(`${role}.yml`); // update info for installed copies
      } else {
        const exe = `${APPS[role].file}-Portable.exe`;
        copy(exe);
        const manifest = `portable-${role}.json`; // update info for portable copies
        fs.writeFileSync(path.join(RELEASE_DIR, manifest), JSON.stringify({
          version: VERSION, file: exe, sha512: sha512(path.join(dir, exe)),
        }, null, 2));
        files.push(manifest);
      }
    }
  }
  console.log(`\nRelease files in ${RELEASE_DIR}:\n  ${files.join('\n  ')}`);

  if (process.argv.includes('--release')) {
    const tag = `v${VERSION}`;
    const gh = process.platform === 'win32' && fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe')
      ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';
    console.log(`\nPublishing GitHub Release ${tag} ...`);
    execFileSync(gh, [
      'release', 'create', tag,
      '--repo', `${REPO.owner}/${REPO.repo}`,
      '--title', `Detect Idle ${tag}`,
      '--notes', `Detect Idle ${tag}. Installed and portable apps update automatically.`,
      ...files.map(f => path.join(RELEASE_DIR, f)),
    ], { stdio: 'inherit' });
    console.log(`Published: https://github.com/${REPO.owner}/${REPO.repo}/releases/tag/${tag}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
