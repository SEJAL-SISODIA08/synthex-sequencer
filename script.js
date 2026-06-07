/* ═══════════════════════════════════════════════════════
   SYNTHEX SX-16 — COMPLETE AUDIO ENGINE & SEQUENCER
   ═══════════════════════════════════════════════════════ */

'use strict';

// ── ROW CONFIGURATION ────────────────────────────────────
// Each row has a label, a fundamental frequency, and a CSS
// variable name that matches style.css for the glow colour.
const ROW_CONFIG = [
  { label: 'KICK',   freq: 80,   colorVar: '--color-kick'  },
  { label: 'SNARE',  freq: 220,  colorVar: '--color-snare' },
  { label: 'HI-HAT', freq: 880,  colorVar: '--color-hat'   },
  { label: 'LEAD',   freq: 440,  colorVar: '--color-lead'  },
];

const ROWS  = ROW_CONFIG.length;  // 4
const STEPS = 16;

// ── SEQUENCER STATE ──────────────────────────────────────
const grid = Array.from({ length: ROWS }, () => Array(STEPS).fill(false));

let isPlaying    = false;
let currentStep  = 0;
let nextStepTime = 0;       // Web Audio clock time for the next scheduled step
let schedulerTimer = null;  // setInterval handle for the look-ahead scheduler

// ── WEB AUDIO NODES ──────────────────────────────────────
let audioCtx   = null;
let analyser   = null;
let masterGain = null;

// ── VISUALIZER ────────────────────────────────────────────
let animFrameId = null;

// ── DOM REFERENCES ────────────────────────────────────────
const playStopBtn  = document.getElementById('playStopBtn');
const btnIcon      = document.getElementById('btnIcon');
const btnText      = document.getElementById('btnText');
const statusDot    = document.getElementById('statusDot');
const statusLabel  = document.getElementById('statusLabel');
const stepCounterEl= document.getElementById('stepCounter');
const volumeSlider = document.getElementById('volumeSlider');
const tempoSlider  = document.getElementById('tempoSlider');
const volumeVal    = document.getElementById('volumeVal');
const tempoVal     = document.getElementById('tempoVal');
const waveformSel  = document.getElementById('waveformSelect');
const canvas       = document.getElementById('visualizerCanvas');
const ctx2d        = canvas.getContext('2d');
const gridBody     = document.getElementById('gridBody');
const beatNumbers  = document.getElementById('beatNumbers');

// ════════════════════════════════════════════════════════
// 1. BUILD THE UI (beat numbers + step grid)
// ════════════════════════════════════════════════════════

// Beat number labels across the top
for (let s = 0; s < STEPS; s++) {
  const span = document.createElement('span');
  span.className   = 'beat-num';
  span.textContent = s + 1;
  beatNumbers.appendChild(span);
}

// stepBtns[row][step] holds every button element for fast lookup
const stepBtns = [];

ROW_CONFIG.forEach((rowCfg, row) => {
  const rowEl = document.createElement('div');
  rowEl.className      = 'grid-row';
  rowEl.dataset.row    = row;

  // Row label (left column)
  const labelEl = document.createElement('div');
  labelEl.className = 'row-label';
  labelEl.innerHTML = `
    <span class="row-name">${rowCfg.label}</span>
    <span class="row-freq">${rowCfg.freq}Hz</span>
  `;
  rowEl.appendChild(labelEl);

  // 16 step buttons
  const stepsWrap = document.createElement('div');
  stepsWrap.className = 'row-steps';

  stepBtns[row] = [];

  for (let s = 0; s < STEPS; s++) {
    const btn = document.createElement('button');
    btn.className = 'step-btn';
    if (s > 0 && s % 4 === 0) btn.classList.add('group-start');
    btn.dataset.row  = row;
    btn.dataset.step = s;
    btn.setAttribute('aria-label', `${rowCfg.label} step ${s + 1}`);
    btn.setAttribute('aria-pressed', 'false');

    btn.addEventListener('click', () => toggleStep(row, s));

    stepsWrap.appendChild(btn);
    stepBtns[row][s] = btn;
  }

  rowEl.appendChild(stepsWrap);
  gridBody.appendChild(rowEl);
});

// ════════════════════════════════════════════════════════
// 2. STEP TOGGLE — turn a cell on or off
// ════════════════════════════════════════════════════════

function toggleStep(row, step) {
  grid[row][step] = !grid[row][step];
  const btn = stepBtns[row][step];
  btn.classList.toggle('active', grid[row][step]);
  btn.setAttribute('aria-pressed', String(grid[row][step]));
}

// ════════════════════════════════════════════════════════
// 3. WEB AUDIO INITIALISATION
//    Deferred until the first Play press (browser policy
//    requires a user gesture before AudioContext creation).
// ════════════════════════════════════════════════════════

