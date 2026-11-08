// Generates the app icons (.ico for Windows + .png) from SVG.
// Run with Electron:  npx electron scripts/make-icons.js
// Output: build/icon-client.ico, build/icon-freelancer.ico, src/assets/icon-*.{ico,png}

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SIZES = [256, 128, 64, 48, 32, 24, 16];

const ICONS = {
  // Client: watching eye with a red alert badge
  client: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#9333ea"/>
      </linearGradient>
      <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
      <radialGradient id="iris" cx=".45" cy=".4" r=".7">
        <stop offset="0" stop-color="#818cf8"/><stop offset="1" stop-color="#3730a3"/>
      </radialGradient>
    </defs>
    <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#bg)"/>
    <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#gloss)"/>
    <path d="M30 136 C 66 72, 190 72, 226 136 C 190 200, 66 200, 30 136 Z" fill="#fff"/>
    <circle cx="128" cy="136" r="42" fill="url(#iris)"/>
    <circle cx="128" cy="136" r="18" fill="#1e1b4b"/>
    <circle cx="142" cy="122" r="9" fill="#fff" opacity=".95"/>
    <circle cx="198" cy="62" r="36" fill="#ef4444" stroke="#fff" stroke-width="10"/>
    <rect x="192" y="40" width="12" height="28" rx="6" fill="#fff"/>
    <circle cx="198" cy="81" r="7" fill="#fff"/>
  </svg>`,

  // Freelancer: stopwatch
  freelancer: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#10b981"/><stop offset="1" stop-color="#0f766e"/>
      </linearGradient>
      <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".28"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#bg)"/>
    <rect x="8" y="8" width="240" height="240" rx="58" fill="url(#gloss)"/>
    <rect x="106" y="34" width="44" height="22" rx="8" fill="#fff"/>
    <rect x="120" y="50" width="16" height="20" fill="#fff"/>
    <rect x="184" y="68" width="18" height="30" rx="6" fill="#fff" transform="rotate(45 193 83)"/>
    <circle cx="128" cy="142" r="74" fill="#fff"/>
    <circle cx="128" cy="142" r="58" fill="#ecfdf5"/>
    <path d="M128 142 L128 96" stroke="#0f766e" stroke-width="14" stroke-linecap="round"/>
    <path d="M128 142 L160 162" stroke="#10b981" stroke-width="12" stroke-linecap="round"/>
    <circle cx="128" cy="142" r="11" fill="#0f766e"/>
  </svg>`,
};

// ICO file containing PNG images (supported since Windows Vista).
function buildIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, buf } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map(p => p.buf)]);
}

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const buildDir = path.join(root, 'build');
  const assetDir = path.join(root, 'src', 'assets');
  fs.mkdirSync(buildDir, { recursive: true });
  fs.mkdirSync(assetDir, { recursive: true });

  const win = new BrowserWindow({ show: false });
  await win.loadURL('data:text/html,<canvas id=c></canvas>');

  for (const [name, svg] of Object.entries(ICONS)) {
    const pngs = [];
    for (const size of SIZES) {
      const dataUrl = await win.webContents.executeJavaScript(`new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => {
          const c = document.getElementById('c');
          c.width = c.height = ${size};
          const ctx = c.getContext('2d');
          ctx.clearRect(0, 0, ${size}, ${size});
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, ${size}, ${size});
          res(c.toDataURL('image/png'));
        };
        img.onerror = rej;
        img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
      })`);
      pngs.push({ size, buf: Buffer.from(dataUrl.split(',')[1], 'base64') });
    }
    const ico = buildIco(pngs);
    fs.writeFileSync(path.join(buildDir, `icon-${name}.ico`), ico);
    fs.writeFileSync(path.join(assetDir, `icon-${name}.ico`), ico);
    fs.writeFileSync(path.join(assetDir, `icon-${name}.png`), pngs[0].buf);
    console.log(`icon-${name}: ${SIZES.join(', ')} px`);
  }
  app.quit();
});
