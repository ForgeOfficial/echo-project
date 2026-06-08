let _ctx = null;

function getCtx() {
  if (!_ctx) _ctx = new (window.AudioContext || window.webkitAudioContext)();
  return _ctx;
}

function tone(freq, duration, type = 'sine', gain = 0.3) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const vol = ctx.createGain();
  osc.connect(vol);
  vol.connect(ctx.destination);
  osc.frequency.value = freq;
  osc.type = type;
  vol.gain.setValueAtTime(gain, ctx.currentTime);
  vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
  osc.start();
  osc.stop(ctx.currentTime + duration);
}

export const audio = {
  ping() {
    const ctx = getCtx();
    const osc = ctx.createOscillator();
    const vol = ctx.createGain();
    osc.connect(vol); vol.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(220, ctx.currentTime + 0.4);
    vol.gain.setValueAtTime(0.2, ctx.currentTime);
    vol.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.start(); osc.stop(ctx.currentTime + 0.4);
  },
  // Tir : "pew" arcade net et rond (triangle + sinus, sans agressivité)
  shoot() {
    const ctx = getCtx();
    const t = ctx.currentTime;

    // glide principal triangle (clair mais doux)
    const o1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    o1.type = 'triangle';
    o1.frequency.setValueAtTime(740, t);
    o1.frequency.exponentialRampToValueAtTime(165, t + 0.13);
    g1.gain.setValueAtTime(0.0001, t);
    g1.gain.exponentialRampToValueAtTime(0.28, t + 0.01);
    g1.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
    o1.connect(g1); g1.connect(ctx.destination);
    o1.start(t); o1.stop(t + 0.16);

    // corps sinus une octave en dessous pour la rondeur
    const o2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    o2.type = 'sine';
    o2.frequency.setValueAtTime(370, t);
    o2.frequency.exponentialRampToValueAtTime(110, t + 0.13);
    g2.gain.setValueAtTime(0.0001, t);
    g2.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    g2.gain.exponentialRampToValueAtTime(0.0008, t + 0.16);
    o2.connect(g2); g2.connect(ctx.destination);
    o2.start(t); o2.stop(t + 0.16);
  },
  hit()   { tone(220, 0.2, 'sawtooth', 0.25); },

  // Tu prends un coup : impact lourd (bruit + chute de basse + alarme)
  damage() {
    const ctx = getCtx();
    const t = ctx.currentTime;

    // burst de bruit (impact)
    const len = Math.floor(ctx.sampleRate * 0.18);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const nGain = ctx.createGain();
    nGain.gain.setValueAtTime(0.5, t);
    nGain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    noise.connect(nGain); nGain.connect(ctx.destination);
    noise.start(t);

    // chute de basse
    const osc = ctx.createOscillator();
    const oGain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.3);
    oGain.gain.setValueAtTime(0.4, t);
    oGain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    osc.connect(oGain); oGain.connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.35);

    // bip d'alarme
    setTimeout(() => tone(160, 0.12, 'square', 0.18), 60);
  },

  // Tu touches l'adversaire : petit "tick" de confirmation
  hitConfirm() { tone(1200, 0.06, 'square', 0.12); },

  // Victoire : arpège majeur triomphant + accord final qui scintille
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => setTimeout(() => tone(f, 0.5, 'triangle', 0.22), i * 110));
    setTimeout(() => [1046.5, 1318.5, 1568].forEach(f => tone(f, 0.9, 'triangle', 0.13)), 470);
  },
  lose()  { [523, 415, 330, 220].forEach((f, i) => setTimeout(() => tone(f, 0.4, 'sawtooth', 0.2), i * 130)); },
};