function initAudio() {
  if (audioCtx) return; // already initialised

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Analyser — feeds the oscilloscope visualizer
  analyser          = audioCtx.createAnalyser();
  analyser.fftSize  = 2048;

  // Master gain — controlled by the Volume slider
  masterGain              = audioCtx.createGain();
  masterGain.gain.value   = volumeSlider.value / 100;

  // Signal chain:  individual notes → masterGain → analyser → speakers
  masterGain.connect(analyser);
  analyser.connect(audioCtx.destination);
}

// ════════════════════════════════════════════════════════
// 4. PLAY A SINGLE NOTE
//    Every oscillator and gain node is fully self-contained.
//    They are scheduled to stop, then automatically
//    disconnected via the 'ended' event — zero memory leaks.
// ════════════════════════════════════════════════════════

function playNote(freq, startTime) {
  const osc      = audioCtx.createOscillator();
  const noteGain = audioCtx.createGain();

  // Read waveform live so dropdown changes take effect instantly
  osc.type = waveformSel.value;
  osc.frequency.setValueAtTime(freq, startTime);

  // Short percussive envelope: attack at full level → decay to silence
  const attackTime = startTime;
  const releaseTime = startTime + 0.15;
  const stopTime    = startTime + 0.22;

  noteGain.gain.setValueAtTime(0.001, attackTime);          // avoid click
  noteGain.gain.exponentialRampToValueAtTime(0.40, attackTime + 0.008); // fast attack
  noteGain.gain.exponentialRampToValueAtTime(0.001, releaseTime);       // decay

  // Wire up: osc → noteGain → masterGain
  osc.connect(noteGain);
  noteGain.connect(masterGain);

  osc.start(startTime);
  osc.stop(stopTime);

  // ── MEMORY CLEANUP ────────────────────────────────────
  // The 'ended' event fires after osc.stop() completes.
  // Disconnecting both nodes removes all internal references
  // so the garbage collector can immediately reclaim memory.
  osc.addEventListener('ended', () => {
    osc.disconnect();
    noteGain.disconnect();
  }, { once: true });
}

// ════════════════════════════════════════════════════════
// 5. LOOK-AHEAD SCHEDULER
//    This pattern (pioneered by Chris Wilson) is far more
//    accurate than setTimeout alone.  A small interval
//    (every 25 ms) calls scheduleAhead(), which pushes
//    upcoming steps into the Web Audio timeline up to
//    LOOKAHEAD_SEC seconds in advance.  The audio clock
//    never drifts; only the visual highlight lags slightly.
// ════════════════════════════════════════════════════════

const SCHEDULER_INTERVAL_MS = 25;   // how often JS checks for new steps to queue
const LOOKAHEAD_SEC          = 0.10; // how far ahead to schedule audio (seconds)

// Queue of { step, time } pairs waiting to be drawn
const drawQueue = [];

function getSecPerStep() {
  // 16th-note duration at current BPM
  return (60 / parseInt(tempoSlider.value, 10)) / 4;
}

function scheduleAhead() {
  // Keep scheduling steps that fall within the lookahead window
  while (nextStepTime < audioCtx.currentTime + LOOKAHEAD_SEC) {
    scheduleStep(currentStep, nextStepTime);
    drawQueue.push({ step: currentStep, time: nextStepTime });

    nextStepTime += getSecPerStep();
    currentStep   = (currentStep + 1) % STEPS;
  }
}

function scheduleStep(step, time) {
  ROW_CONFIG.forEach((rowCfg, row) => {
    if (grid[row][step]) {
      playNote(rowCfg.freq, time);
    }
  });
}

// ── VISUAL DRAW LOOP ──────────────────────────────────────
// Runs on every animation frame while playing.
// It flushes drawQueue entries whose scheduled time has arrived,
// moving the playhead highlight to the correct column.

let lastHighlightedStep = -1;

function visualLoop() {
  if (!isPlaying) return;
  animFrameId = requestAnimationFrame(visualLoop);

  // Flush any steps whose audio time has now been reached
  const now = audioCtx.currentTime;
  while (drawQueue.length > 0 && drawQueue[0].time <= now) {
    const { step } = drawQueue.shift();
    movePlayhead(step);
  }

  drawOscilloscope();
}

function movePlayhead(step) {
  // Remove highlight from the previous column
  if (lastHighlightedStep !== -1) {
    for (let r = 0; r < ROWS; r++) {
      stepBtns[r][lastHighlightedStep].classList.remove('playing');
    }
  }
  // Highlight the new column
  for (let r = 0; r < ROWS; r++) {
    stepBtns[r][step].classList.add('playing');
  }
  lastHighlightedStep = step;
  stepCounterEl.textContent = String(step + 1).padStart(2, '0');
}

// ════════════════════════════════════════════════════════
// 6. PLAY / STOP
// ════════════════════════════════════════════════════════

playStopBtn.addEventListener('click', () => {
  isPlaying ? stopSequencer() : startSequencer();
});

