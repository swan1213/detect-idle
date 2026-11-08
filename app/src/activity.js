// Runs inside the FREELANCER app.
// Classifies global keyboard/mouse events as REAL activity or AUTOMATIC-looking input,
// so someone asleep with a key pressed down (or a hand twitching on the mouse) still counts as idle.
//
// Privacy: key codes are only compared with each other in memory (to spot a key that is held
// down). Nothing about which keys were pressed is stored or sent anywhere.

const HELD_KEY_MS = 10 * 1000; // a key held this long is "stuck" (normal typing never holds a key 10 s)
const REPEAT_GAP_MS = 1000;    // Windows auto-repeats a held key every ~33 ms; a gap >1 s means it was released
const MOUSE_RADIUS = 30;       // px: moving within this radius of the last real position is just jitter
const FAKE_RECENT_MS = 15 * 1000;

class ActivityTracker {
  constructor(now = Date.now) {
    this.now = now;
    this.lastReal = now();
    this.lastFake = 0;
    this.fakeReason = null;
    this.keys = new Map(); // keycode -> { since, lastSeen }
    this.anchor = null;    // last mouse position that counted as real movement
  }

  // ----- events -----
  keyDown(code) {
    const t = this.now();
    const k = this.keys.get(code);
    if (k && t - k.lastSeen < REPEAT_GAP_MS) {
      // Same key again without a key-up: Windows auto-repeat -> the key is being held down.
      k.lastSeen = t;
      return this.fake(t, 'held-key');
    }
    this.keys.set(code, { since: t, lastSeen: t });
    // A new press while another key is stuck (e.g. head on the keyboard) is not trusted either.
    if (this.stuckKey(t)) return this.fake(t, 'held-key');
    this.real(t);
  }

  keyUp(code) {
    this.keys.delete(code);
  }

  mouseMove(x, y) {
    const t = this.now();
    if (!this.anchor) { this.anchor = { x, y }; return; }
    if (Math.hypot(x - this.anchor.x, y - this.anchor.y) > MOUSE_RADIUS) {
      this.anchor = { x, y };
      this.real(t);
    } else {
      this.fake(t, 'mouse-jitter');
    }
  }

  click() { this.real(this.now()); }
  wheel() { this.real(this.now()); }

  // ----- helpers -----
  stuckKey(t) {
    for (const k of this.keys.values()) {
      if (t - k.since >= HELD_KEY_MS && t - k.lastSeen < REPEAT_GAP_MS) return true;
    }
    return false;
  }

  real(t) { this.lastReal = t; }

  fake(t, reason) {
    this.lastFake = t;
    this.fakeReason = reason;
  }

  // ----- queries -----
  // Seconds since the last REAL activity.
  idleSeconds() {
    return Math.max(0, (this.now() - this.lastReal) / 1000);
  }

  // Seconds that input has looked automatic with no real activity (0 if not the case).
  suspiciousSeconds() {
    const t = this.now();
    if (!this.lastFake || this.lastFake <= this.lastReal || t - this.lastFake > FAKE_RECENT_MS) return 0;
    return (t - this.lastReal) / 1000;
  }

  // Treat the person as present right now (e.g. they clicked "I'm here").
  confirmPresence() { this.real(this.now()); }
}

module.exports = { ActivityTracker };
