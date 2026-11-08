const q = new URLSearchParams(location.search);
const kind = q.get('kind') || 'idle';
const $ = id => document.getElementById(id);

const ICONS = {
  idle: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  offline: '<path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2.3-1.6M12 20h.01"/>',
  back: '<path d="M20 6 9 17l-5-5"/>',
};
const LABELS = { idle: 'Idle alert', offline: 'Offline', back: 'Active again' };
const AUTO_CLOSE_MS = 8000; // idle alerts stay until dismissed

$('card').classList.add(kind);
$('icon').innerHTML = ICONS[kind] || ICONS.idle;
$('kind').textContent = LABELS[kind] || 'Alert';
$('time').textContent = new Date(Number(q.get('at')) || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
$('name').textContent = q.get('name') || 'Detect Idle';
$('text').textContent = q.get('text') || '';

let closing = false;
function close() {
  if (closing) return;
  closing = true;
  stopSound();
  $('card').classList.add('out');
  setTimeout(() => window.api.popupClose(), 280);
}
$('dismiss').onclick = close;
$('close').onclick = close;
$('view').onclick = () => { window.api.popupView(); close(); };
$('mute').onclick = () => { stopSound(); $('mute').classList.add('hidden'); };

if (kind !== 'idle') {
  $('timer').style.animation = `drain ${AUTO_CLOSE_MS}ms linear forwards`;
  setTimeout(close, AUTO_CLOSE_MS);
}

// =====================================================================
// Sounds — generated with Web Audio (no audio files needed)
//   idle:    ~10 s siren (slow wail → fast yelp → slow wail), Mute button stops it
//   offline: ~2.5 s warning beeps
//   back:    short pleasant chime
// =====================================================================
let ctx = null;

function stopSound() {
  $('mute').classList.remove('sounding');
  if (!ctx) return;
  const c = ctx;
  ctx = null;
  try {
    c.master.gain.cancelScheduledValues(c.currentTime);
    c.master.gain.setTargetAtTime(0.0001, c.currentTime, 0.05);
    setTimeout(() => c.close(), 300);
  } catch {}
}

function playSound(kind) {
  try {
    ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    ctx.master = master;
    const t0 = ctx.currentTime + 0.05;
    let end;
    if (kind === 'idle') end = siren(ctx, master, t0);
    else if (kind === 'offline') end = warningBeeps(ctx, master, t0);
    else end = chime(ctx, master, t0);

    if (kind === 'idle') {
      $('mute').classList.remove('hidden');
      $('mute').classList.add('sounding');
    }
    const c = ctx;
    setTimeout(() => {
      if (ctx === c) { ctx = null; c.close(); $('mute').classList.add('hidden'); }
    }, (end - c.currentTime) * 1000 + 300);
  } catch {}
}

// Emergency-style siren: two detuned saw waves through a filter, frequency swept up and down.
function siren(ctx, out, t0) {
  const WAIL = 1.2;   // seconds per slow up/down sweep
  const YELP = 0.28;  // seconds per fast sweep
  const pattern = [
    ...Array(3).fill(WAIL),   // 3.6 s wail
    ...Array(10).fill(YELP),  // 2.8 s yelp
    ...Array(3).fill(WAIL),   // 3.6 s wail
  ];
  const total = pattern.reduce((a, b) => a + b, 0);
  const end = t0 + total;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2600;
  filter.Q.value = 1.2;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(0.16, t0 + 0.15);
  env.gain.setValueAtTime(0.16, end - 0.6);
  env.gain.exponentialRampToValueAtTime(0.0001, end);
  filter.connect(env).connect(out);

  for (const detune of [-8, 8]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.detune.value = detune;
    let t = t0;
    o.frequency.setValueAtTime(650, t);
    for (const d of pattern) {
      o.frequency.linearRampToValueAtTime(1350, t + d / 2);
      o.frequency.linearRampToValueAtTime(650, t + d);
      t += d;
    }
    o.connect(filter);
    o.start(t0);
    o.stop(end + 0.05);
  }
  return end;
}

function tone(ctx, out, { freq, start, dur, type = 'square', vol = 0.12 }) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.02);
  g.gain.setValueAtTime(vol, start + dur - 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(out);
  o.start(start);
  o.stop(start + dur + 0.05);
}

function warningBeeps(ctx, out, t0) {
  let t = t0;
  for (let i = 0; i < 4; i++) {
    tone(ctx, out, { freq: 784, start: t, dur: 0.22 });
    tone(ctx, out, { freq: 523, start: t + 0.28, dur: 0.22 });
    t += 0.62;
  }
  return t;
}

function chime(ctx, out, t0) {
  [523.25, 659.25, 783.99].forEach((f, i) =>
    tone(ctx, out, { freq: f, start: t0 + i * 0.12, dur: 0.5, type: 'sine', vol: 0.15 }));
  return t0 + 0.9;
}

// Start the sound (kept last so everything above is defined first).
playSound(kind);