function startSequencer() {
  initAudio();

  // Un-suspend context if the browser auto-suspended it
  if (audioCtx.state === 'suspended') audioCtx.resume();

  isPlaying    = true;
  currentStep  = 0;
  nextStepTime = audioCtx.currentTime;
  drawQueue.length = 0;
  lastHighlightedStep = -1;

  // Start the JS look-ahead scheduler
  schedulerTimer = setInterval(scheduleAhead, SCHEDULER_INTERVAL_MS);

  // Start visual + oscilloscope loop
  visualLoop();

  // Update UI chrome
  playStopBtn.classList.add('playing');
  btnIcon.textContent      = '■';
  btnText.textContent      = 'STOP';
  statusDot.classList.add('active');
  statusLabel.textContent  = 'PLAYING';
}

function stopSequencer() {
  isPlaying = false;

  clearInterval(schedulerTimer);
  schedulerTimer = null;

  cancelAnimationFrame(animFrameId);
  animFrameId = null;

  drawQueue.length = 0;

  // Remove all playhead highlights
  for (let r = 0; r < ROWS; r++) {
    for (let s = 0; s < STEPS; s++) {
      stepBtns[r][s].classList.remove('playing');
    }
  }
  lastHighlightedStep = -1;
  stepCounterEl.textContent = '--';

  // Update UI chrome
  playStopBtn.classList.remove('playing');
  btnIcon.textContent      = '▶';
  btnText.textContent      = 'PLAY';
  statusDot.classList.remove('active');
  statusLabel.textContent  = 'STOPPED';

  clearCanvas();
}

// ════════════════════════════════════════════════════════
// 7. CONTROLS — Volume & Tempo sliders
// ════════════════════════════════════════════════════════

volumeSlider.addEventListener('input', () => {
  volumeVal.textContent = volumeSlider.value;
  if (masterGain) {
    // Smooth ramp to avoid audible clicks when dragging
    masterGain.gain.setTargetAtTime(
      volumeSlider.value / 100,
      audioCtx.currentTime,
      0.015
    );
  }
});

tempoSlider.addEventListener('input', () => {
  tempoVal.innerHTML = tempoSlider.value + ' <small>BPM</small>';
  // The scheduler reads BPM live via getSecPerStep(), so no
  // extra work is needed — the change takes effect immediately.
});

// ════════════════════════════════════════════════════════
// 8. OSCILLOSCOPE VISUALIZER
// ════════════════════════════════════════════════════════

function resizeCanvas() {
  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;
}

window.addEventListener('resize', () => {
  resizeCanvas();
  if (!isPlaying) clearCanvas();
});

resizeCanvas();

function clearCanvas() {
  ctx2d.clearRect(0, 0, canvas.width, canvas.height);
  // Draw a dim idle flat-line so the canvas isn't just black
  ctx2d.beginPath();
  ctx2d.strokeStyle = 'rgba(0, 255, 136, 0.15)';
  ctx2d.lineWidth   = 1.5;
  ctx2d.moveTo(0, canvas.height / 2);
  ctx2d.lineTo(canvas.width, canvas.height / 2);
  ctx2d.stroke();
}

clearCanvas();

function drawOscilloscope() {
  if (!analyser) return;

  const bufLen    = analyser.fftSize;
  const dataArray = new Float32Array(bufLen);
  analyser.getFloatTimeDomainData(dataArray);

  ctx2d.clearRect(0, 0, canvas.width, canvas.height);

  // Subtle horizontal grid lines
  ctx2d.lineWidth   = 1;
  ctx2d.strokeStyle = 'rgba(0, 255, 136, 0.05)';
  for (let i = 1; i < 4; i++) {
    const y = (canvas.height / 4) * i;
    ctx2d.beginPath();
    ctx2d.moveTo(0, y);
    ctx2d.lineTo(canvas.width, y);
    ctx2d.stroke();
  }

  // Waveform gradient (left → right)
  const grad = ctx2d.createLinearGradient(0, 0, canvas.width, 0);
  grad.addColorStop(0,   '#00ff88');
  grad.addColorStop(0.5, '#00e5ff');
  grad.addColorStop(1,   '#00ff88');

  ctx2d.beginPath();
  ctx2d.lineWidth   = 2;
  ctx2d.strokeStyle = grad;
  ctx2d.shadowBlur  = 14;
  ctx2d.shadowColor = '#00ff88';

  const sliceW = canvas.width / bufLen;
  let x = 0;

  for (let i = 0; i < bufLen; i++) {
    const y = (canvas.height / 2) + dataArray[i] * (canvas.height * 0.42);
    i === 0 ? ctx2d.moveTo(x, y) : ctx2d.lineTo(x, y);
    x += sliceW;
  }

  ctx2d.stroke();
  ctx2d.shadowBlur = 0; // reset shadow so it doesn't bleed into other draws
}
