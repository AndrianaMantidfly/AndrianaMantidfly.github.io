/* GLEB RUN — classic script (global THREE), no ES modules */
(function () {
  'use strict';

  function showErr(msg) {
    var el = document.getElementById('loadErr');
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
    console.error(msg);
  }

  if (typeof THREE === 'undefined') {
    showErr('Three.js не загрузился. Нужен интернет или CDN.');
    return;
  }

  var LANES = [-2.2, 0, 2.2];
  // Jump height design (feet Y):
  //   normal peak ≈ 1.75 — low/box/roof OK
  //   JUMP power ≈ 3.4  — high coin arcs and tall route pieces YES
  //   JET hover 1.3..3.1 — air highways YES
  var GRAVITY = -36;
  var JUMP_V = 12.8; // stronger Subway-style jump arc
  var JUMP_PWR_MULT = 1.65;
  var JET_JUMP_MULT = 1.12;
  var SLIDE_T = 0.32; // SS-tight roll
  var LANE_LERP = 11.5; // snappier lane glide (closer to SS, still not teleport)
  var H_LOW = 0.7;
  var H_BOX = 1.25;
  var H_BAR = 1.75;       // slide under
  var H_ROOF = 1.65;      // roof surface
  var RAMP_LEN = 2.6; // SS-style long front ramp you run up     // length of the sloped front on a trainRoof car — run onto it, no jump needed
  var H_COIN_GROUND = 0.95;
  var H_COIN_ARC = 1.7;   // normal jump reaches
  var H_COIN_ARC_HI = 2.55; // needs jump power
  var H_COIN_JET = 2.85;


  var canvas = document.getElementById('c');
  var el = {
    title: document.getElementById('title'),
    over: document.getElementById('over'),
    pause: document.getElementById('pause'),
    btnResume: document.getElementById('btnResume'),
    btnExit: document.getElementById('btnExit'),
    btnExitOver: document.getElementById('btnExitOver'),
    btnStart130: document.getElementById('btnStart130'),
    btnStart150: document.getElementById('btnStart150'),
    btnSecret: document.getElementById('btnSecret'),
    hud: document.getElementById('hud'),
    score: document.getElementById('score'),
    combo: document.getElementById('combo'),
    dist: document.getElementById('dist'),
    levelNum: document.getElementById('levelNum'),
    levelProg: document.getElementById('levelProg'),
    levelBanner: document.getElementById('levelBanner'),
    levelBannerText: document.getElementById('levelBannerText'),
    levelBannerSub: document.getElementById('levelBannerSub'),
    overStats: document.getElementById('overStats'),
    warn: document.getElementById('warn'),
    beatFx: document.getElementById('beatFx'),
    touch: document.getElementById('touch'),
    btnStart: document.getElementById('btnStart'),
    btnRetry: document.getElementById('btnRetry'),
    powers: document.getElementById('powers'),
    meterWrap: document.getElementById('meterWrap'),
    coinMeter: document.getElementById('coinMeter'),
    btnMonkey: document.getElementById('btnMonkey'),
    btnPause: document.getElementById('btnPause')
  };

  var renderer, scene, camera;
  var gleb, buddy, trackGroup, propGroup, sceneryGroup;
  var sceneryPieces = [];
  var scenerySeed = 0;
  // Track dressing (ties, edge markers, wall pipes) that must scroll with the world.
  var trackScroll = [];
  // Camera shake impulse (bumps / board break). Lives at closure scope so
  // changeLane()/sideBumpFrom() can actually reach it — it used to be a local
  // `var` inside update(), so every `typeof shake !== 'undefined'` check failed.
  var shake = 0;

  // Free GPU resources of a removed subtree. Without this every restart
  // rebuilt ~hundreds of meshes/canvas textures and leaked them.
  function disposeTree(root) {
    if (!root) return;
    root.traverse(function (n) {
      if (n.geometry && n.geometry.dispose && !(n.geometry.userData && n.geometry.userData.shared)) n.geometry.dispose();
      var m = n.material;
      if (m) {
        var list = Array.isArray(m) ? m : [m];
        for (var i = 0; i < list.length; i++) {
          if (list[i].userData && list[i].userData.shared) continue;
          if (list[i].map && list[i].map.dispose) list[i].map.dispose();
          if (list[i].dispose) list[i].dispose();
        }
      }
    });
  }
  var groundTex, laneLines = [];
  var dustPoints, dustCount = 64;
  var rainPoints, rainCount = 150;
  var fovCur = 65;

  // ===== PERFORMANCE: quality tier + adaptive resolution =====================
  // tier: 'low' (weak phones/laptops) | 'mid' (typical phones) | 'high' (desktop).
  // Override with ?quality=low|mid|high. The tier is also learned: if a device
  // can't hold the frame rate even at minimum resolution, 'low' is remembered.
  var LS_QUALITY = 'gleb_run_quality_v1';
  var PERF = (function () {
    var tier = null;
    try {
      var m = /[?&]quality=(low|mid|high)\b/.exec(location.search);
      if (m) tier = m[1];
    } catch (e0) {}
    if (!tier) {
      try { if (localStorage.getItem(LS_QUALITY) === 'low') tier = 'low'; } catch (e1) {}
    }
    if (!tier) {
      var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
      var cores = navigator.hardwareConcurrency || 8;
      var mem = navigator.deviceMemory || 8;
      var weak = cores <= 2 || mem <= 2 || (touch && (cores <= 4 || mem <= 3));
      tier = weak ? 'low' : (touch ? 'mid' : 'high');
    }
    var caps = {
      low:  { max: 1.0,  min: 0.6,  aa: false, shadows: false, shadowSize: 512 },
      mid:  { max: 1.25, min: 0.65, aa: true,  shadows: true,  shadowSize: 512 },
      high: { max: 1.5,  min: 0.75, aa: true,  shadows: true,  shadowSize: 768 }
    }[tier];
    return {
      tier: tier, low: tier === 'low', max: caps.max, min: caps.min, aa: caps.aa,
      shadows: caps.shadows, shadowSize: caps.shadowSize,
      ratio: 1, ema: 16.7, slowMs: 0, fastMs: 0, coolMs: 3000, raiseBlockMs: 0,
      floorMs: 0, floorSaved: false
    };
  })();
  PERF.ratio = Math.min(window.devicePixelRatio || 1, PERF.max);

  // Low tier: swap the PBR material for Lambert (per-vertex lighting) — much
  // cheaper on weak GPUs. Must run before any mesh is built.
  function useLambertMaterials() {
    var Std = THREE.MeshStandardMaterial;
    if (!Std || Std.__lambertSwap) return;
    var Lam = THREE.MeshLambertMaterial;
    var swapped = function (params) {
      var p = {};
      if (params) {
        for (var k in params) {
          if (k === 'roughness' || k === 'metalness' || k === 'envMapIntensity' || k === 'flatShading') continue;
          p[k] = params[k];
        }
      }
      return new Lam(p);
    };
    swapped.__lambertSwap = true;
    THREE.MeshStandardMaterial = swapped;
  }

  // Scenery pieces only ever move as a whole (position.z of the piece / top-level
  // child). Their inner meshes never change, so stop recomputing their local
  // matrices every frame — thousands of compose() calls per frame on the CPU.
  function freezeStaticScenery() {
    if (!sceneryPieces || !sceneryPieces.length) return;
    var movers = new Set(sceneryPieces);
    function freezeNode(n) {
      if (movers.has(n)) return;
      n.updateMatrix();
      n.matrixAutoUpdate = false;
    }
    for (var i = 0; i < sceneryPieces.length; i++) {
      var scp = sceneryPieces[i];
      if (!scp) continue;
      var tops = scp.children;
      for (var j = 0; j < tops.length; j++) {
        var top = tops[j];
        if (scp.userData && scp.userData.segmentedScenery) {
          // top-level children get position.z written each frame: keep them live
          for (var k = 0; k < top.children.length; k++) top.children[k].traverse(freezeNode);
        } else {
          top.traverse(freezeNode);
        }
      }
    }
  }

  function applyRenderRatio(r) {
    PERF.ratio = r;
    renderer.setPixelRatio(r);
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  function dropShadowsNow() {
    if (!renderer || !renderer.shadowMap.enabled) return;
    renderer.shadowMap.enabled = false;
    if (scene && scene.userData.dir) scene.userData.dir.castShadow = false;
  }

  // Dynamic resolution: called once per real frame with the raw frame time (ms).
  function adaptQuality(rawMs) {
    if (!renderer || rawMs > 250 || !running || paused || dying) return;
    PERF.ema += (rawMs - PERF.ema) * 0.08;
    if (PERF.raiseBlockMs > 0) PERF.raiseBlockMs -= rawMs;
    if (PERF.coolMs > 0) { PERF.coolMs -= rawMs; return; }
    if (PERF.ema > 24) {                       // below ~42 fps
      PERF.fastMs = 0;
      PERF.slowMs += rawMs;
      if (PERF.slowMs > 1200) {
        PERF.slowMs = 0;
        if (PERF.ratio > PERF.min + 0.01) {
          // if we just raised and it got slow again, stop trying to go that high
          if (PERF.justRaised) { PERF.max = Math.max(PERF.min, PERF.ratio - 0.1); PERF.justRaised = false; }
          applyRenderRatio(Math.max(PERF.min, PERF.ratio - 0.15));
          PERF.raiseBlockMs = 15000;
          PERF.coolMs = 1500;
        } else {
          // already at the floor and still slow: cut shadows, remember 'low'
          PERF.floorMs += 1200;
          if (PERF.floorMs >= 3600) {
            dropShadowsNow();
            if (!PERF.floorSaved) {
              PERF.floorSaved = true;
              try { localStorage.setItem(LS_QUALITY, 'low'); } catch (e2) {}
            }
          }
        }
      }
    } else if (PERF.ema < 17.8 && PERF.ratio < PERF.max - 0.01 && PERF.raiseBlockMs <= 0) {
      PERF.slowMs = 0; PERF.floorMs = 0;
      PERF.fastMs += rawMs;
      if (PERF.fastMs > 6000) {
        PERF.fastMs = 0;
        PERF.justRaised = true;
        applyRenderRatio(Math.min(PERF.max, PERF.ratio + 0.1));
        PERF.coolMs = 1500;
      }
    } else {
      PERF.slowMs = Math.max(0, PERF.slowMs - rawMs);
      PERF.fastMs = 0;
      if (PERF.ema < 20) PERF.floorMs = 0;
    }
  }

  // HUD / meter DOM writes only when the value actually changed
  var _hudCache = { score: -1, combo: -1, dist: -1, stage: -1, prog: '', warn: '' };
  var _meterCache = { h: -1, ready: null, dis: null, txt: '' };
  function resetUiCaches() {
    _hudCache.score = _hudCache.combo = _hudCache.dist = _hudCache.stage = -1;
    _hudCache.prog = ''; _hudCache.warn = '';
    _closeCallPrev = null;
    _meterCache.h = -1; _meterCache.ready = null; _meterCache.dis = null; _meterCache.txt = '';
  }

  // ----- tiny pooled particle bursts (coin sparkle, landing dust) -----
  var fxPool = [];
  var FX_MAX = 48;
  var fxGeo = null;
  function fxBurst(x, y, z, color, n, spd) {
    if (!scene) return;
    if (!fxGeo) fxGeo = new THREE.BoxGeometry(0.09, 0.09, 0.09);
    for (var k = 0; k < n; k++) {
      var f = null;
      for (var q = 0; q < fxPool.length; q++) if (fxPool[q].life <= 0) { f = fxPool[q]; break; }
      if (!f) {
        if (fxPool.length >= FX_MAX) return;
        var m = new THREE.Mesh(fxGeo, new THREE.MeshBasicMaterial({ color: color, transparent: true }));
        scene.add(m);
        f = { m: m, life: 0, max: 0.45, vx: 0, vy: 0, vz: 0 };
        fxPool.push(f);
      }
      f.m.material.color.setHex(color);
      f.m.position.set(x, y, z);
      f.m.visible = true;
      f.life = f.max = 0.35 + Math.random() * 0.2;
      f.vx = (Math.random() - 0.5) * spd;
      f.vy = Math.random() * spd * 0.9 + 0.5;
      f.vz = (Math.random() - 0.5) * spd * 0.6;
    }
  }
  function updateFx(dt, dz) {
    for (var i = 0; i < fxPool.length; i++) {
      var f = fxPool[i];
      if (f.life <= 0) continue;
      f.life -= dt;
      if (f.life <= 0) { f.m.visible = false; continue; }
      f.vy -= 9 * dt;
      f.m.position.x += f.vx * dt;
      f.m.position.y = Math.max(0.03, f.m.position.y + f.vy * dt);
      f.m.position.z += f.vz * dt + dz;   // stay in world space while the track scrolls
      var u = f.life / f.max;
      f.m.material.opacity = u;
      f.m.scale.set(u, u, u);
    }
  }
  function clearFx() {
    for (var i = 0; i < fxPool.length; i++) { fxPool[i].life = 0; fxPool[i].m.visible = false; }
  }

  var visualTime = 0;
  var running = false;
  var gameOver = false;
  var paused = false;
  var dying = false;
  var minderFx = []; // gas + poop particles for Minder
  var dieT = 0;
  var deathReason = 'crash';
  var ragdoll = [];
  var lane = 1;
  var prevLane = 1;
  var laneX = 0;
  var laneInputLock = 0;
  var lastLaneSwitchT = 0;
  var laneSwitchStreak = 0;
  // Collision/pickup logic should use the character's actual X while the
  // lane switch animation is in progress, not the discrete target lane.
  // This prevents the classic SS-feel bug where the model visibly moved off
  // a train but the old lane index still killed it.
  var LANE_HIT_HALF = 0.68; // ~31% of lane gap — fair, less double-lane snags
  function inLaneX(laneIdx, x) {
    return Math.abs(LANES[laneIdx] - x) <= LANE_HIT_HALF;
  }
  var y = 0, vy = 0;
  var wasAirborne = false;
  var sliding = false, slideT = 0;
  var coyoteT = 0;      // SS-feel: brief jump after leaving ground/roof
  var jumpBufferT = 0;  // press jump slightly early
  var speed = 19;
  var dist = 0;
  var score = 0;
  var combo = 1;
  var spawnZ = -20;
  var lastT = 0;
  var threat = 0;
  var nearMissCd = 0;
  var invuln = 0;
  var coins = 0;
  var obstacles = [];
  var pickups = [];
  var boosts = [];
  var powerups = [];
  var boostTimer = 0;      // remaining boost time
  var laneSlowT = 0;       // SS slowdown when swiping into train lane
  // Subway-like powers (seconds remaining)
  var pwr = { magnet: 0, x2: 0, board: 0, jump: 0, jet: 0 };
  var boardHits = 0; // hoverboard absorbs 1 crash while active
  var coinMeter = 0; // 0..100
  var METER_MAX = 100;
  var monkeyTimer = 0; // rampage seconds
  var MONKEY_DUR = 3.5;
  var monkeyCooldown = 0;
  var MONKEY_CD = 14;
  var MONKEY_MIN_DIST = 40; // can activate after short warm-up
  var monkeyReady = false;


  var gap = 12;            // distance to Buddy — 0 = caught
  var GAP_MAX = 16;
  var GAP_MIN_CATCH = 1.5;
  var distSinceBoostSpawn = 0;
  var lastBoostDist = 0;
  // Phrase director: keeps the track varied like Subway Surfers instead of
  // letting the procedural RNG repeat the same threat shape back-to-back.
  var lastPatternBucket = -1;
  var safeLaneHint = 1;
  var patternStreak = 0;
  var sessionSeed = 0;
  var actionStreak = 0;
  var actionStreakT = 0;



  // ----- Web Audio: seamless loops, crossfade, pitch/rate, metronome -----
  var BPM_CLASSIC = 150;
  var BPM_CHILL = 130;
  var METRO_NATIVE_BPM = 150;
  var BPM = BPM_CLASSIC;
  var BEAT = 60 / BPM;
  var musicSet = 1; // default menu track: 130 BPM
  var LEVEL_SCORE = 24000; // legacy (HUD progress uses unlock scores)
  var UNLOCK_SCORE_2 = 12000; // clear challenge on stage 1 to unlock stage 2
  var UNLOCK_SCORE_SECRET = 18000; // stage 2 challenge unlocks «Узнать тайну»
  var LS_SEALED = 'gleb_run_archive_sealed_v1';
  var activeStage = 1; // 1 / 2 / 3 — fixed for the run
  var level = 1;
  var levelBannerT = 0;
  var LS_UNLOCK = 'gleb_run_unlock_v1';
  var audioCtx = null;
  var musicReady = false;
  var musicStarted = false;
  var bufRun = null, bufBoost = null, bufMetro = null;
  var srcRun = null, srcBoost = null, srcMetro = null;
  var gainRun = null, gainBoost = null, gainMetro = null;
  var volRun = 1, volBoost = 0, volMetro = 0;
  var musicRate = 1;
  var beatClock = 0; // seconds into song continuum
  var beatIndex = 0; // integer beat count (quarter notes)
  var lastBeatIndex = -1;
  var spawnBeatCursor = 8; // next beat index to place content ahead
  var spawnFillBeatCursor = 9; // off-beat coin accents (odd beats), offset from the obstacle grid
  var lastRollBeat = -99;
  var lastRollLanes = [];
  var lastCommitObstacleBeat = -99;
  var lastCommitObstacleKind = '';
  var lastCommitObstacleZ = 0;
  var onRoof = false;
  var wasOnRoof = false;
  var roofContact = false;
  var roofJumpLock = 0;
  var roofUntilZ = 0; // world-relative: while current roof obstacle still overlapping
  // grace window (seconds) that survives a single bad frame at the seam
  // between chained roof pieces (train->bridge->train): without this,
  // a large per-frame dz (lag spike, boost, monkey rampage) can skip clean
  // over the thin overlap zone between two roof meshes and drop onRoof to
  // false mid-run, sending the player through the bridge into the next car.
  var roofGrace = 0;
  var propScrubT = 0;

  function ensureAudioCtx() {
    if (audioCtx) return audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
    return audioCtx;
  }

  // ----- Lightweight synthesized SFX ----------------------------------
  // The embed only ships 3 music loops (run/boost/metro) — no one-shot
  // sounds for jump/coin/crash/etc. Subway Surfers leans hard on punchy
  // per-action SFX for game feel; here every action was silent, which
  // reads as flat next to it. Rather than needing new audio assets,
  // synthesize short blips with WebAudio — and since this is a rhythm
  // game, pick their pitches from a minor-pentatonic scale so pickups
  // sound musical (rising with combo) instead of arbitrary beeps.
  var gainSfx = null;
  var PENTA = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00, 987.77];
  function ensureSfxBus() {
    if (gainSfx) return gainSfx;
    ensureAudioCtx();
    if (!audioCtx) return null;
    gainSfx = audioCtx.createGain();
    gainSfx.gain.value = 0.55;
    gainSfx.connect(audioCtx.destination);
    return gainSfx;
  }
  function sfxTone(freq, dur, opts) {
    var bus = ensureSfxBus();
    if (!bus) return;
    opts = opts || {};
    var t0 = audioCtx.currentTime;
    var osc = audioCtx.createOscillator();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t0 + dur);
    var g = audioCtx.createGain();
    var peak = opts.gain != null ? opts.gain : 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + (opts.attack || 0.012));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(bus);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }
  function sfxThud(dur, opts) {
    var bus = ensureSfxBus();
    if (!bus) return;
    opts = opts || {};
    var t0 = audioCtx.currentTime;
    var n = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
    var buf = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    var src = audioCtx.createBufferSource();
    src.buffer = buf;
    var filt = audioCtx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = opts.freq || 220;
    var g = audioCtx.createGain();
    g.gain.setValueAtTime(opts.gain || 0.5, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(bus);
    src.start(t0);
  }
  function sfxCoin(combo) {
    var idx = Math.max(0, Math.min(PENTA.length - 1, Math.floor((combo - 1) * 1.4)));
    sfxTone(PENTA[idx], 0.16, { type: 'triangle', gain: 0.22 });
  }
  function sfxJump() {
    sfxTone(380, 0.12, { type: 'sine', slideTo: 720, gain: 0.2 });
    sfxTone(190, 0.08, { type: 'triangle', slideTo: 120, gain: 0.1 });
  }
  function sfxSlide() {
    sfxThud(0.1, { freq: 220, gain: 0.18 });
    sfxTone(240, 0.14, { type: 'sawtooth', slideTo: 70, gain: 0.12 });
  }
  function sfxLand() {
    sfxThud(0.07, { freq: 140, gain: 0.22 });
    sfxTone(160, 0.06, { type: 'triangle', slideTo: 80, gain: 0.1 });
  }
  function sfxLane() {
    sfxTone(480, 0.05, { type: 'sine', slideTo: 320, gain: 0.1 });
  }
  function sfxRoof() {
    sfxTone(520, 0.09, { type: 'triangle', slideTo: 400, gain: 0.12 });
    sfxThud(0.05, { freq: 200, gain: 0.12 });
  }
  function sfxNearMiss() {
    sfxTone(880, 0.06, { type: 'square', slideTo: 1200, gain: 0.1 });
    setTimeout(function () { sfxTone(1320, 0.05, { type: 'sine', gain: 0.08 }); }, 40);
  }
  function sfxWhoosh() {
    sfxThud(0.18, { freq: 90, gain: 0.2 });
    sfxTone(180, 0.2, { type: 'sawtooth', slideTo: 60, gain: 0.08 });
  }
  function sfxCaught() {
    sfxThud(0.4, { freq: 80, gain: 0.5 });
    sfxTone(120, 0.35, { type: 'sawtooth', slideTo: 40, gain: 0.18 });
  }
  function sfxMonkey() {
    sfxTone(110, 0.25, { type: 'sawtooth', slideTo: 55, gain: 0.16 });
    setTimeout(function () { sfxTone(90, 0.3, { type: 'square', slideTo: 40, gain: 0.12 }); }, 80);
    sfxThud(0.2, { freq: 70, gain: 0.28 });
  }
  function sfxUi() {
    sfxTone(660, 0.05, { type: 'sine', gain: 0.12 });
  }
  function sfxPower() {
    sfxTone(523.25, 0.12, { type: 'square', gain: 0.15 });
    setTimeout(function () { sfxTone(783.99, 0.16, { type: 'square', gain: 0.15 }); }, 65);
    setTimeout(function () { sfxTone(1046.5, 0.12, { type: 'triangle', gain: 0.1 }); }, 130);
  }
  function sfxBoost() { sfxTone(220, 0.35, { type: 'sawtooth', slideTo: 880, gain: 0.14 }); }
  function sfxBeatTick(perfect) { sfxTone(perfect ? 987.77 : 659.25, 0.08, { type: 'triangle', gain: 0.16 }); }
  function sfxCrash() {
    sfxThud(0.28, { freq: 140, gain: 0.5 });
    sfxTone(100, 0.25, { type: 'sawtooth', slideTo: 35, gain: 0.2 });
  }

  function decodeDataUri(uri) {
    return fetch(uri).then(function (r) { return r.arrayBuffer(); })
      .then(function (ab) { return audioCtx.decodeAudioData(ab.slice(0)); });
  }

  function initMusic() {
    if (musicReady) return Promise.resolve();
    if (!window.BBH_AUDIO_RUN || !window.BBH_AUDIO_BOOST) {
      console.warn('audio embed missing');
      return Promise.resolve();
    }
    ensureAudioCtx();
    if (!audioCtx) return Promise.resolve();
    gainRun = audioCtx.createGain();
    gainBoost = audioCtx.createGain();
    gainMetro = audioCtx.createGain();
    gainRun.gain.value = 1;
    gainBoost.gain.value = 0;
    gainMetro.gain.value = 0;
    gainRun.connect(audioCtx.destination);
    gainBoost.connect(audioCtx.destination);
    gainMetro.connect(audioCtx.destination);
    var jobs = [
      decodeDataUri(window.BBH_AUDIO_RUN),
      decodeDataUri(window.BBH_AUDIO_BOOST)
    ];
    if (window.BBH_AUDIO_METRO) jobs.push(decodeDataUri(window.BBH_AUDIO_METRO));
    if (window.BBH_AUDIO_WALK) jobs.push(decodeDataUri(window.BBH_AUDIO_WALK));
    if (window.BBH_AUDIO_RUN130) jobs.push(decodeDataUri(window.BBH_AUDIO_RUN130));
    return Promise.all(jobs).then(function (bufs) {
      bufRun = bufs[0];
      bufBoost = bufs[1];
      var idx = 2;
      if (window.BBH_AUDIO_METRO) { bufMetro = bufs[idx++] || null; }
      if (window.BBH_AUDIO_WALK) { window.__bufWalk = bufs[idx++] || null; }
      if (window.BBH_AUDIO_RUN130) { window.__bufRun130 = bufs[idx++] || null; }
      // store classic pair
      window.__bufRunClassic = bufRun;
      window.__bufBoostClassic = bufBoost;
      musicReady = true;
      applyMusicSet(false);
    }).catch(function (e) { console.warn('decode', e); });
  }

  function applyStageTheme(stage) {
    // Strong visual separation between stages
    if (!scene) return;
    var hemi = scene.userData.hemi;
    var amb = scene.userData.amb;
    var dir = scene.userData.dir;
    var fill = scene.userData.fill;
    var green = scene.userData.fillGreen;
    if (stage === 1) {
      // Cool night metro — cyan / steel
      scene.fog = new THREE.Fog(0x081420, 26, 105);
      renderer.setClearColor(0x050a12, 1);
      if (hemi) { hemi.color.setHex(0x7a9cc8); hemi.groundColor.setHex(0x0a1018); hemi.intensity = 0.55; }
      if (amb) { amb.color.setHex(0x121826); amb.intensity = 0.18; }
      if (dir) { dir.color.setHex(0xd8e8ff); dir.intensity = 1.15; }
      if (fill) { fill.color.setHex(0x3a6aaa); fill.intensity = 0.5; }
      if (green) { green.color.setHex(0x44aaff); green.intensity = 0.2; }
    } else if (stage === 2) {
      // Hot underworld rail — magenta / blood amber
      scene.fog = new THREE.Fog(0x1a0610, 22, 92);
      renderer.setClearColor(0x100308, 1);
      if (hemi) { hemi.color.setHex(0xff6a9a); hemi.groundColor.setHex(0x1a0508); hemi.intensity = 0.48; }
      if (amb) { amb.color.setHex(0x2a0a14); amb.intensity = 0.22; }
      if (dir) { dir.color.setHex(0xffb070); dir.intensity = 1.25; }
      if (fill) { fill.color.setHex(0xaa2060); fill.intensity = 0.65; }
      if (green) { green.color.setHex(0xff3366); green.intensity = 0.28; }
    } else {
      scene.fog = new THREE.Fog(0x0c0c18, 24, 95);
      renderer.setClearColor(0x080810, 1);
      if (hemi) { hemi.color.setHex(0x8890c0); hemi.groundColor.setHex(0x0a0a14); hemi.intensity = 0.5; }
      if (amb) { amb.color.setHex(0x141420); amb.intensity = 0.2; }
      if (dir) { dir.color.setHex(0xe0d8ff); dir.intensity = 1.1; }
      if (fill) { fill.color.setHex(0x6655aa); fill.intensity = 0.55; }
    }
    rebuildSky(stage);
    restyleGround(stage);
    restyleScenery(stage);
  }

  function rebuildSky(stage) {
    var top, mid, low, bot;
    if (stage === 2) {
      top = '#1a0208'; mid = '#3a0a18'; low = '#6a1830'; bot = '#a02840';
    } else if (stage === 3) {
      top = '#04040c'; mid = '#0c0c20'; low = '#1a1840'; bot = '#2a2860';
    } else {
      top = '#02060c'; mid = '#0a1524'; low = '#143048'; bot = '#1a4060';
    }
    var w = 4, h = 256;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, top);
    grad.addColorStop(0.45, mid);
    grad.addColorStop(0.78, low);
    grad.addColorStop(1, bot);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    // faint stars / sparks
    ctx.fillStyle = stage === 2 ? 'rgba(255,180,120,0.35)' : 'rgba(180,220,255,0.4)';
    for (var i = 0; i < 40; i++) {
      ctx.fillRect(Math.random() * w, Math.random() * h * 0.55, 1, 1);
    }
    var tex = new THREE.CanvasTexture(c);
    if (scene.userData.skyMesh) {
      scene.userData.skyMesh.material.map = tex;
      scene.userData.skyMesh.material.needsUpdate = true;
    } else {
      var sky = new THREE.Mesh(
        new THREE.SphereGeometry(90, 16, 12),
        new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, depthWrite: false })
      );
      scene.add(sky);
      scene.userData.skyMesh = sky;
    }
  }

  function restyleGround(stage) {
    if (!groundTex) return;
    var base = stage === 2 ? '#2a1018' : (stage === 3 ? '#14141c' : '#14181f');
    var line = stage === 2 ? 'rgba(255,80,100,0.25)' : 'rgba(80,160,220,0.22)';
    var w = 128, h = 512;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = line;
    ctx.lineWidth = 2;
    for (var s = 0; s < 8; s++) {
      var yy = (s + 0.5) * (h / 8);
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
    }
    // center lane glow strip
    ctx.fillStyle = stage === 2 ? 'rgba(255,60,90,0.12)' : 'rgba(60,140,220,0.1)';
    ctx.fillRect(w * 0.35, 0, w * 0.3, h);
    groundTex.image = c;
    groundTex.needsUpdate = true;
  }

  function restyleScenery(stage) {
    if (!sceneryGroup) return;
    sceneryGroup.traverse(function (obj) {
      if (!obj.isMesh || !obj.material) return;
      var m = obj.material;
      if (m.emissive) {
        var e = m.emissive.getHex();
        if (stage === 2) {
          // cool → hot neon
          if (e === 0x2b8cff || e === 0x28ff77 || e === 0x24ff70 || e === 0x2bff75 || e === 0x27caff) {
            m.emissive.setHex(0xff2a6a); m.color.setHex(0xff4f78);
            if (m.emissiveIntensity != null) m.emissiveIntensity = Math.max(m.emissiveIntensity || 0.8, 1.15);
          } else if (e === 0xffc56e || e === 0xff9c22 || e === 0xffe4a6) {
            m.emissive.setHex(0xff5520);
          }
        } else if (stage === 1) {
          if (e === 0xff2a6a) {
            m.emissive.setHex(0x2b8cff); m.color.setHex(0x5fc7ff);
          }
        }
      }
      // walls / concrete body tints
      if (m.color && !m.map) {
        var c = m.color.getHex();
        if (stage === 2 && (c === 0x30343a || c === 0x252b31 || c === 0x333a41 || c === 0x24272b)) {
          m.color.setHex(0x3a2028);
        } else if (stage === 1 && (c === 0x3a2028)) {
          m.color.setHex(0x30343a);
        }
      }
    });
  }

  function applyMusicSet(restart) {
    BPM = musicSet === 1 ? BPM_CHILL : BPM_CLASSIC;
    BEAT = 60 / BPM;
    if (musicSet === 1 && window.__bufWalk && window.__bufRun130) {
      bufRun = window.__bufWalk;
      bufBoost = window.__bufRun130;
    } else {
      bufRun = window.__bufRunClassic || bufRun;
      bufBoost = window.__bufBoostClassic || bufBoost;
    }
    // metronome: file is 150bpm → rate scales to current BPM
    var metroRate = BPM / METRO_NATIVE_BPM;
    if (srcMetro) {
      try { srcMetro.playbackRate.value = metroRate * (musicRate || 1); } catch (e) {}
    }
    if (srcRun) {
      try { srcRun.playbackRate.value = musicRate || 1; } catch (e) {}
    }
    if (srcBoost) {
      try { srcBoost.playbackRate.value = musicRate || 1; } catch (e) {}
    }
    if (restart && musicStarted) {
      startMusic();
    }
  }


  function makeLoopSource(buffer, gainNode) {
    var src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    // seamless if file is authored seamless; no pause between loops
    src.loopStart = 0;
    src.loopEnd = buffer.duration;
    src.playbackRate.value = 1;
    src.connect(gainNode);
    return src;
  }

  function startMusic() {
    ensureAudioCtx();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      try { audioCtx.resume(); } catch (eR) {}
    }
    initMusic().then(function () {
      if (!musicReady) {
        console.warn('[GLEB] music not ready — check audio_embed.js');
        return;
      }
      if (!bufRun) {
        console.warn('[GLEB] bufRun missing');
        return;
      }
      stopMusicSourcesOnly();
      var t0 = audioCtx.currentTime + 0.02;
      if (!gainRun) {
        gainRun = audioCtx.createGain();
        gainRun.connect(audioCtx.destination);
      }
      if (!gainBoost) {
        gainBoost = audioCtx.createGain();
        gainBoost.connect(audioCtx.destination);
      }
      if (!gainMetro) {
        gainMetro = audioCtx.createGain();
        gainMetro.connect(audioCtx.destination);
      }
      srcRun = makeLoopSource(bufRun, gainRun);
      srcBoost = makeLoopSource(bufBoost || bufRun, gainBoost);
      srcRun.start(t0);
      srcBoost.start(t0);
      if (bufMetro) {
        srcMetro = makeLoopSource(bufMetro, gainMetro);
        srcMetro.start(t0);
      }
      // sync gains
      gainRun.gain.setValueAtTime(1, t0);
      gainBoost.gain.setValueAtTime(0.0001, t0);
      if (gainMetro) gainMetro.gain.setValueAtTime(0.0001, t0);
      volRun = 1; volBoost = 0; volMetro = 0;
      // kick context in case browser suspended it mid-decode
      try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (eK) {}
      musicRate = 1;
      var wasStarted = musicStarted;
      musicStarted = true;
      // NEVER reset beat grid mid-run — kills spawn cursors on level/track switch
      if (!wasStarted) beatClock = 0;
      applyMusicSet(false);
      if (srcMetro) {
        try { srcMetro.playbackRate.value = BPM / METRO_NATIVE_BPM; } catch (e) {}
      }
    });
  }

  function stopMusicSourcesOnly() {
    try { if (srcRun) srcRun.stop(); } catch (e) {}
    try { if (srcBoost) srcBoost.stop(); } catch (e) {}
    try { if (srcMetro) srcMetro.stop(); } catch (e) {}
    srcRun = srcBoost = srcMetro = null;
  }

  
function stopMusic() {
    stopMusicSourcesOnly();
    musicStarted = false;
  }

  // ----- Menu / pause / game-over ambient bed -----
  // Soft dark pad (WebAudio synth) so menu always has sound even without extra OGG.
  // Optionally layers the chill walk loop underneath at low volume when decoded.
  var ambGain = null;
  var ambNodes = [];
  var ambSrcLoop = null;
  var ambMode = 'off'; // off | menu | pause | over
  var ambWant = false;

  function stopAmbient() {
    ambWant = false;
    ambMode = 'off';
    try {
      for (var i = 0; i < ambNodes.length; i++) {
        try { ambNodes[i].stop(); } catch (e1) {}
        try { ambNodes[i].disconnect(); } catch (e2) {}
      }
    } catch (e3) {}
    ambNodes = [];
    try { if (ambSrcLoop) ambSrcLoop.stop(); } catch (e4) {}
    ambSrcLoop = null;
    if (ambGain) {
      try { ambGain.gain.setValueAtTime(0.0001, audioCtx ? audioCtx.currentTime : 0); } catch (e5) {}
    }
  }

  function ensureAmbGain() {
    ensureAudioCtx();
    if (!audioCtx) return null;
    if (!ambGain) {
      ambGain = audioCtx.createGain();
      ambGain.gain.value = 0.0001;
      ambGain.connect(audioCtx.destination);
    }
    return ambGain;
  }

  function startAmbient(mode) {
    // mode: menu | pause | over
    ensureAudioCtx();
    if (!audioCtx) return;
    try { if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (eR) {}
    var g = ensureAmbGain();
    if (!g) return;

    var same = (ambMode === mode && ambNodes.length > 0);
    ambMode = mode || 'menu';
    ambWant = true;
    if (same) {
      // just retarget volume
      var target = mode === 'pause' ? 0.22 : (mode === 'over' ? 0.28 : 0.32);
      try { g.gain.linearRampToValueAtTime(target, audioCtx.currentTime + 0.35); } catch (eT) {}
      return;
    }

    stopAmbient();
    ambMode = mode || 'menu';
    ambWant = true;
    g = ensureAmbGain();
    var t0 = audioCtx.currentTime;
    var target = mode === 'pause' ? 0.22 : (mode === 'over' ? 0.28 : 0.32);

    // dark detuned pad
    var freqs = mode === 'over'
      ? [55, 82.5, 110, 164.8]
      : (mode === 'pause' ? [65.4, 98, 130.8] : [73.4, 110, 146.8, 220]);
    for (var fi = 0; fi < freqs.length; fi++) {
      var osc = audioCtx.createOscillator();
      osc.type = fi % 2 === 0 ? 'sine' : 'triangle';
      osc.frequency.value = freqs[fi];
      osc.detune.value = (fi - 1.5) * 8;
      var og = audioCtx.createGain();
      og.gain.value = (0.12 + (fi === 0 ? 0.08 : 0)) / freqs.length;
      var filt = audioCtx.createBiquadFilter();
      filt.type = 'lowpass';
      filt.frequency.value = mode === 'over' ? 420 : 700;
      filt.Q.value = 0.7;
      osc.connect(og);
      og.connect(filt);
      filt.connect(g);
      osc.start(t0);
      ambNodes.push(osc);
    }
    // slow pulse LFO on master amb gain
    try {
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(target, t0 + 0.6);
    } catch (eG) {}

    // ambient only: no level tracks layered into menu / pause / game over
  }

  function duckGameMusic(on) {
    if (!audioCtx) return;
    var now = audioCtx.currentTime;
    var runV = on ? 0.0001 : Math.max(0.0001, volRun);
    var boostV = on ? 0.0001 : Math.max(0.0001, volBoost);
    try {
      if (gainRun) gainRun.gain.linearRampToValueAtTime(runV, now + 0.2);
      if (gainBoost) gainBoost.gain.linearRampToValueAtTime(boostV, now + 0.2);
      if (gainMetro) gainMetro.gain.linearRampToValueAtTime(on ? 0.0001 : Math.max(0.0001, volMetro), now + 0.2);
    } catch (eD) {}
  }



  function updateMusic(dt) {
    if (!musicReady || !musicStarted || !audioCtx) return;
    var now = audioCtx.currentTime;
    // crossfade targets
    var targetBoost = boostTimer > 0.05 ? 1 : 0;
    var targetRun = 1 - targetBoost;
    // smooth ~0.9s
    var k = 1 - Math.exp(-dt * 2.2);
    volBoost += (targetBoost - volBoost) * k;
    volRun += (targetRun - volRun) * k;
    // metronome only when Buddy close
    var targetMetro = Math.max(0, Math.min(1, (threat - 0.35) / 0.55));
    volMetro += (targetMetro - volMetro) * k;

    gainRun.gain.setTargetAtTime(Math.max(0.0001, volRun), now, 0.05);
    gainBoost.gain.setTargetAtTime(Math.max(0.0001, volBoost), now, 0.05);
    gainMetro.gain.setTargetAtTime(Math.max(0.0001, volMetro), now, 0.05);

    // Boost pad only crossfades boost loop — NO pitch/tempo change
    var targetRate = 1 - threat * 0.32;
    targetRate = Math.max(0.7, Math.min(1, targetRate));
    if (monkeyTimer > 0) targetRate = Math.max(targetRate, 1.35);
    targetRate = Math.min(1.5, targetRate);
    musicRate += (targetRate - musicRate) * Math.min(1, dt * 3);
    try {
      if (srcRun) srcRun.playbackRate.setTargetAtTime(musicRate, now, 0.08);
      if (srcBoost) srcBoost.playbackRate.setTargetAtTime(musicRate, now, 0.08);
      // metronome.ogg is 150 BPM native — scale to current track BPM * threat rate
      if (srcMetro) srcMetro.playbackRate.setTargetAtTime((BPM / METRO_NATIVE_BPM) * musicRate, now, 0.08);
    } catch (e) {}
  }

  function beatDistUnits() {
    // world units traveled during one quarter-note at current speed
    return Math.max(5.5, speed * BEAT);
  }

  function zOnBeat(beatsAhead) {
    // player sits near z=2; content moves +Z toward him. Spawn further at more negative Z.
    var bd = beatDistUnits();
    return 2 - beatsAhead * bd;
  }

  function snapBeatsAhead(z) {
    var bd = beatDistUnits();
    var ahead = (2 - z) / bd;
    return Math.max(1, Math.round(ahead));
  }



  // --- Rhythm as reward, not as latency ---------------------------------
  // Original design queued every lane/jump/slide input and only applied it
  // on the next 8th-note edge (up to ~200ms after the keypress). Compared
  // to Subway Surfers' instant swipe response, that made dodges feel
  // laggy and, at top speed, could eat the entire reaction window before
  // an obstacle's collision zone — a death the player did nothing "wrong"
  // to deserve. Actions now fire the instant you press them (SS-style),
  // and hitting them close to the beat instead grants a score/combo
  // bonus + on-screen feedback, so the 150 BPM track stays part of the
  // feel without ever taxing your reflexes.
  var beatFxTimer = 0;
  var keyHeld = Object.create(null);
  var beatBonusCd = 0;

  function beatBonusCheck() {
    if (!musicStarted) return;
    if (beatBonusCd > 0) return;
    var eighth = BEAT * 0.5;
    var phase = beatClock % eighth;
    var distToEdge = Math.min(phase, eighth - phase);
    var acc = 1 - distToEdge / (eighth * 0.5);
    if (acc < 0.78) return;
    var perfect = acc > 0.93;
    var bonus = Math.round(6 + acc * 12) * (pwr.x2 > 0 ? 2 : 1);
    score += bonus;
    combo = Math.min(9, combo + 0.03);
    showBeatFx(perfect ? 'ИДЕАЛЬНО!' : 'В РИТМ!', perfect);
    sfxBeatTick(perfect);
    beatBonusCd = 0.4;
  }

  function showBeatFx(text, perfect) {
    if (!el.beatFx) return;
    el.beatFx.textContent = text;
    el.beatFx.classList.toggle('perfect', !!perfect);
    // restart CSS animation even if it's already mid-flight
    el.beatFx.classList.remove('show');
    void el.beatFx.offsetWidth;
    el.beatFx.classList.add('show');
    beatFxTimer = 0.5;
  }

  var visualQuality = { low: false };
  function mat(color, opts) {
    opts = opts || {};
    var m = new THREE.MeshStandardMaterial({
      color: color,
      roughness: opts.roughness != null ? opts.roughness : 0.68,
      metalness: opts.metalness != null ? opts.metalness : 0.08,
      emissive: opts.emissive != null ? opts.emissive : 0x000000,
      emissiveIntensity: opts.ei != null ? opts.ei : 0
    });
    if (opts.flat) m.flatShading = true;
    return m;
  }

  function panelTexture(text, bg, fg) {
    var c = document.createElement('canvas');
    c.width = 512; c.height = 180;
    var ctx = c.getContext('2d');
    ctx.fillStyle = bg || '#10141b';
    ctx.fillRect(0,0,c.width,c.height);
    ctx.fillStyle = 'rgba(255,255,255,.06)';
    for (var i=0;i<18;i++) ctx.fillRect((i*47)%512, 0, 2, 180);
    ctx.strokeStyle = 'rgba(130,255,190,.18)'; ctx.lineWidth = 5;
    ctx.strokeRect(9,9,c.width-18,c.height-18);
    ctx.fillStyle = fg || '#a7ffd0';
    ctx.font = '900 58px Arial Black, Arial';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(text,256,92);
    var tex=new THREE.CanvasTexture(c);
    tex.wrapS=THREE.ClampToEdgeWrapping; tex.wrapT=THREE.ClampToEdgeWrapping;
    return tex;
  }

  function graffitiTexture(seed, accentA, accentB) {
    var c = document.createElement('canvas'); c.width = 256; c.height = 96;
    var ctx = c.getContext('2d');
    ctx.clearRect(0,0,256,96);
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = accentA; ctx.font = '900 46px Arial Black, Arial';
    ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.translate(128,48);
    ctx.rotate((seed%7-3)*0.035);
    ctx.strokeStyle = '#081018'; ctx.lineWidth = 7; ctx.strokeText('GLEB',0,0);
    ctx.fillText('GLEB',0,0);
    ctx.strokeStyle = accentB; ctx.lineWidth = 2.5;
    for (var i=0;i<5;i++) {
      ctx.beginPath(); ctx.moveTo(-112+i*48,-30+(seed%3)*4); ctx.lineTo(-80+i*44,30-(seed%2)*6); ctx.stroke();
    }
    ctx.setTransform(1,0,0,1,0,0);
    return new THREE.CanvasTexture(c);
  }

  function addWetPatch(parent, x, y, z, w, d, opacity) {
    var m = new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.8, roughness: 0.13, transparent:true, opacity:opacity||0.24 });
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(w,d),m);
    mesh.rotation.x=-Math.PI/2; mesh.position.set(x,y,z); parent.add(mesh);
    return mesh;
  }

  function makeBillboard(text, x, y, z, rotY, color) {
    var g=new THREE.Group();
    var frameMat=mat(0x171c22,{metalness:.65,roughness:.38});
    var frame=new THREE.Mesh(new THREE.BoxGeometry(2.8,1.15,.16),frameMat);
    g.add(frame);
    var tex=panelTexture(text,'#0a1015',color||'#7dffb0');
    var sign=new THREE.Mesh(new THREE.PlaneGeometry(2.5,.82),new THREE.MeshBasicMaterial({map:tex,transparent:true}));
    sign.position.z=.085; g.add(sign);
    var glow=new THREE.Mesh(new THREE.PlaneGeometry(2.9,1.25),new THREE.MeshBasicMaterial({color:color||0x65ff9a,transparent:true,opacity:.035,blending:THREE.AdditiveBlending,depthWrite:false}));
    glow.position.z=.02; g.add(glow);
    g.position.set(x,y,z); g.rotation.y=rotY||0; sceneryGroup.add(g); sceneryPieces.push(g);
    return g;
  }

  function addRoadArch(z, width, height, sideMat, parent) {
    var target = parent || trackGroup;
    var m = sideMat || mat(0x252a33, { metalness: 0.6, roughness: 0.48 });
    width = width || 9.5;
    height = height || 4.2;
    [-1, 1].forEach(function(side) {
      var p = new THREE.Mesh(new THREE.BoxGeometry(0.32, height, 0.32), m);
      p.position.set(side * (width / 2), height / 2, z);
      target.add(p);
    });
    var top = new THREE.Mesh(new THREE.BoxGeometry(width, 0.28, 0.32), m);
    top.position.set(0, height, z);
    target.add(top);
    var lamp = new THREE.Mesh(
      new THREE.BoxGeometry(width * 0.35, 0.08, 0.12),
      mat(0xffcc88, { emissive: 0xff9944, ei: 1.1, roughness: 0.3 })
    );
    lamp.position.set(0, height - 0.2, z);
    target.add(lamp);
  }


  // --- V12 ART PASS: reusable stylized industrial / subway props ---------
  function addEdgeBand(parent, w, h, d, y, material, z) {
    var band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.04, 0.06, d + 0.04), material);
    band.position.set(0, y, z || 0);
    parent.add(band);
    return band;
  }

  function addTrainDoor(parent, side, z, glassMat, trimMat) {
    var frame = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.02, 0.88), trimMat);
    frame.position.set(side * 0.94, 0.98, z);
    parent.add(frame);
    var glass = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.72, 0.62), glassMat);
    glass.position.set(side * 0.965, 1.1, z);
    parent.add(glass);
    for (var dy = 0; dy < 3; dy++) {
      var seam = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.018, 0.55), trimMat);
      seam.position.set(side * 0.98, 0.76 + dy * 0.18, z);
      parent.add(seam);
    }
  }

  function addRoofVent(parent, x, z, bodyTop, trimMat) {
    var base = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.12, 0.62), mat(0x1d252c, { metalness: 0.65, roughness: 0.42 }));
    base.position.set(x, bodyTop + 0.08, z);
    parent.add(base);
    for (var k = -1; k <= 1; k++) {
      var fin = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.10, 0.5), trimMat);
      fin.position.set(x + k * 0.13, bodyTop + 0.18, z);
      parent.add(fin);
    }
  }

  function addRoofRail(parent, side, carDepth, bodyTop, material) {
    var rail = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.18, carDepth * 0.56), material);
    rail.position.set(side * 0.88, bodyTop + 0.12, -carDepth * 0.02);
    parent.add(rail);
    for (var i = -2; i <= 2; i++) {
      var post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.25, 0.08), material);
      post.position.set(side * 0.88, bodyTop + 0.06, i * carDepth * 0.11);
      parent.add(post);
    }
  }

  function addPlatformLights(parent, side, z, y, color, count) {
    for (var i = 0; i < (count || 3); i++) {
      var px = side * 5.05;
      var pz = z + (i - 1) * 0.85;
      var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), mat(color, { emissive: color, ei: 1.6, roughness: 0.2 }));
      bulb.position.set(px, y, pz);
      parent.add(bulb);
    }
  }

  function addStationPortal(parent, z, variant) {
    var concrete = mat(0x252b31, { roughness: 0.88, metalness: 0.12 });
    var steel = mat(0x58636d, { roughness: 0.36, metalness: 0.75 });
    var neon = variant ? mat(0xff4f78, { emissive: 0xff1b57, ei: 1.4, roughness: 0.25 }) : mat(0x65ff9a, { emissive: 0x28ff77, ei: 1.4, roughness: 0.25 });
    var g = new THREE.Group();
    // Side pillars only — no full-width top beam (it occluded the camera)
    var pL = new THREE.Mesh(new THREE.BoxGeometry(0.42, 6.0, 0.48), concrete);
    var pR = pL.clone();
    pL.position.set(-5.0, 3.0, 0); pR.position.set(5.0, 3.0, 0);
    g.add(pL, pR);
    // neon strip on each pillar instead of center sign
    [-1, 1].forEach(function(side) {
      var strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2.2, 0.1), neon);
      strip.position.set(side * 5.0, 3.2, 0.28);
      g.add(strip);
    });
    g.position.z = z;
    sceneryGroup.add(g);
    sceneryPieces.push(g);
  }

  function init() {
    if (isArchiveSealed()) { sealForever(); return; }
    try {
      if (PERF.low) useLambertMaterials();
      renderer = new THREE.WebGLRenderer({
        canvas: canvas, antialias: PERF.aa, stencil: false, alpha: false,
        powerPreference: 'high-performance'
      });
      renderer.setPixelRatio(PERF.ratio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setClearColor(0x070708, 1);
      renderer.shadowMap.enabled = PERF.shadows;
      renderer.shadowMap.type = PERF.tier === 'high' ? (THREE.PCFSoftShadowMap || THREE.PCFShadowMap) : THREE.PCFShadowMap;
      renderer.shadowMap.autoUpdate = true;
      if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.02;
      // NOTE: keep this OFF. With physically-correct (inverse-square) falloff,
      // any mesh sitting a few cm from a PointLight (e.g. the lamp bulbs below,
      // which are ~0.06 units from their own light) gets blown out to solid
      // white — that was the source of the big white "blob" artifacts.
      renderer.physicallyCorrectLights = false;

      scene = new THREE.Scene();
      scene.fog = new THREE.Fog(0x080c16, 20, 105);

      // far=112: fog is fully opaque by ~105, anything beyond is wasted draw work
      camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 112);
      camera.position.set(0, 5.2, 9);

      // soft gradient fill (sky-ish top / ground-ish bottom) instead of flat ambient
      var hemi = new THREE.HemisphereLight(0x9aa9d6, 0x100a13, 0.50);
      scene.add(hemi);
      scene.userData.hemi = hemi;
      var amb = new THREE.AmbientLight(0x161a29, 0.15);
      scene.add(amb);
      scene.userData.amb = amb;
      var dir = new THREE.DirectionalLight(0xffd6b0, 1.30);
      dir.position.set(4, 12, 6);
      dir.castShadow = PERF.shadows;
      dir.shadow.mapSize.set(PERF.shadowSize, PERF.shadowSize);
      dir.shadow.camera.near = 1;
      dir.shadow.camera.far = 40;
      scene.add(dir);
      scene.userData.dir = dir;
      // cool rim light from behind for silhouette depth
      var fill = new THREE.DirectionalLight(0x5479d0, 0.55);
      fill.position.set(-6, 5, -14);
      scene.add(fill);
      scene.userData.fill = fill;
      var red = new THREE.PointLight(0xff355f, 0.60, 34);
      red.position.set(0, 3.5, -10);
      scene.add(red);
      scene.userData.chaseLight = red;
      // soft fill only — not a path lantern
      // (skipped on the low tier: every extra light costs every lit pixel)
      if (!PERF.low) {
        var green = new THREE.PointLight(0x274a55, 0.05, 18);
        green.position.set(0, 5.5, 6);
        scene.add(green);
        scene.userData.fillGreen = green;
      }

      buildSky();

      trackGroup = new THREE.Group();
      scene.add(trackGroup);
      propGroup = new THREE.Group();
      // Every obstacle/coin/pad owns its own geometries + materials. They were only
      // detached when they scrolled away, never disposed, so GPU buffers piled up
      // for the whole run (heavy on phones). Dispose on every removal.
      (function (grp) {
        var origRemove = grp.remove;
        grp.remove = function (obj) {
          var res = origRemove.apply(this, arguments);
          for (var ri = 0; ri < arguments.length; ri++) {
            try { disposeTree(arguments[ri]); } catch (eDisp) {}
          }
          return res;
        };
      })(propGroup);
      scene.add(propGroup);
      sceneryGroup = new THREE.Group();
      scene.add(sceneryGroup);

      buildTrack();
      buildWorldScenery();
      buildCinematicScenery();
      buildPremiumEnvironment();
      // Performance: scenery is decorative; don't spend shadow-map passes on dozens of props.
      sceneryGroup.traverse(function(n){ if(n && n.isMesh){ n.castShadow=false; n.receiveShadow=false; } });
      freezeStaticScenery();
      buildTrackHeroDetails();
      buildVisualPolish();
      buildDust();
      buildRain();
      gleb = buildGleb();
      scene.add(gleb);
      buddy = buildBuddy();
      scene.add(buddy);

      window.addEventListener('resize', onResize);
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKeyUp);
      window.addEventListener('blur', function () { keyHeld = Object.create(null); });
      setupTouch();

      function bindBtn(node, fn) {
        if (!node) return;
        // single handler only — click+pointerup fired twice and broke pause toggle
        node.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          // drop focus: otherwise a later Space (jump) fires another "click"
          // on this still-focused button when the key is released
          try { node.blur(); } catch (eB) {}
          if (typeof sfxUi === 'function') sfxUi();
          fn();
        }, true);
      }
      bindBtn(el.btnPause, function () { togglePause(); });
      bindBtn(el.btnResume, function () { if (paused) togglePause(); });
      bindBtn(el.btnExit, function () { exitToMenu(); });
      bindBtn(el.btnStart130, function () { startGame(1); });
      bindBtn(el.btnStart150, function () { startGame(0); });
      bindBtn(el.btnSecret, function () { openBillSecret(); });
      if (isArchiveSealed()) sealForever();
      else {
        refreshMenuLocks();
        // menu bed starts on first pointer/key (browser autoplay policy)
        var armMenuMusic = function () {
          startAmbient('menu');
          window.removeEventListener('pointerdown', armMenuMusic);
          window.removeEventListener('keydown', armMenuMusic);
        };
        window.addEventListener('pointerdown', armMenuMusic, { once: true });
        window.addEventListener('keydown', armMenuMusic, { once: true });
      }
      // legacy single start if present
      if (el.btnStart) {
        el.btnStart.addEventListener('click', function (e) {
          e.preventDefault();
          startGame();
        });
      }
      if (el.btnRetry) {
        el.btnRetry.addEventListener('click', function (e) {
          e.preventDefault();
          // retry same stage: 1→opt 1, 2→opt 0, 3→opt 2
          var opt = activeStage === 1 ? 1 : (activeStage === 3 ? 2 : 0);
          startGame(opt);
        });
      }
      if (el.btnExitOver) {
        el.btnExitOver.addEventListener('click', function (e) {
          e.preventDefault();
          exitToMenu();
        });
      }
      if (el.btnMonkey) {
        el.btnMonkey.addEventListener('click', function (e) {
          e.preventDefault();
          try { el.btnMonkey.blur(); } catch (eB) {}
          activateMonkey();
        });
      }
      // Auto-pause when the tab/app goes to background (music kept playing and
      // the run silently resumed mid-obstacle when you came back).
      document.addEventListener('visibilitychange', function () {
        if (document.hidden && running && !paused && !dying && !gameOver) togglePause();
      });

      lastT = performance.now();
      initMusic();
      requestAnimationFrame(loop);
    } catch (err) {
      showErr('Ошибка инициализации: ' + (err && err.message ? err.message : err));
    }
  }

  function onResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  // --- lightweight procedural texture helpers (no network / asset files) ---
  var _glowTex = null;
  function glowTexture() {
    if (_glowTex) return _glowTex;
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.32)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    _glowTex = new THREE.CanvasTexture(c);
    return _glowTex;
  }

  // additive glow halo behind a pickup/powerup, cheap stand-in for real bloom.
  // Additive alpha SUMS when sprites overlap on screen (perspective packs
  // repeating tunnel decor close together), so opacity has to stay modest or
  // a handful of them stack into a solid white blob — which is exactly what
  // was happening with signs/portals/coins all using 0.85 opacity at once.
  function addGlow(parent, color, size, yOff, opacity) {
    var spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: color, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
      opacity: opacity != null ? Math.min(opacity, 0.16) : 0.16
    }));
    spr.scale.set(size, size, 1);
    spr.position.y = yOff || 0;
    parent.add(spr);
    return spr;
  }

  function makeGroundTexture() {
    var w = 128, h = 512;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#1c1c1f';
    ctx.fillRect(0, 0, w, h);
    // subtle plank/panel seams, kept away from the canvas edges so the
    // tile wraps seamlessly under THREE.RepeatWrapping
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (var s = 0; s < 4; s++) {
      var yy = (s + 0.5) * (h / 4);
      ctx.fillRect(0, yy - 2, w, 3);
    }
    // faint grime speckle for texture without breaking the tile
    for (var i = 0; i < 260; i++) {
      var px = Math.random() * w, py = Math.random() * h;
      var a = 0.03 + Math.random() * 0.05;
      ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
      ctx.fillRect(px, py, 1, 1);
    }
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(3, 46);
    return tex;
  }

    function buildSky() {
    // initial sky — applyStageTheme/rebuildSky swaps palette per stage
    rebuildSky(activeStage || 1);
  }

  function buildWorldScenery() {
    // Dense, repeatable side scenery: lamps, cables, service boxes, signs,
    // fences and layered city blocks. These modules actually move toward the
    // camera so the world reads as an endless runner, not a static corridor.
    var stage = activeStage || 1;
    var lampMat = mat(stage === 2 ? 0x2a1820 : 0x24272b, { roughness: 0.72, metalness: 0.45 });
    var neonGreen = stage === 2
      ? mat(0xff4f78, { emissive: 0xff2a6a, ei: 1.1, roughness: 0.28, metalness: 0.15 })
      : mat(0x5fc7ff, { emissive: 0x2b8cff, ei: 0.9, roughness: 0.28, metalness: 0.15 });
    var neonPink = stage === 2
      ? mat(0xffaa55, { emissive: 0xff6622, ei: 1.1, roughness: 0.25, metalness: 0.1 })
      : mat(0xff4f78, { emissive: 0xff174d, ei: 1.15, roughness: 0.25, metalness: 0.1 });
    var concrete = mat(stage === 2 ? 0x3a2028 : 0x30343a, { roughness: 0.95, metalness: 0.05 });
    var asphalt = mat(0x14171a, { roughness: 0.98, metalness: 0.02 });
    var steel = mat(0x58606a, { roughness: 0.4, metalness: 0.8 });
    var warm = mat(0xffd27a, { emissive: 0xffa82f, ei: 1.1, roughness: 0.25 });
    var geoPole = new THREE.CylinderGeometry(0.045, 0.07, 3.6, 8);
    var geoLamp = new THREE.SphereGeometry(0.11, 8, 8);
    var geoPoleTop = new THREE.CylinderGeometry(0.07, 0.07, 0.85, 8);
    var geoWall = new THREE.BoxGeometry(3.4, 4.5, 2.8);
    var geoTrim = new THREE.BoxGeometry(3.5, 0.12, 2.9);
    var geoRail = new THREE.BoxGeometry(0.08, 0.08, 8);
    var geoSleep = new THREE.BoxGeometry(5.6, 0.12, 0.24);
    var geoCable = new THREE.CylinderGeometry(0.025, 0.025, 8.5, 6);
    var geoSign = new THREE.BoxGeometry(1.25, 0.55, 0.08);

    var modCount = stage === 1 ? 36 : 28;
    var modSpan = stage === 1 ? 6.4 : 7.2;
    for (var i = 0; i < modCount; i++) {
      var z = -10 - i * modSpan;
      var module = new THREE.Group();
      module.userData.scenery = true;
      module.userData.recycleSeed = i;
      module.userData.wrapPeriod = modCount * modSpan;

      // Near-ground rail infrastructure / sleepers.
      for (var rr = -1; rr <= 1; rr += 2) {
        var rail = new THREE.Mesh(geoRail, steel);
        rail.rotation.y = Math.PI / 2;
        rail.position.set(rr * 2.2, 0.07, 0);
        module.add(rail);
      }
      var sleeper = new THREE.Mesh(geoSleep, steel);
      sleeper.position.y = 0.035;
      module.add(sleeper);

      for (var side = -1; side <= 1; side += 2) {
        // Stage 1 lamps closer so the metro corridor reads; stage 2 farther/hot
        var sx = side * ((stage === 2 ? 6.2 : 4.9) + (i % 3) * 0.2);
        var pole = new THREE.Mesh(geoPole, lampMat);
        pole.position.set(sx, 1.8, 0);
        module.add(pole);
        var arm = new THREE.Mesh(geoPoleTop, lampMat);
        arm.rotation.z = Math.PI / 2;
        arm.position.set(sx + side * 0.28, 3.38, 0);
        module.add(arm);
        var lampCol = (i + side) % 3 === 0 ? neonPink : warm;
        var lamp = new THREE.Mesh(geoLamp, lampCol);
        lamp.position.set(sx + side * 0.55, 3.34, 0);
        module.add(lamp);
        // denser glow on stage 1 (tunnel ambiance)
        if (stage === 1 || i % 2 === 0) {
          addGlow(module, stage === 2
            ? ((i + side) % 3 === 0 ? 0xff4f78 : 0xffc56e)
            : ((i + side) % 3 === 0 ? 0x66ccff : 0xffd090),
            stage === 1 ? 0.42 : 0.28, 3.28, stage === 1 ? 0.14 : 0.07);
        }

        // Mid-ground wall slab with light bands and service detail.
        var bw = 2.2 + ((i * 17) % 5) * 0.35;
        var bh = 4.5 + ((i * 29) % 7) * 0.45;
        var b = new THREE.Mesh(geoWall, concrete);
        b.scale.set(bw / 3.4, bh / 4.5, 1);
        b.position.set(side * (9 + (i % 2) * 1.4), bh * 0.5 - 0.05, 0);
        b.castShadow = true;
        module.add(b);
        var trim = new THREE.Mesh(geoTrim, (i % 4 === 0) ? steel : steel);
        trim.position.set(b.position.x, bh * 0.72, -1.43);
        trim.scale.x = bw / 3.5;
        module.add(trim);
        var vent = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.35, 0.08), steel);
        vent.position.set(b.position.x, 1.2 + (i % 3) * 0.5, side > 0 ? -1.46 : 1.46);
        module.add(vent);

        // Bright signs punctuate the tunnel and make route direction obvious.
        if (i % 5 === 0) {
          var sign = new THREE.Mesh(geoSign, i % 2 ? neonPink : new THREE.MeshStandardMaterial({color:0x5fc7ff, emissive:0x2b8cff, emissiveIntensity:0.9, roughness:0.28, metalness:0.15}));
          sign.position.set(side * 7.0, 2.55 + (i % 2) * 0.5, -0.8);
          sign.rotation.y = side > 0 ? -0.12 : 0.12;
          module.add(sign);
          addGlow(module, i % 2 ? 0xff4f78 : 0x65ff9a, 0.45, sign.position.y, 0.22);
        }
      }

      // Overhead utility cables give the horizon a strong perspective frame.
      // overhead cables only outside the lane corridor
      for (var cc = 0; cc < 2; cc++) {
        var cable = new THREE.Mesh(geoCable, steel);
        cable.rotation.x = Math.PI / 2;
        cable.position.set(cc ? -6.2 : 6.2, 6.4 + cc * 0.35, 0);
        module.add(cable);
      }

      // V12: closer-to-Subway-Surfers set dressing — portal frames, posters,
      // warning stripes, platform lights and recognizable station silhouettes.
      if (i % (stage === 1 ? 3 : 5) === 1) addStationPortal(module, 0, i % 2);
      for (var side3 = -1; side3 <= 1; side3 += 2) {
        if (i % 6 === 0) {
          var poster = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.65, 1.2), (i % 2) ? neonPink : new THREE.MeshStandardMaterial({color:0x5fc7ff, emissive:0x2b8cff, emissiveIntensity:0.9, roughness:0.28, metalness:0.15}));
          poster.position.set(side3 * 6.35, 2.15, -0.2);
          poster.rotation.y = side3 * 0.08;
          module.add(poster);
          addGlow(module, (i % 2) ? 0xff4f78 : 0x65ff9a, 0.4, 2.15, 0.22);
        }
        if (i % 3 === 1) addPlatformLights(module, side3, 0, 3.15, i % 2 ? 0xff4f78 : 0xffc56e, 3);
      }
      // side billboard accents (makeBillboard parents into sceneryGroup itself)
      if (i % 6 === 2 && typeof makeBillboard === 'function') {
        try {
          makeBillboard(
            stage === 2 ? 'MIND' : 'BBH',
            side3 * 7.2,
            3.4,
            -10 - (i % 4) * 3,
            side3 > 0 ? -0.35 : 0.35,
            stage === 2 ? '#ff6688' : '#7dffb0'
          );
        } catch (e) {}
      }
      // road arches over the tunnel (parented to scrolling module)
      if (i % 8 === 1) {
        try { addRoadArch(-6, 10.5, 4.4, null, module); } catch (e) {}
      }
      // extra vending / service boxes
      if (i % 4 === 0 && typeof addTracksideVending === 'function') {
        try {
          addTracksideVending(module, side3, -2.5, stage === 2 ? 0xff3366 : 0x44ddff);
        } catch (e) {}
      }

      sceneryGroup.add(module);
      sceneryPieces.push(module);
    }

    // static horizon tubes removed — they did not scroll and cluttered the view

  }

  function addNeonTube(parent, x, y, z, color, radius, length, rotZ) {
    var glowMat = mat(color, { emissive: color, ei: 1.6, roughness: 0.2, metalness: 0.1 });
    var geo = new THREE.CylinderGeometry(radius || 0.045, radius || 0.045, length || 1.6, 8);
    var m = new THREE.Mesh(geo, glowMat);
    m.position.set(x, y, z);
    if (rotZ != null) m.rotation.z = rotZ;
    parent.add(m);
    addGlow(parent, color, Math.max(0.18, (length || 1.6) * 0.22), y, 0.16);
    return m;
  }

  // Compact wall-mounted sconces inspired by the reference scene.
  // They sit on the side walls instead of on tall poles, giving the tunnel
  // a repeating warm rhythm without cluttering the playable lanes.
  function addWallSconce(parent, side, z, variant) {
    var metal = mat(0x1b2027, { metalness: 0.72, roughness: 0.34 });
    var housing = mat(0x2a3037, { metalness: 0.58, roughness: 0.38 });
    var glow = mat(variant ? 0xff668f : 0xffd7a0, {
      emissive: variant ? 0xff264f : 0xff7b24, ei: 2.0, roughness: 0.16
    });
    // A shallow wall panel makes the sconce visibly wall-mounted even in the open
    // tunnel sections. Kept just outside the playable corridor.
    var wall = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.55, 1.15), mat(0x171c24, { metalness:0.25, roughness:0.92 }));
    wall.position.set(side * 4.55, 2.55, z);
    parent.add(wall);

    var plate = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.34, 0.32), metal);
    plate.position.set(side * 4.43, 2.65, z);
    plate.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    parent.add(plate);

    var arm = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.10), housing);
    arm.position.set(side * 4.58, 2.65, z);
    arm.rotation.z = side > 0 ? -0.10 : 0.10;
    parent.add(arm);

    var cap = new THREE.Mesh(new THREE.CylinderGeometry(0.10, 0.13, 0.16, 10), housing);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(side * 4.76, 2.65, z);
    parent.add(cap);

    var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), glow);
    bulb.position.set(side * 4.84, 2.65, z);
    parent.add(bulb);
    addGlow(parent, variant ? 0xff4f78 : 0xffc77a, 0.42, 2.65, 0.10);

    // Soft fake wash — cheaper than a real dynamic point light.
    if (!variant) {
      var wash = new THREE.Mesh(
        new THREE.PlaneGeometry(0.95, 1.25),
        new THREE.MeshBasicMaterial({ color: 0xffc77a, transparent: true, opacity: 0.08, depthWrite:false })
      );
      wash.position.set(side * 4.47, 2.65, z - side * 0.015);
      wash.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      parent.add(wash);
    }
  }

  function addStreetLamp(parent, side, z, variant) {
    var metal = mat(0x1b2027, { metalness: 0.78, roughness: 0.3 });
    var warm = mat(variant ? 0xff7296 : 0xffd38b, { emissive: variant ? 0xff234e : 0xff6f1f, ei: 2.2, roughness: 0.18 });
    var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.09, 3.9, 8), metal);
    pole.position.set(side * 5.4, 1.95, z);
    pole.castShadow = true; parent.add(pole);
    var arm = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.07, 0.07), metal);
    arm.position.set(side * 5.7, 3.72, z); parent.add(arm);
    var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), warm);
    bulb.position.set(side * 6.0, 3.69, z); parent.add(bulb);
    addGlow(parent, variant ? 0xff4f78 : 0xffc06f, 0.46, 3.69, 0.10);
  }

  function addOverheadSign() { /* disabled — blocked camera */ }
  function addTracksideVending(parent, side, z, color) {
    var body = mat(0x222a31, { metalness: 0.45, roughness: 0.42 });
    var accent = mat(color, { emissive: color, ei: 0.9, roughness: 0.25 });
    var box = new THREE.Mesh(new THREE.BoxGeometry(0.65, 1.35, 0.42), body);
    box.position.set(side * 4.1, 0.68, z); parent.add(box);
    var panel = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.72, 0.04), accent);
    panel.position.set(side * 4.1, 0.72, z - 0.22); parent.add(panel);
    var feet = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.45), body);
    feet.position.set(side * 4.1, 0.04, z); parent.add(feet);
  }

  function buildCinematicScenery() {
    var g = new THREE.Group();
    // Large scenery collection: recycle each top-level prop independently so
    // the whole background cannot vanish in one frame when the parent wraps.
    g.userData.segmentedScenery = true;
    g.userData.scenery = true;
    var violet = 0xa56dff, cyan = 0x63ddff, pink = 0xff5c9a;
    for (var i = 0; i < 18; i++) {
      var z = -8 - i * 11.5;
      addStreetLamp(g, -1, z, i % 5 === 0 ? 1 : 0);
      addStreetLamp(g, 1, z + 4.8, i % 4 === 0 ? 1 : 0);
      // Wall sconces: frequent enough to create the same left/right rhythm
      // as the reference, but offset so both sides do not form a rigid pair.
      addWallSconce(g, -1, z + 2.2, i % 6 === 0 ? 1 : 0);
      addWallSconce(g, 1, z + 6.8, i % 7 === 0 ? 1 : 0);
      // overhead signs removed (blocked forward view)
      if (i % 3 === 0) addTracksideVending(g, -1, z + 1.2, pink);
      if (i % 3 === 1) addTracksideVending(g, 1, z + 2.2, cyan);
      if (i % 2 === 0) {
        addNeonTube(g, -3.9, 0.28, z, violet, 0.028, 3.2, Math.PI / 2);
        addNeonTube(g, 3.9, 0.28, z + 0.7, cyan, 0.028, 2.8, Math.PI / 2);
      }
    }
    sceneryGroup.add(g);
    sceneryPieces.push(g);
  }

  function buildPremiumEnvironment() {
    // Hero dressing: a few large, readable landmarks instead of noisy micro-props.
    var g = new THREE.Group();
    g.userData.scenery = true;
    g.userData.segmentedScenery = true;

    var dark = mat(0x101521, { roughness: 0.92, metalness: 0.08 });
    var dark2 = mat(0x171d2a, { roughness: 0.86, metalness: 0.12 });
    var steel = mat(0x5d6675, { roughness: 0.34, metalness: 0.82 });
    var cyan = mat(0x63ddff, { emissive: 0x1f8fb9, ei: 1.2, roughness: 0.2, metalness: 0.15 });
    var pink = mat(0xff5c98, { emissive: 0xc62a6b, ei: 1.25, roughness: 0.22 });
    var warm = mat(0xffd07a, { emissive: 0xff8e2d, ei: 1.0, roughness: 0.23 });

    // Tall side towers create a recognizable skyline silhouette.
    [-1, 1].forEach(function(side) {
      for (var i = 0; i < 4; i++) {
        var w = 2.8 + i * 0.55;
        var h = 8 + (i % 2) * 5;
        var z = -34 - i * 16 - (side > 0 ? 6 : 0);
        var tower = new THREE.Group();
        tower.position.set(side * (7.8 + (i % 2) * 1.3), h * 0.5 - 0.3, z);
        var body = new THREE.Mesh(new THREE.BoxGeometry(w, h, w * 0.72), (i % 2) ? dark2 : dark);
        body.castShadow = true; tower.add(body);
        for (var r = 0; r < 3; r++) {
          var band = new THREE.Mesh(new THREE.BoxGeometry(w * 0.72, 0.12, 0.05), r % 2 ? cyan : pink);
          band.position.set(0, -h * 0.18 + r * h * 0.22, -w * 0.37 - 0.03);
          tower.add(band);
        }
        for (var wi = 0; wi < 4; wi++) {
          var win = new THREE.Mesh(new THREE.BoxGeometry(w * 0.12, h * 0.06, 0.035), (wi % 3 === 0) ? warm : cyan);
          win.position.set(-w * 0.23 + wi * w * 0.15, h * 0.18 + (wi % 2) * 0.42, -w * 0.37 - 0.035);
          tower.add(win);
        }
        g.add(tower);
      }
    });

        // center overhead bridge removed (blocked forward camera)

    // Distant billboard silhouettes, intentionally sparse.
    [-1, 1].forEach(function(side){
      var board = new THREE.Group();
      board.position.set(side * 8.4, 4.4, -58 - side * 5);
      var frame = new THREE.Mesh(new THREE.BoxGeometry(3.0, 1.55, 0.12), steel);
      board.add(frame);
      var face = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 1.25), new THREE.MeshBasicMaterial({ color: side < 0 ? 0x5f83ff : 0xff4f91, transparent:true, opacity:0.78 }));
      face.position.z = -0.08; board.add(face);
      var top = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.06, 0.08), side < 0 ? cyan : pink);
      top.position.y = 0.78; board.add(top);
      g.add(board);
    });

    sceneryGroup.add(g);
    sceneryPieces.push(g);
  }

  function buildTrackHeroDetails() {
    // Make the playable floor read as a real rail corridor, not a gray plane.
    var railMat = mat(0x5e6877, { metalness: 0.9, roughness: 0.22 });
    var railDark = mat(0x272d37, { metalness: 0.72, roughness: 0.34 });
    var tieMat = mat(0x20252d, { metalness: 0.2, roughness: 0.88 });
    var lightMat = mat(0xffc978, { emissive: 0xff8a22, ei: 0.7, roughness: 0.25 });

    // Six rails: two per lane, subtly inset so they do not interfere with collision.
    [-2.2, 0, 2.2].forEach(function(cx){
      [-0.48, 0.48].forEach(function(off){
        var rail = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.10, 200), railMat);
        rail.position.set(cx + off, 0.065, -60); trackGroup.add(rail);
      });
    });
    for (var i = 0; i < 38; i++) {
      var z = -4 - i * 5.2;
      var tie = new THREE.Mesh(new THREE.BoxGeometry(7.0, 0.10, 0.28), tieMat);
      tie.position.set(0, 0.055, z); trackGroup.add(tie);
      trackScroll.push({ m: tie, p: 38 * 5.2 });
      if (i % 3 === 0) {
        [-3.28, 3.28].forEach(function(x){
          var marker = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.06), lightMat);
          marker.position.set(x, 0.16, z); trackGroup.add(marker);
          trackScroll.push({ m: marker, p: 13 * 3 * 5.2 });
        });
      }
    }

    // Small reflective shoulder strips to add speed lines without neon clutter.
    var shoulder = mat(0x37404c, { metalness: 0.74, roughness: 0.3, emissive: 0x0f1420, ei: 0.2 });
    [-3.38, 3.38].forEach(function(x){
      var s = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.09, 200), shoulder);
      s.position.set(x, 0.10, -60); trackGroup.add(s);
    });
  }

  function buildVisualPolish() {
    // Hero-quality dressing: concentrated details, reflective surfaces and
    // readable landmarks without returning to the old cluttered neon forest.
    var g = new THREE.Group(); g.userData.scenery = true; g.userData.segmentedScenery = true;
    var steel = mat(0x4b5564,{metalness:.86,roughness:.27});
    var dark = mat(0x111721,{metalness:.35,roughness:.62});
    var cyan = mat(0x63c3da,{emissive:0x14566c,ei:.72,roughness:.23});
    var warm = mat(0xffc56d,{emissive:0xff7d1b,ei:1.45,roughness:.2});
    var pink = mat(0xff5b9a,{emissive:0x8e214f,ei:.82,roughness:.24});

    // Repeated overhead catenary portals, spaced generously so they frame the
    // route instead of filling it.
    for (var i=0;i<8;i++) {
      var z=-10-i*23;
      var portal=new THREE.Group(); portal.position.z=z;
      [-4.15,4.15].forEach(function(x){
        var leg=new THREE.Mesh(new THREE.BoxGeometry(.16,5.4,.18),steel);
        leg.position.set(x,2.7,0); leg.castShadow=true; portal.add(leg);
      });
      var top=new THREE.Mesh(new THREE.BoxGeometry(8.6,.18,.2),steel); top.position.y=5.25; portal.add(top);
      var wire=new THREE.Mesh(new THREE.BoxGeometry(5.8,.035,.035),cyan); wire.position.set(0,4.7,0); portal.add(wire);
      g.add(portal);
    }

    // Platform-edge emergency boxes and lamps: a small amount of real-world
    // scale helps sell the station while keeping the lane space clean.
    for (var j=0;j<10;j++) {
      var zz=-12-j*16;
      for (var side=-1; side<=1; side+=2) {
        var b=new THREE.Mesh(new THREE.BoxGeometry(.55,1.05,.42),dark);
        b.position.set(side*4.1,.55,zz+(side>0?2.2:0)); b.castShadow=true; g.add(b);
        var lamp=new THREE.Mesh(new THREE.SphereGeometry(.08,8,8), warm);
        lamp.position.set(side*4.1,.99,zz+(side>0?2.2:0)); g.add(lamp);
      }
    }

    // Wet track highlights: only in broad protected strips, no gameplay change.
    for (var k=0;k<24;k++) {
      var lane=(k%3)-1; var z2=-6-k*7.8;
      addWetPatch(g,lane*2.2+((k%2)?0.24:-0.24),0.016,z2,1.1+(k%3)*.35,1.7,.10+(k%3)*.025);
    }

    // A few high-value facade panels create depth and a recognisable art theme.
    for (var f=0; f<6; f++) {
      var side=f%2?-1:1, z3=-22-f*18;
      var panel=new THREE.Mesh(new THREE.BoxGeometry(.12,2.0,2.7),dark);
      panel.position.set(side*4.72,2.2,z3); g.add(panel);
      var tex=panelTexture(f%2?'NIGHT RUN':'GLEB RUN','#111926',f%2?'#63ddff':'#ff6a9f');
      var face=new THREE.Mesh(new THREE.PlaneGeometry(2.45,1.62),new THREE.MeshBasicMaterial({map:tex,transparent:true,opacity:.82}));
      face.rotation.y=side>0?Math.PI/2:-Math.PI/2; face.position.set(side*4.79,2.2,z3); g.add(face);
    }

    sceneryGroup.add(g); sceneryPieces.push(g);
  }

  function buildRain() {
    var geo = new THREE.BufferGeometry();
    var p = new Float32Array(rainCount * 6);
    for (var i = 0; i < rainCount; i++) {
      var x = (Math.random() - 0.5) * 16;
      var y0 = 1.5 + Math.random() * 7.5;
      var z = -Math.random() * 95;
      var len = 0.16 + Math.random() * 0.34;
      p[i*6] = x; p[i*6+1] = y0; p[i*6+2] = z;
      p[i*6+3] = x + 0.05; p[i*6+4] = y0 - len; p[i*6+5] = z + 0.2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    var matl = new THREE.LineBasicMaterial({ color: 0x90a8c0, transparent: true, opacity: 0.18 });
    rainPoints = new THREE.LineSegments(geo, matl);
    scene.add(rainPoints);
  }

  function buildDust() {
    var geo = new THREE.BufferGeometry();
    var pos = new Float32Array(dustCount * 3);
    for (var i = 0; i < dustCount; i++) {
      // bias to sides — avoid a glowing blob in the middle of the path
      var side = Math.random() < 0.5 ? -1 : 1;
      pos[i * 3] = side * (2.8 + Math.random() * 4.5);
      pos[i * 3 + 1] = 0.2 + Math.random() * 5.5;
      pos[i * 3 + 2] = -Math.random() * 85;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    var mtl = new THREE.PointsMaterial({
      size: 0.05, map: glowTexture(), color: 0xc8b090, transparent: true,
      opacity: 0.22, blending: THREE.NormalBlending, depthWrite: false, sizeAttenuation: true
    });
    dustPoints = new THREE.Points(geo, mtl);
    scene.add(dustPoints);
  }

  function buildTrack() {
    groundTex = makeGroundTexture();
    var ground = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 200),
      new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95, metalness: 0.05 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, -60);
    ground.receiveShadow = true;
    trackGroup.add(ground);

    [-1.1, 1.1].forEach(function (x) {
      var line = new THREE.Mesh(
        new THREE.PlaneGeometry(0.08, 200),
        mat(0x4b5058, { emissive: 0x101318, ei: 0.08 })
      );
      line.rotation.x = -Math.PI / 2;
      line.position.set(x, 0.01, -60);
      trackGroup.add(line);
      laneLines.push(line);
    });

    [-1, 1].forEach(function (side) {
      var wall = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 6, 200),
        mat(0x121214, { roughness: 0.9 })
      );
      wall.position.set(side * 5.2, 3, -60);
      wall.receiveShadow = true;
      trackGroup.add(wall);
      // Subtle wall service conduits: sparse and neutral so they don't read as
      // random green sticks competing with the playable route.
      for (var i = 0; i < 6; i++) {
        var pipe = new THREE.Mesh(
          new THREE.CylinderGeometry(0.075, 0.075, 2.8, 8),
          mat(0x343a44, { metalness: 0.72, roughness: 0.42 })
        );
        pipe.rotation.z = Math.PI / 2;
        pipe.position.set(side * 4.56, 1.15 + (i % 2) * 0.95, -18 - i * 28);
        trackGroup.add(pipe);
        trackScroll.push({ m: pipe, p: 6 * 28 });
      }
    });

    for (var i = 0; i < 16; i++) {
      var beam = new THREE.Mesh(new THREE.BoxGeometry(12, 0.35, 0.5), mat(0x0e0e10));
      beam.position.set(0, 6.45, -i * 12);
      trackGroup.add(beam);
    }

    // reflective safety strips and ballast blocks for stronger depth cues
    var edgeMat = mat(0x4b5870, { metalness: 0.75, roughness: 0.28, emissive: 0x111629, ei: 0.35 });
    var edgeGlow = mat(0x69e7ff, { emissive: 0x56cfff, ei: 1.0, roughness: 0.25 });
    [-1,1].forEach(function(side){
      var edge = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 200), edgeMat);
      edge.position.set(side * 3.35, 0.06, -60); trackGroup.add(edge);
      for (var ei = 0; ei < 32; ei++) {
        var marker = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.045, 0.18), edgeGlow);
        marker.position.set(side * 3.35, 0.08, -3 - ei * 6); trackGroup.add(marker);
        trackScroll.push({ m: marker, p: 32 * 6 });
      }
    });
  }

  
  function attachPowerGear(g) {
    // Jetpack on the back
    var jet = new THREE.Group();
    jet.position.set(0, 1.15, -0.42);
    var tankL = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.55, 8), mat(0x4a5568, { metalness: 0.7, roughness: 0.35 }));
    tankL.position.set(-0.16, 0, 0); jet.add(tankL);
    var tankR = tankL.clone(); tankR.position.x = 0.16; jet.add(tankR);
    var strap = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.06), mat(0x222228));
    strap.position.set(0, 0.15, 0.12); jet.add(strap);
    var nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.2, 8), mat(0x333340, { metalness: 0.6, roughness: 0.4 }));
    nozzle.position.set(0, -0.35, 0); jet.add(nozzle);
    var flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.14, 0.45, 8),
      mat(0x66ccff, { emissive: 0x2288ff, ei: 1.5, roughness: 0.3 })
    );
    flame.rotation.x = Math.PI; flame.position.set(0, -0.6, 0); jet.add(flame);
    var flame2 = new THREE.Mesh(
      new THREE.ConeGeometry(0.08, 0.28, 6),
      mat(0xffeeaa, { emissive: 0xffaa44, ei: 2.0, roughness: 0.2 })
    );
    flame2.rotation.x = Math.PI; flame2.position.set(0, -0.55, 0); jet.add(flame2);
    jet.visible = false;
    g.add(jet);
    g.userData.jetpack = jet;
    g.userData.jetFlame = flame;
    g.userData.jetFlame2 = flame2;

    // Magnet: orbiting cyan rings
    var mag = new THREE.Group();
    for (var i = 0; i < 3; i++) {
      var ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.7 + i * 0.15, 0.03, 6, 20),
        mat(0x44ffaa, { emissive: 0x22cc88, ei: 1.2, roughness: 0.3 })
      );
      ring.rotation.x = Math.PI / 2 + i * 0.3;
      ring.rotation.y = i * 0.5;
      mag.add(ring);
    }
    mag.position.set(0, 1.1, 0);
    mag.visible = false;
    g.add(mag);
    g.userData.magnetFx = mag;

    // Jump boots glow
    var boots = new THREE.Group();
    [-0.2, 0.2].forEach(function(x) {
      var b = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.12, 0.32),
        mat(0xff66aa, { emissive: 0xff2288, ei: 0.9, roughness: 0.35 })
      );
      b.position.set(x, 0.06, 0.05);
      boots.add(b);
    });
    boots.visible = false;
    g.add(boots);
    g.userData.jumpBoots = boots;

    // x2 golden aura disc
    var aura = new THREE.Mesh(
      new THREE.TorusGeometry(0.85, 0.05, 6, 24),
      mat(0xffd700, { emissive: 0xffaa00, ei: 1.3, roughness: 0.25 })
    );
    aura.rotation.x = Math.PI / 2;
    aura.position.y = 0.15;
    aura.visible = false;
    g.add(aura);
    g.userData.x2Aura = aura;
  }

  function buildGleb() {
    // Green furry cat — low-poly stylized
    var g = new THREE.Group();
    var fur = mat(0x3ecf6a, { roughness: 0.85, emissive: 0x0a2a12, ei: 0.12 });
    var furDark = mat(0x2a9a4a, { roughness: 0.9 });
    var belly = mat(0xa8e8b8, { roughness: 0.8 });
    var pink = mat(0xff9ab0, { roughness: 0.6 });
    var eyeWhite = mat(0xf5fff5);
    var eyePupil = mat(0x101810, { roughness: 0.4 });
    var eyeShine = mat(0xb6ffc8, { emissive: 0x66ff99, ei: 0.35 });

    // torso
    var torso = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.85, 0.5), fur);
    torso.position.y = 1.15;
    torso.castShadow = true;
    g.add(torso);
    // belly patch
    var bel = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.55, 0.12), belly);
    bel.position.set(0, 1.05, 0.28);
    g.add(bel);

    // head (slightly cat-proportion)
    var head = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.55, 0.58), fur);
    head.position.y = 1.92;
    head.castShadow = true;
    g.add(head);
    // snout
    var snout = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.22, 0.28), belly);
    snout.position.set(0, 1.78, 0.38);
    g.add(snout);
    // nose
    var nose = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.08), pink);
    nose.position.set(0, 1.82, 0.52);
    g.add(nose);

    // visor rim gives the face a cleaner silhouette at speed
    var visor = new THREE.Mesh(new THREE.BoxGeometry(0.44,0.10,0.05), eyeShine);
    visor.position.set(0,2.08,0.335); g.add(visor);
    var chin = new THREE.Mesh(new THREE.BoxGeometry(0.28,0.10,0.16), belly);
    chin.position.set(0,1.70,0.29); g.add(chin);

    // ears
    var earL = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.32, 4), fur);
    earL.position.set(-0.22, 2.28, 0);
    earL.rotation.z = 0.25;
    var earR = earL.clone();
    earR.position.x = 0.22;
    earR.rotation.z = -0.25;
    g.add(earL, earR);
    var earInL = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.18, 4), pink);
    earInL.position.set(-0.22, 2.22, 0.04);
    earInL.rotation.z = 0.25;
    var earInR = earInL.clone();
    earInR.position.x = 0.22;
    earInR.rotation.z = -0.25;
    g.add(earInL, earInR);

    // eyes
    var ew1 = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.06), eyeWhite);
    ew1.position.set(-0.15, 1.98, 0.3);
    var ew2 = ew1.clone();
    ew2.position.x = 0.15;
    g.add(ew1, ew2);
    var p1 = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.14, 0.05), eyePupil);
    p1.position.set(-0.15, 1.98, 0.34);
    var p2 = p1.clone();
    p2.position.x = 0.15;
    g.add(p1, p2);

    // cheeks fluff
    var ch1 = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.14, 0.14), furDark);
    ch1.position.set(-0.36, 1.82, 0.15);
    var ch2 = ch1.clone();
    ch2.position.x = 0.36;
    g.add(ch1, ch2);

    // arms as cascade bones: shoulder → upper → forearm → paw
    function makeArm(side) {
      // side: -1 left, +1 right
      var root = new THREE.Group();
      root.position.set(side * 0.42, 1.45, 0);

      var upper = new THREE.Group();
      var upperMesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.42, 0.22), fur);
      upperMesh.position.y = -0.2;
      upperMesh.castShadow = true;
      upper.add(upperMesh);
      root.add(upper);

      var fore = new THREE.Group();
      fore.position.y = -0.42;
      var foreMesh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.36, 0.2), furDark);
      foreMesh.position.y = -0.16;
      foreMesh.castShadow = true;
      fore.add(foreMesh);
      upper.add(fore);

      var paw = new THREE.Group();
      paw.position.y = -0.36;
      var pawMesh = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.26), fur);
      pawMesh.position.set(0, -0.04, 0.04);
      paw.add(pawMesh);
      // toe nubs
      for (var ti = -1; ti <= 1; ti++) {
        var toe = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.1), furDark);
        toe.position.set(ti * 0.07, -0.06, 0.14);
        paw.add(toe);
      }
      fore.add(paw);

      // slight rest hang
      upper.rotation.x = 0.25;
      upper.rotation.z = side * 0.12;
      fore.rotation.x = 0.2;

      return { root: root, upper: upper, fore: fore, paw: paw };
    }
    var armL = makeArm(-1);
    var armR = makeArm(1);
    g.add(armL.root, armR.root);

    // legs
    var l1 = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.65, 0.3), furDark);
    l1.position.set(-0.2, 0.38, 0);
    l1.castShadow = true;
    var l2 = l1.clone();
    l2.position.x = 0.2;
    g.add(l1, l2);
    // feet parented to legs → cascade with leg rotation
    var f1 = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.36), fur);
    f1.position.set(0, -0.32, 0.06);
    l1.add(f1);
    var f2 = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.12, 0.36), fur);
    f2.position.set(0, -0.32, 0.06);
    l2.add(f2);

    // tail as bone chain (root → mid → tip): each child inherits parent rotation
    var tailBones = [];
    var tailRoot = new THREE.Group();
    tailRoot.position.set(0, 1.05, -0.28);
    g.add(tailRoot);
    var segLens = [0.32, 0.3, 0.28];
    var segRads = [0.09, 0.07, 0.055];
    var parent = tailRoot;
    for (var si = 0; si < 3; si++) {
      var bone = new THREE.Group();
      // offset along local -Z / down-back so chain extends behind
      if (si === 0) bone.position.set(0, 0, 0);
      else bone.position.set(0, -segLens[si - 1] * 0.15, -segLens[si - 1] * 0.85);
      var mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(segRads[si], segRads[Math.min(si + 1, 2)] * 0.9, segLens[si], 6),
        si === 2 ? furDark : fur
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = -segLens[si] * 0.5;
      mesh.castShadow = true;
      bone.add(mesh);
      parent.add(bone);
      tailBones.push(bone);
      parent = bone;
    }
    // tip bobble on last bone
    var tailTip = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 6), furDark);
    tailTip.position.set(0, 0, -segLens[2] - 0.02);
    tailBones[2].add(tailTip);

    // rest curl of the chain
    tailBones[0].rotation.x = 0.55;
    tailBones[1].rotation.x = 0.35;
    tailBones[2].rotation.x = 0.25;

    g.userData.legs = [l1, l2];
    g.userData.feet = [f1, f2];
    g.userData.torso = torso;
    g.userData.tailBones = tailBones;
    g.userData.tailTip = tailTip;
    g.userData.arms = [armL, armR]; // {root, upper, fore, paw}
    g.userData.feetBaseRot = [0, 0];

    // NSFW: green hose on FRONT — short enough to rest ON the floor, not through it
    var junkRoot = new THREE.Group();
    junkRoot.position.set(0, 0.48, 0.32);
    g.add(junkRoot);
    var skinJunk = mat(0x3ecf6a, { roughness: 0.75, emissive: 0x0a2a12, ei: 0.12 });
    var skinJunkDark = mat(0x2a9a4a, { roughness: 0.8 });
    var skinTip = mat(0x4ae078, { roughness: 0.55, emissive: 0x1a5020, ei: 0.2 });
    var ballL = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), skinJunkDark);
    ballL.position.set(-0.12, -0.02, 0.02);
    ballL.scale.set(1.05, 0.88, 1.05);
    var ballR = ballL.clone();
    ballR.position.x = 0.12;
    junkRoot.add(ballL, ballR);
    // 3 segments: drop to floor, then drag forward along the ground
    var shaftBones = [];
    var sParent = junkRoot;
    // total drop ~0.42 so tip sits ~y=0.06 in rest pose
    var shaftLens = [0.22, 0.28, 0.32];
    var shaftRads = [0.11, 0.095, 0.08];
    for (var ssi = 0; ssi < shaftLens.length; ssi++) {
      var sb = new THREE.Group();
      if (ssi === 0) sb.position.set(0, -0.06, 0.02);
      else sb.position.set(0, -shaftLens[ssi - 1] * 0.95, shaftLens[ssi - 1] * 0.08);
      var sm = new THREE.Mesh(
        new THREE.CylinderGeometry(
          shaftRads[ssi],
          shaftRads[Math.min(ssi + 1, shaftRads.length - 1)] * 0.9,
          shaftLens[ssi],
          8
        ),
        ssi === shaftLens.length - 1 ? skinTip : skinJunk
      );
      sm.position.y = -shaftLens[ssi] * 0.5;
      sm.castShadow = true;
      sb.add(sm);
      sParent.add(sb);
      shaftBones.push(sb);
      sParent = sb;
    }
    var tip = new THREE.Mesh(new THREE.SphereGeometry(0.095, 8, 8), skinTip);
    tip.position.set(0, -shaftLens[shaftLens.length - 1] - 0.03, 0.02);
    shaftBones[shaftBones.length - 1].add(tip);
    // rest: first segment down, rest flatten forward along ground
    shaftBones[0].rotation.x = 0.15;
    shaftBones[1].rotation.x = 0.55;
    shaftBones[2].rotation.x = 0.75;
    g.userData.junkRoot = junkRoot;
    g.userData.shaftBones = shaftBones;
    g.userData.shaftTip = tip;
    g.userData.balls = [ballL, ballR];
    g.userData.head = head;

    // Hoverboard mesh — the 'board' powerup only ever showed as a small
    // upward foot offset with nothing rendered under it. In Subway
    // Surfers the board is one of the most recognizable powerup reads
    // (a glowing plate under your feet); give it the same here so
    // "БОРД" active is obvious at a glance, not just inferred from the
    // HUD chip. Hidden by default, toggled with boardActive in update().
    var board = new THREE.Group();
    var boardDeck = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.07, 1.15),
      mat(0xcc88ff, { emissive: 0x8844cc, ei: 0.6, metalness: 0.4, roughness: 0.3 })
    );
    board.add(boardDeck);
    var boardTrim = new THREE.Mesh(
      new THREE.BoxGeometry(0.68, 0.02, 1.22),
      mat(0xaa66ff, { emissive: 0xaa66ff, ei: 1.2 })
    );
    boardTrim.position.y = -0.045;
    board.add(boardTrim);
    board.position.set(0, -0.06, 0.05);
    board.visible = false;
    g.add(board);
    g.userData.board = board;
    attachPowerGear(g);

    g.position.set(0, 0, 2);
    // лицом в туннель (−Z), спиной к камере — как в Subway Surfers
    g.rotation.y = Math.PI;
    return g;
  }

  function buildMinder() {
    // Clean hierarchy: pelvis owns legs+butt; torso owns arms; head on root.
    // Bind pose: feet on y≈0, no floating joints.
    var g = new THREE.Group();
    var white = mat(0xf2f2f4, { roughness: 0.42 });
    var black = mat(0x0e0e12, { roughness: 0.65 });
    var red = mat(0xe01424, { roughness: 0.35, emissive: 0x880010, ei: 0.55 });
    var redDeep = mat(0x7a0810, { roughness: 0.45, emissive: 0x400008, ei: 0.3 });
    var soft = mat(0xf0e6e8, { roughness: 0.55 });
    var tooth = mat(0xffffff, { roughness: 0.3 });

    // --- PELVIS (leg root) ---
    var pelvis = new THREE.Group();
    pelvis.position.set(0, 0.92, 0);
    var hipsMesh = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.28, 0.32), black);
    pelvis.add(hipsMesh);
    var butt = new THREE.Group();
    butt.position.set(0, 0.02, -0.22);
    var cheekL = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10), soft);
    cheekL.scale.set(1.05, 0.95, 1.15);
    cheekL.position.set(-0.16, 0, 0);
    var cheekR = cheekL.clone();
    cheekR.position.x = 0.16;
    butt.add(cheekL); butt.add(cheekR);
    pelvis.add(butt);

    function makeLeg(side) {
      var hip = new THREE.Group();
      hip.position.set(side * 0.14, 0, 0);
      hip.add(new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), black));
      // leg = 0.44 thigh + 0.46 shin/foot so the soles actually reach the floor
      // (hip is 0.92 up; the old 0.4+0.44 left the feet hovering ~8 cm above ground)
      var thigh = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.44, 0.16), black);
      thigh.position.y = -0.22;
      hip.add(thigh);
      var knee = new THREE.Group();
      knee.position.y = -0.44;
      hip.add(knee);
      knee.add(new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), black));
      var shin = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.4, 0.14), black);
      shin.position.y = -0.2;
      knee.add(shin);
      var foot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.26), white);
      foot.position.set(0, -0.42, 0.06);
      knee.add(foot);
      return { hip: hip, knee: knee };
    }
    var legL = makeLeg(-1), legR = makeLeg(1);
    pelvis.add(legL.hip); pelvis.add(legR.hip);
    g.add(pelvis);

    // --- TORSO ---
    var torso = new THREE.Group();
    torso.position.set(0, 1.28, 0);
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.7, 0.3), white);
    torso.add(body);
    var outline = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.76, 0.22), black);
    outline.position.z = -0.06;
    torso.add(outline);
    var emblem = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.06), red);
    emblem.position.set(0, 0.12, 0.16);
    torso.add(emblem);

    function makeArm(side) {
      var shoulder = new THREE.Group();
      shoulder.position.set(side * 0.34, 0.28, 0);
      shoulder.add(new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), black));
      var upper = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), black);
      upper.position.y = -0.17;
      shoulder.add(upper);
      var elbow = new THREE.Group();
      elbow.position.y = -0.34;
      shoulder.add(elbow);
      var fore = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.3, 0.1), black);
      fore.position.y = -0.15;
      elbow.add(fore);
      var hand = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.12), white);
      hand.position.y = -0.32;
      elbow.add(hand);
      return { shoulder: shoulder, elbow: elbow };
    }
    var armL = makeArm(-1), armR = makeArm(1);
    torso.add(armL.shoulder); torso.add(armR.shoulder);
    g.add(torso);

    // --- HEAD (pixel-art style: white disc, red eyes/mouth, black outline) ---
    var head = new THREE.Group();
    head.position.set(0, 1.88, 0);
    var headOutline = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.1, 24), black);
    headOutline.rotation.x = Math.PI / 2;
    headOutline.position.z = -0.02;
    head.add(headOutline);
    var face = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.12, 24), white);
    face.rotation.x = Math.PI / 2;
    head.add(face);
    // Front face bulge. The sphere cap has its pole on +Y, so it must be turned to
    // point along +Z (the face direction) — unrotated it stuck out of the top/back
    // of the head and left the mouth + teeth floating in mid-air.
    var dome = new THREE.Mesh(new THREE.SphereGeometry(0.4, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55), white);
    dome.rotation.x = Math.PI / 2;
    dome.position.z = 0.02;
    head.add(dome);
    // Back of the head (the camera only ever sees this side while running):
    // a shallow rear dome so the head isn't a paper-thin disc from behind.
    var rearDome = new THREE.Mesh(new THREE.SphereGeometry(0.42, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), white);
    rearDome.rotation.x = -Math.PI / 2;
    rearDome.scale.set(1, 0.7, 1);
    rearDome.position.z = -0.06;
    head.add(rearDome);
    [-0.14, 0.14].forEach(function (x) {
      var eo = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.05), black);
      eo.position.set(x, 0.08, 0.42); head.add(eo);
      var ep = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.05), red);
      ep.position.set(x, 0.08, 0.45); head.add(ep);
    });
    var mouthO = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.05), black);
    mouthO.position.set(0, -0.14, 0.42); head.add(mouthO);
    var mouthI = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.05), redDeep);
    mouthI.position.set(0, -0.14, 0.45); head.add(mouthI);
    var teeth = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.05), tooth);
    teeth.position.set(0, -0.1, 0.46); head.add(teeth);
    g.add(head);

    var board = new THREE.Group();
    board.add(new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.07, 1.15),
      mat(0xff4466, { emissive: 0xaa2233, ei: 0.5, metalness: 0.4, roughness: 0.3 })
    ));
    board.position.set(0, 0.02, 0.05);
    board.visible = false;
    g.add(board);

    g.userData.head = head;
    g.userData.torso = torso;
    g.userData.pelvis = pelvis;
    g.userData.hips = hipsMesh;
    g.userData.butt = butt;
    g.userData.buttCheeks = [cheekL, cheekR];
    g.userData.legData = [legL, legR];
    g.userData.armData = [armL, armR];
    g.userData.legs = [legL.hip, legR.hip];
    g.userData.arms = [
      { upper: armL.shoulder, fore: armL.elbow, paw: armL.elbow },
      { upper: armR.shoulder, fore: armR.elbow, paw: armR.elbow }
    ];
    g.userData.board = board;
    g.userData.junkRoot = null;
    g.userData.shaftBones = null;
    g.userData.isMinder = true;
    g.userData.buttJiggle = 0;
    attachPowerGear(g);
    g.position.set(0, 0, 2);
    g.rotation.y = Math.PI;
    return g;
  }
















  function buildBuddy() {
    // Black humanoid, red eyes, no horns — Buddy Horror
    var b = new THREE.Group();
    var skin = mat(0x0a0a0c, { roughness: 0.75, emissive: 0x1a0000, ei: 0.18 });
    var skinDeep = mat(0x050506, { roughness: 0.85, emissive: 0x100000, ei: 0.1 });
    var coat = mat(0x111114, { roughness: 0.7, metalness: 0.05 });
    var eye = mat(0xff1a1a, { emissive: 0xff0000, ei: 1.4, roughness: 0.25 });
    var eyeCore = mat(0xff6666, { emissive: 0xff2222, ei: 1.8, roughness: 0.2 });

    var legL = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.95, 0.36), skinDeep);
    legL.position.set(-0.28, 0.48, 0);
    var legR = legL.clone();
    legR.position.x = 0.28;
    b.add(legL, legR);
    var bootL = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.2, 0.48), coat);
    bootL.position.set(-0.28, 0.1, 0.06);
    var bootR = bootL.clone();
    bootR.position.x = 0.28;
    b.add(bootL, bootR);

    var body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.35, 0.55), coat);
    body.position.y = 1.45;
    body.castShadow = true;
    b.add(body);
    var chest = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.7, 0.2), skin);
    chest.position.set(0, 1.55, 0.28);
    b.add(chest);

    var armL = new THREE.Mesh(new THREE.BoxGeometry(0.26, 1.05, 0.28), coat);
    armL.position.set(-0.62, 1.35, 0);
    var armR = armL.clone();
    armR.position.x = 0.62;
    b.add(armL, armR);
    var handL = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), skin);
    handL.position.set(-0.62, 0.78, 0.05);
    var handR = handL.clone();
    handR.position.x = 0.62;
    b.add(handL, handR);

    var head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.72, 0.65), skin);
    head.position.y = 2.42;
    head.castShadow = true;
    b.add(head);
    var jaw = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.35), skinDeep);
    jaw.position.set(0, 2.12, 0.12);
    b.add(jaw);

    var e1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.12, 0.08), eye);
    e1.position.set(-0.16, 2.48, 0.34);
    var e2 = e1.clone();
    e2.position.x = 0.16;
    b.add(e1, e2);
    var c1 = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.06), eyeCore);
    c1.position.set(-0.16, 2.48, 0.38);
    var c2 = c1.clone();
    c2.position.x = 0.16;
    b.add(c1, c2);

    var brow = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.08, 0.12), skinDeep);
    brow.position.set(0, 2.62, 0.28);
    b.add(brow);

    var collar = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.2, 0.5), coat);
    collar.position.set(0, 2.05, 0.05);
    b.add(collar);

    b.userData.eyes = [e1, e2, c1, c2];
    b.position.set(0, 0, 14);
    b.scale.setScalar(1.25);
    // смотрит на Глеба / камеру (+Z), догоняет сзади
    b.rotation.y = 0;
    return b;
  }

  function buildMind2Exe() {
    // MIND2.exe — brown spiral poop chaser with big red eyes + teeth
    var b = new THREE.Group();
    var poop = mat(0x6b3a18, { roughness: 0.7, emissive: 0x2a1408, ei: 0.15 });
    var poopMid = mat(0x8a4a22, { roughness: 0.65, emissive: 0x3a1a0a, ei: 0.12 });
    var poopLight = mat(0xa05a2a, { roughness: 0.6 });
    var black = mat(0x0a0a0c, { roughness: 0.8 });
    var eyeRed = mat(0xff1820, { emissive: 0xff0000, ei: 1.5, roughness: 0.25 });
    var tooth = mat(0xfff8f0, { roughness: 0.3 });

    var body = new THREE.Group();
    // Spiral stacked blobs (croissant / soft-serve silhouette)
    var layers = [
      { y: 0.45, r: 0.95, s: 1.2, z: 0.1 },
      { y: 0.95, r: 1.05, s: 1.15, z: 0.0 },
      { y: 1.45, r: 0.95, s: 1.1, z: -0.05 },
      { y: 1.9, r: 0.7, s: 1.0, z: -0.1 },
      { y: 2.25, r: 0.45, s: 0.9, z: -0.05 }
    ];
    var blobs = [];
    for (var i = 0; i < layers.length; i++) {
      var L = layers[i];
      var blob = new THREE.Mesh(
        new THREE.SphereGeometry(L.r, 14, 12),
        i % 2 ? poopMid : poop
      );
      blob.scale.set(L.s, 0.75, L.s * 0.95);
      blob.position.set(Math.sin(i * 0.7) * 0.15, L.y, L.z);
      blob.castShadow = true;
      body.add(blob);
      blobs.push(blob);
    }
    // side nubs
    for (var n = 0; n < 4; n++) {
      var nub = new THREE.Mesh(new THREE.SphereGeometry(0.32, 8, 8), poopLight);
      var ang = n * Math.PI * 0.5 + 0.3;
      nub.position.set(Math.cos(ang) * 0.85, 0.7 + (n % 2) * 0.4, Math.sin(ang) * 0.5);
      body.add(nub);
    }
    b.add(body);

    // Face
    var face = new THREE.Group();
    face.position.set(0, 1.55, 1.0);
    var eyes = [];
    for (var side = -1; side <= 1; side += 2) {
      var eg = new THREE.Group();
      eg.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.44, 0.14), black));
      var pupil = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.12), eyeRed);
      pupil.position.z = 0.06;
      eg.add(pupil);
      eg.position.set(side * 0.4, 0.28, 0);
      face.add(eg);
      eyes.push(pupil);
    }
    // mouth + teeth
    var mouth = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 0.12), black);
    mouth.position.set(0, -0.15, 0.05);
    face.add(mouth);
    for (var t = -2; t <= 2; t++) {
      var toothM = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.08), tooth);
      toothM.position.set(t * 0.12, -0.05, 0.12);
      face.add(toothM);
    }
    b.add(face);

    // tag
    var tag = new THREE.Mesh(
      new THREE.BoxGeometry(0.95, 0.2, 0.06),
      mat(0x1a1008, { emissive: 0x3a1808, ei: 0.25 })
    );
    tag.position.set(0, 0.28, 1.05);
    b.add(tag);

    b.userData.eyes = eyes;
    b.userData.isMind2 = true;
    b.userData.body = body;
    b.userData.face = face;
    b.userData.blobs = blobs;
    b.position.set(0, 0, 18);
    b.scale.setScalar(0.8);
    return b;
  }




  function groundPropKind(seed) {
    var pool = ['box', 'cone', 'pillar', 'bush', 'barrier', 'curb'];
    var s = Math.abs(seed | 0);
    return pool[s % pool.length];
  }


  // ----- segmented train cars (Subway-style consists) -----------------------
  // One car = body + windows/doors + roof details + dark end plates so the seams
  // between neighbouring cars read clearly. Several cars joined by gangways make
  // one long train instead of a single stretched box.
  var CAR_GAP = 0.3;
  var CAR_COLORS_P = [0x2a4558, 0x3a2a48, 0x2a4038];
  var CAR_COLORS_C = [0x4a3228, 0x3a3830, 0x4a2a2a];
  function addCarSegment(g, zc, d, variant, laneIdx, bodyH) {
    var bogie = mat(0x141418, { metalness: 0.5, roughness: 0.55 });
    var endMat = mat(0x0b0c0f, { roughness: 0.9 });
    var sx, k, i;
    // two bogie blocks per car (one mesh each) instead of four wheels: keeps draw calls low
    for (k = -1; k <= 1; k += 2) {
      var truck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 0.9), bogie);
      truck.position.set(0, 0.2, zc + k * d * 0.3);
      g.add(truck);
    }
    var chassis = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.14, d * 0.92), bogie);
    chassis.position.set(0, 0.18, zc);
    g.add(chassis);
    var body, door;
    if (variant === 0) {
      body = new THREE.Mesh(new THREE.BoxGeometry(1.9, bodyH, d * 0.96),
        mat(CAR_COLORS_P[laneIdx % 3], { metalness: 0.25, roughness: 0.55 }));
      body.position.set(0, bodyH * 0.5, zc);
      body.castShadow = true;
      g.add(body);
      var glass = mat(0x0a1828, { emissive: 0x1a3050, ei: 0.35, metalness: 0.2, roughness: 0.25 });
      var doorMat = mat(0x10161c, { roughness: 0.6 });
      var accent = mat(0x5ec8ff, { emissive: 0x1a4060, ei: 0.25 });
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(1.92, 0.1, d * 0.97), accent);
      stripe.position.set(0, bodyH * 0.27, zc);
      g.add(stripe);
      for (sx = -1; sx <= 1; sx += 2) {
        var offs = d > 3.2 ? [-0.36, 0.36] : [0];
        for (i = 0; i < offs.length; i++) {
          var w = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.4, d * 0.15), glass);
          w.position.set(sx * 0.95, bodyH * 0.62, zc + offs[i] * d);
          g.add(w);
        }
        if (d > 3.2) {
          for (k = -1; k <= 1; k += 2) {
            door = new THREE.Mesh(new THREE.BoxGeometry(0.06, bodyH * 0.66, d * 0.12), doorMat);
            door.position.set(sx * 0.955, bodyH * 0.4, zc + k * d * 0.18);
            g.add(door);
          }
        }
      }
    } else {
      body = new THREE.Mesh(new THREE.BoxGeometry(1.95, bodyH, d * 0.96),
        mat(CAR_COLORS_C[laneIdx % 3], { metalness: 0.12, roughness: 0.8 }));
      body.position.set(0, bodyH * 0.5, zc);
      body.castShadow = true;
      g.add(body);
      var rib = mat(0x2a2018, { roughness: 0.85 });
      var cdoor = mat(0x1a1410, { roughness: 0.85 });
      for (sx = -1; sx <= 1; sx += 2) {
        door = new THREE.Mesh(new THREE.BoxGeometry(0.06, bodyH * 0.74, Math.min(1.6, d * 0.32)), cdoor);
        door.position.set(sx * 0.99, bodyH * 0.45, zc);
        g.add(door);
        for (i = -2; i <= 2; i++) {
          if (i === 0) continue;
          var r = new THREE.Mesh(new THREE.BoxGeometry(0.05, bodyH * 0.9, 0.07), rib);
          r.position.set(sx * 0.99, bodyH * 0.5, zc + i * d * 0.19);
          g.add(r);
        }
      }
    }
    var lip = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.06, d * 0.98), mat(0x1a1814));
    lip.position.set(0, bodyH + 0.02, zc);
    g.add(lip);
    // dark end plates = visible seam between cars
    for (k = -1; k <= 1; k += 2) {
      var plate = new THREE.Mesh(new THREE.BoxGeometry(1.96, bodyH, 0.07), endMat);
      plate.position.set(0, bodyH * 0.5, zc + k * d * 0.485);
      g.add(plate);
    }
  }
  function addCoupling(g, zc, gapLen, bodyH) {
    var rubber = mat(0x08090b, { roughness: 0.95 });
    var gang = new THREE.Mesh(new THREE.BoxGeometry(1.5, bodyH * 0.78, gapLen + 0.1), rubber);
    gang.position.set(0, bodyH * 0.46, zc);
    g.add(gang);
    var bar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, gapLen + 0.6), mat(0x3a3e46, { metalness: 0.7, roughness: 0.4 }));
    bar.position.set(0, 0.32, zc);
    g.add(bar);
  }

  // Place several cars flush against each other in one lane as ONE long train.
  // zFront = world z of the car nearest the player. Only the first car may be
  // climbable (ramp); the following cars are flat-roofed so you run along the roof.
  var CONSIST_D = { train: 4.6, trainLong: 9.5, trainMega: 13.5, trainRoof: 5.4, trainRoofLong: 10.5, trainRoofMega: 14.5 };
  // Seeded unit random in [0,1). Same beat+salt → same value within a run; sessionSeed varies runs.
  function beatRand(beat, salt) {
    var x = ((sessionSeed | 0) ^ ((beat * 2654435761) >>> 0) ^ ((salt * 1597334677) >>> 0)) >>> 0;
    x = (x * 1103515245 + 12345) >>> 0;
    return (x % 10000) / 10000;
  }
  function pickSolidKind(dens, beat, salt) {
    var r = beatRand(beat, salt + 11);
    if (dens > 0.35 && r < 0.18) return 'trainMega';
    if (dens > 0.12 && r < 0.45) return 'trainLong';
    return 'train';
  }
  function pickRoofKind(dens, beat, salt) {
    var r = beatRand(beat, salt + 29);
    if (dens > 0.28 && r < 0.35) return 'trainRoofLong';
    if (dens > 0.5 && r < 0.12) return 'trainRoofMega';
    return 'trainRoof';
  }
  // Build a joined consist: lead car at zFront (player-facing end), more cars trail behind (-Z).
  function placeConsist(laneIdx, zFront, kinds, opts) {
    opts = opts || {};
    if (!kinds || !kinds.length) return false;
    var total = 0, i;
    for (i = 0; i < kinds.length; i++) total += (CONSIST_D[kinds[i]] || 4.6);
    // block-check the full envelope
    if (laneBlocked(laneIdx, zFront - total * 0.5, total + 0.4, kinds[0])) return false;
    // one visual family for the whole consist
    var variant = opts.variant != null
      ? opts.variant
      : ((laneIdx * 17 + Math.floor(Math.abs(zFront) * 3) + (sessionSeed & 7)) % 2);
    var acc = 0, placed = 0;
    for (i = 0; i < kinds.length; i++) {
      var d = CONSIST_D[kinds[i]] || 4.6;
      // center of car i, measuring from the front tip backward
      var zc = zFront - acc - d * 0.5;
      var g = makeObstacle(kinds[i], laneIdx, zc, {
        variant: variant,
        noApproach: true, // multi-car consists never approach (reads as one solid train)
        consistIdx: i,
        consistLen: kinds.length
      });
      if (!g) break;
      placed++;
      acc += d;
    }
    return placed > 0;
  }
  // Build a short SS-style consist recipe for a lane
  function recipeConsist(climbable, dens, beat, salt) {
    var n = 1;
    var rr = beatRand(beat, salt + 41);
    if (dens > 0.2 && rr < 0.35) n = 2;
    if (dens > 0.45 && rr < 0.15) n = 3;
    var kinds = [];
    for (var i = 0; i < n; i++) {
      if (i === 0 && climbable) kinds.push(pickRoofKind(dens, beat, salt + i * 3));
      else kinds.push(pickSolidKind(dens, beat, salt + i * 3 + (climbable ? 7 : 0)));
    }
    // if climbable multi-car: only LEAD is roof, rest solid flats (SS ramp-then-roof-run)
    if (climbable && n > 1) {
      kinds[0] = pickRoofKind(dens, beat, salt + 90);
      for (var j = 1; j < n; j++) kinds[j] = pickSolidKind(dens, beat, salt + 100 + j);
    }
    return kinds;
  }

  
  // Ground/air props that must never sit inside a train hull
  var PROP_KINDS_NO_TRAIN = {
    high: 1, fence: 1, curb: 1, box: 1, cone: 1, pillar: 1, bush: 1, barrier: 1, low: 1
  };
  function isTrainKind(k) {
    return !!(k && String(k).indexOf('train') === 0);
  }
  function trainHalfDepth(o) {
    if (!o || !o.userData) return 2.5;
    var d = o.userData.depth != null ? o.userData.depth : occDepth(o.userData.kind || 'train');
    // approach trains sweep extra Z toward the player
    if (o.userData.approach) d += Math.min(14, o.userData.approach * 1.05);
    return d * 0.5;
  }
  // Extra distance a MOVING train will sweep toward the player before an item at zItem
  // reaches the player zone (approach = extra u/s on top of world scroll).
  function sweepExtra(tr, zItem) {
    var a = tr && tr.userData ? (tr.userData.approach || 0) : 0;
    if (!a) return 0;
    var t = Math.max(0, 2 - zItem) / Math.max(12, speed || 18);
    return Math.min(70, a * t + 1.5);
  }
  // Remove props (high bars, boxes, etc.) that intersect any train on the same lane.
  // padZ expands the forbidden zone slightly past the visual hull.
  function scrubPropsInsideTrains(padZ) {
    padZ = padZ == null ? 1.15 : padZ;
    var trains = [];
    var i, o;
    for (i = 0; i < obstacles.length; i++) {
      o = obstacles[i];
      if (!o || o.userData.taken) continue;
      if (isTrainKind(o.userData.kind)) trains.push(o);
    }
    if (!trains.length) return 0;
    var removed = 0;
    for (i = obstacles.length - 1; i >= 0; i--) {
      o = obstacles[i];
      if (!o || o.userData.taken) continue;
      var k = o.userData.kind || '';
      if (isTrainKind(k) || o.userData.solidRoof || o.userData.roof) continue;
      if (!PROP_KINDS_NO_TRAIN[k]) continue;
      var lane = o.userData.lane | 0;
      var od = (o.userData.depth != null ? o.userData.depth : occDepth(k)) * 0.5;
      for (var ti = 0; ti < trains.length; ti++) {
        var tr = trains[ti];
        if ((tr.userData.lane | 0) !== lane) continue;
        var th = trainHalfDepth(tr);
        var pdz = o.position.z - tr.position.z;
        if (Math.abs(pdz) < th + od + padZ || (pdz > 0 && pdz < th + od + padZ + sweepExtra(tr, o.position.z))) {
          try { propGroup.remove(o); } catch (eR) {}
          try { disposeTree(o); } catch (eD) {}
          obstacles.splice(i, 1);
          removed++;
          break;
        }
      }
    }
    // Coins stuck under a solid train body (roof coins OK if y high enough)
    for (i = pickups.length - 1; i >= 0; i--) {
      var c = pickups[i];
      if (!c) continue;
      var cl = c.userData && c.userData.lane != null ? (c.userData.lane | 0) : -1;
      if (cl < 0) continue;
      var cy = c.position.y;
      for (var tj = 0; tj < trains.length; tj++) {
        var tr2 = trains[tj];
        if ((tr2.userData.lane | 0) !== cl) continue;
        // allow roof-height coins on any train
        if (cy >= (tr2.userData.roofH || H_ROOF) - 0.05) continue;
        var th2 = trainHalfDepth(tr2);
        var cdz = c.position.z - tr2.position.z;
        if (Math.abs(cdz) < th2 + 0.6 || (cdz > 0 && cdz < th2 + 0.6 + sweepExtra(tr2, c.position.z))) {
          try { propGroup.remove(c); } catch (eC) {}
          try { disposeTree(c); } catch (eCd) {}
          pickups.splice(i, 1);
          break;
        }
      }
    }
    return removed;
  }


  function makeObstacle(kind, laneIdx, z, opts) {
    var g = new THREE.Group();
    g.userData = { kind: kind, lane: laneIdx, z: z, h: 1 };
    if (kind === 'box') {
      var m = new THREE.Mesh(new THREE.BoxGeometry(1.5, H_BOX, 1.2), mat(0x3a2a20, { roughness: 0.85 }));
      m.position.y = H_BOX * 0.5;
      m.castShadow = true;
      g.add(m);
      g.userData.h = H_BOX;
      g.userData.slideOk = false;
      g.userData.jumpOk = true;
    } else if (kind === 'barrier') {
      // construction barrier — wider jump prop (SS roadblock feel)
      var br = new THREE.Mesh(new THREE.BoxGeometry(1.85, 0.95, 0.7), mat(0xc45a12, { roughness: 0.7 }));
      br.position.y = 0.48;
      br.castShadow = true;
      g.add(br);
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.18, 0.72), mat(0x111111));
      stripe.position.y = 0.75;
      g.add(stripe);
      g.userData.h = 0.95;
      g.userData.slideOk = false;
      g.userData.jumpOk = true;
    } else if (kind === 'cone') {
      // Traffic cone: tall, orange/white bands, readable at distance
      var base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.46, 0.1, 10),
        mat(0x1a1a1e, { roughness: 0.8 })
      );
      base.position.y = 0.05;
      base.castShadow = true;
      g.add(base);
      var body = new THREE.Mesh(
        new THREE.ConeGeometry(0.38, 1.25, 10),
        mat(0xff5a14, { roughness: 0.55, emissive: 0x4a1800, ei: 0.25 })
      );
      body.position.y = 0.72;
      body.castShadow = true;
      g.add(body);
      // white reflective stripes
      for (var bi = 0; bi < 2; bi++) {
        var bandY = 0.45 + bi * 0.38;
        var bandR = 0.32 - bi * 0.08;
        var band = new THREE.Mesh(
          new THREE.CylinderGeometry(bandR, bandR + 0.04, 0.12, 10),
          mat(0xf5f5f0, { roughness: 0.35, emissive: 0x888888, ei: 0.15 })
        );
        band.position.y = bandY;
        g.add(band);
      }
      // tip
      var tip = new THREE.Mesh(
        new THREE.SphereGeometry(0.08, 8, 8),
        mat(0xff8844, { emissive: 0xff4400, ei: 0.4 })
      );
      tip.position.y = 1.32;
      g.add(tip);
      g.userData.h = 1.35;
      g.userData.slideOk = false;
      g.userData.jumpOk = true;
    } else if (kind === 'low') {
      var m2 = new THREE.Mesh(new THREE.BoxGeometry(1.6, H_LOW, 1.1), mat(0x4a3020));
      m2.position.y = H_LOW * 0.5;
      m2.castShadow = true;
      g.add(m2);
      g.userData.h = H_LOW;
      g.userData.slideOk = false;
      g.userData.jumpOk = true;
    } else if (kind === 'fence') {
      // chain of posts + top rail — must roll under
      for (var fi = -1; fi <= 1; fi++) {
        var fp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.9, 0.12), mat(0x555560));
        fp.position.set(fi * 0.55, 0.95, 0);
        g.add(fp);
      }
      var rail = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.14, 0.14), mat(0x888899, { metalness: 0.4 }));
      rail.position.set(0, 1.65, 0);
      g.add(rail);
      g.userData.h = 1.9;
      g.userData.depth = 0.35;
      g.userData.slideOk = true;
      g.userData.jumpOk = false;
      g.userData.lowOnly = true;
    } else if (kind === 'high') {
      var post1 = new THREE.Mesh(new THREE.BoxGeometry(0.2, 2.0, 0.2), mat(0x2a2a30));
      post1.position.set(-0.7, 1.0, 0);
      var post2 = post1.clone();
      post2.position.x = 0.7;
      var bar = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.25, 0.25), mat(0x882222, { emissive: 0x440000, ei: 0.4 }));
      bar.position.set(0, H_BAR, 0);
      g.add(post1, post2, bar);
      g.userData.h = H_BAR + 0.2;
      g.userData.depth = 0.35;
      g.userData.slideOk = true;
      g.userData.jumpOk = false;
      g.userData.lowOnly = true;
    } else if (kind === 'pillar') {
      // SS-style trackside column / support pillar — jump over
      var shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.34, 1.55, 10),
        mat(0x3a3e48, { metalness: 0.45, roughness: 0.55 })
      );
      shaft.position.y = 0.78; shaft.castShadow = true; g.add(shaft);
      var cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.38, 0.32, 0.18, 10),
        mat(0x2a2e36, { metalness: 0.5, roughness: 0.4 })
      );
      cap.position.y = 1.58; g.add(cap);
      var base = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.42, 0.12, 10),
        mat(0x1a1c22, { metalness: 0.4 })
      );
      base.position.y = 0.06; g.add(base);
      // warning stripe
      var band = new THREE.Mesh(
        new THREE.CylinderGeometry(0.3, 0.3, 0.14, 10),
        mat(0xffcc33, { emissive: 0xaa8800, ei: 0.35 })
      );
      band.position.y = 1.15; g.add(band);
      g.userData.h = 1.6;
      g.userData.depth = 0.7;
      g.userData.slideOk = false;
      g.userData.jumpOk = true;
    } else if (kind === 'bush') {
      // SS bush / foliage clump — jump over (readable green mass)
      var leaves = mat(0x2d6b28, { roughness: 0.85, emissive: 0x0a2010, ei: 0.12 });
      var dark = mat(0x1a4018, { roughness: 0.9 });
      for (var bi = 0; bi < 5; bi++) {
        var s = 0.35 + (bi % 3) * 0.12;
        var blob = new THREE.Mesh(new THREE.SphereGeometry(s, 8, 6), bi % 2 ? leaves : dark);
        blob.position.set((bi - 2) * 0.22, 0.35 + (bi % 2) * 0.2, (bi % 3 - 1) * 0.15);
        blob.castShadow = true; g.add(blob);
      }
      var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.35, 6), mat(0x3a2818, { roughness: 0.8 }));
      trunk.position.y = 0.15; g.add(trunk);
      g.userData.h = 0.95;
      g.userData.depth = 0.9;
      g.userData.slideOk = false;
      g.userData.jumpOk = true;
    } else if (kind === 'curb') {
      // low road curb / sandbag line — MUST slide under or jump (low enough to jump, high enough to catch)
      var curb = new THREE.Mesh(
        new THREE.BoxGeometry(1.7, 0.48, 0.55),
        mat(0x5a5048, { roughness: 0.7, metalness: 0.15 })
      );
      curb.position.y = 0.24; curb.castShadow = true; g.add(curb);
      var top = new THREE.Mesh(
        new THREE.BoxGeometry(1.75, 0.08, 0.58),
        mat(0xffaa22, { emissive: 0x884400, ei: 0.25 })
      );
      top.position.y = 0.5; g.add(top);
      // small posts
      for (var ci = -1; ci <= 1; ci += 2) {
        var peg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.12), mat(0x333338));
        peg.position.set(ci * 0.7, 0.28, 0); g.add(peg);
      }
      g.userData.h = 0.55;
      g.userData.depth = 0.6;
      g.userData.slideOk = true;  // can slide over if we treat as low — actually SS: jump or it's a trip
      g.userData.jumpOk = true;
      g.userData.lowOnly = false;
    
} else if (kind === 'train' || kind === 'trainLong' || kind === 'trainMega') {
      // Solid train: 1 / 2 / 3 cars joined by gangways
      var trainDepth = kind === 'trainLong' ? 9.5 : (kind === 'trainMega' ? 13.5 : 4.6);
      var bodyH = H_ROOF;
      var variant = (opts && opts.variant != null) ? opts.variant : Math.abs((laneIdx * 17 + Math.floor(z * 3))) % 2;
      var half = trainDepth * 0.5;
      var nCars = kind === 'train' ? 1 : (kind === 'trainLong' ? 2 : 3);
      var carD = (trainDepth - CAR_GAP * (nCars - 1)) / nCars;
      for (var ci2 = 0; ci2 < nCars; ci2++) {
        var czc = -half + carD * 0.5 + ci2 * (carD + CAR_GAP);
        addCarSegment(g, czc, carD, variant, laneIdx, bodyH);
        if (ci2 < nCars - 1) addCoupling(g, czc + carD * 0.5 + CAR_GAP * 0.5, CAR_GAP, bodyH);
      }
      g.userData.h = bodyH;
      g.userData.depth = trainDepth;
      g.userData.roofH = H_ROOF;
      g.userData.solidRoof = true;
      g.userData.jumpOk = false;
      g.userData.slideOk = false;
      g.userData.trainVariant = variant;
      // ~32% approach toward player (SS moving trains)
      // Never approach if L+R already solid — middle moving train = impossible
      if (!(opts && opts.noApproach) && Math.random() < 0.32 && canTrainApproach(laneIdx, z, g.userData.depth || occDepth(kind))) {
        g.userData.approach = 5.5 + Math.random() * 7;
      }
      // After placing a solid train, immediately fix any 3-lane wall
      try { if (typeof repairImpossibleTrainWalls === 'function') repairImpossibleTrainWalls(); } catch (eRep) {}
    } else if (kind === 'trainRoof' || kind === 'trainRoofLong' || kind === 'trainRoofMega') {
      // Climbable train: ramp (stairs) ONLY on the front end, then flat-roofed cars behind it
      var carDepth = kind === 'trainRoofLong' ? 10.5 : (kind === 'trainRoofMega' ? 14.5 : 5.4);
      var rampLen = 2.8;
      var bodyH = H_ROOF - 0.02;
      var halfD = carDepth / 2;
      var variantR = (opts && opts.variant != null) ? opts.variant : Math.abs((laneIdx * 17 + Math.floor(z * 3))) % 2;
      var hazard = mat(0xffcc22, { emissive: 0xcc8800, ei: 0.85 });
      var hazardDark = mat(0x1a1a12);
      // front car body (behind the stairs)
      var frontLen = 5.4 - rampLen;
      addCarSegment(g, halfD - 5.4 + frontLen * 0.5, frontLen, variantR, laneIdx, bodyH);
      // flat cars behind the front car
      var nRear = kind === 'trainRoofLong' ? 1 : (kind === 'trainRoofMega' ? 2 : 0);
      if (nRear > 0) {
        var rearSpan = carDepth - 5.4;
        var rearD = (rearSpan - CAR_GAP * nRear) / nRear;
        for (var ri = 0; ri < nRear; ri++) {
          var rzc = -halfD + rearD * 0.5 + ri * (rearD + CAR_GAP);
          addCarSegment(g, rzc, rearD, variantR, laneIdx, bodyH);
          addCoupling(g, rzc + rearD * 0.5 + CAR_GAP * 0.5, CAR_GAP, bodyH);
        }
      }
      // stairs — 4 clean steps, alternating yellow/black
      var steps = 4;
      var stepDepth = rampLen / steps;
      var stepRise = H_ROOF / steps;
      for (var si = 0; si < steps; si++) {
        var h = stepRise * (si + 1);
        var sz = halfD - stepDepth * (si + 0.5);
        var step = new THREE.Mesh(
          new THREE.BoxGeometry(1.85, h, stepDepth * 0.94),
          (si % 2 === 0) ? hazard : hazardDark
        );
        step.position.set(0, h * 0.5, sz);
        step.castShadow = true;
        g.add(step);
      }
      // one side ladder (left only) — simple rungs
      for (var lr = 0; lr < 5; lr++) {
        var rung = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.07, 0.07), hazard);
        rung.position.set(-1.05, 0.3 + lr * 0.32, halfD - rampLen * 0.5);
        g.add(rung);
      }
      g.userData.h = bodyH;
      g.userData.depth = carDepth;
      g.userData.roofH = H_ROOF;
      g.userData.roof = true;
      g.userData.rampLen = rampLen;
      g.userData.jumpOk = false;
      g.userData.slideOk = false;
    }


    g.position.set(LANES[laneIdx], 0, z);
        // final safety: never plant a bar/prop inside a train volume
    if (g.userData && g.userData.kind) {
      var gk = g.userData.kind;
      if (PROP_KINDS_NO_TRAIN[gk]) {
        var gHalf = (g.userData.depth != null ? g.userData.depth : occDepth(gk)) * 0.5;
        for (var ti = 0; ti < obstacles.length; ti++) {
          var to = obstacles[ti];
          if (!to || (to.userData.lane | 0) !== (laneIdx | 0)) continue;
          if (!isTrainKind(to.userData.kind)) continue;
          var td = trainHalfDepth(to) + 1.2;
          if (Math.abs(to.position.z - z) < td + gHalf) {
            try { disposeTree(g); } catch (eAbort) {}
            return null; // abort — would sit inside train
          }
        }
      }
    }
    propGroup.add(g);
    obstacles.push(g);
    // If we just planted a train, wipe any props already sitting in its hull
    if (g.userData && isTrainKind(g.userData.kind)) {
      scrubPropsInsideTrains(1.25);
    }
    return g;
  }

  function makeCoin(laneIdx, z, yOff) {
    // no new coins only during monkey rampage (green pad boost is fine)
    if (monkeyTimer > 0.05) return null;
    if (yOff == null) yOff = 0.9;
    // one geometry + material for every coin (they used to be rebuilt and disposed per spawn)
    if (!_coinGeo) {
      _coinGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.08, PERF.low ? 8 : 12);
      _coinGeo.userData.shared = true;
      _coinMat = mat(0xd4b84a, { metalness: 0.6, roughness: 0.3, emissive: 0x6a5010, ei: 0.35 });
      _coinMat.userData.shared = true;
    }
    var mesh = new THREE.Mesh(_coinGeo, _coinMat);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(LANES[laneIdx], yOff, z);
    mesh.userData = { lane: laneIdx, z: z, taken: false };
    // coin: no additive glow sprite

    propGroup.add(mesh);
    pickups.push(mesh);
    return mesh;
  }


  var POWER_DEFS = {
    magnet: { color: 0x4499ff, em: 0x2266cc, label: 'МАГНИТ', time: 10 },
    x2:     { color: 0xffcc44, em: 0xcc8800, label: 'x2', time: 12 },
    board:  { color: 0xcc88ff, em: 0x8844cc, label: 'БОРД', time: 8 },
    jump:   { color: 0x66ff88, em: 0x22aa44, label: 'ПРЫЖОК', time: 10 },
    jet:    { color: 0xff8844, em: 0xcc4422, label: 'ДЖЕТ', time: 9 }
  };

  function makePowerup(kind, laneIdx, z, yOff) {
    var def = POWER_DEFS[kind];
    if (!def) return null;
    var g = new THREE.Group();
    var core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.38, 0),
      mat(def.color, { emissive: def.em, ei: 0.7, metalness: 0.35, roughness: 0.35 })
    );
    core.position.y = yOff || 1.1;
    g.add(core);
    var ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.05, 6, 12),
      mat(def.color, { emissive: def.em, ei: 0.5 })
    );
    ring.position.y = yOff || 1.1;
    ring.rotation.x = Math.PI / 2;
    g.add(ring);
    // powerup: mesh is enough without huge additive glow

    g.position.set(LANES[laneIdx], 0, z);
    g.userData = { kind: kind, lane: laneIdx, taken: false, y: yOff || 1.1 };
    propGroup.add(g);
    powerups.push(g);
    return g;
  }

  function activatePower(kind) {
    var def = POWER_DEFS[kind];
    if (!def) return;
    pwr[kind] = Math.max(pwr[kind], def.time);
    if (kind === 'board') boardHits = 1; // one-hit protection, then the board breaks
    if (kind === 'jet') {
      // SS jetpack: climb to cruise, fly OVER the track (not a magnet).
      sliding = false;
      onRoof = false;
      y = Math.max(y, 0.3);
      vy = 14; // strong launch so takeoff is obvious
      invuln = Math.max(invuln, 0.35); // brief takeoff i-frames, not full jet length
      // elevated coin highway only (height = cruise) — no ground vacuum
      var Ljet = lane;
      // single-lane air highway (SS jet is not a full-width vacuum)
      for (var ji = 0; ji < 16; ji++) {
        makeCoin(Ljet, zOnBeat(10 + ji * 0.4), 2.85);
      }
    }
    renderPowers();
  }


  function updateMeterUI() {
    if (!el.coinMeter) return;
    // only touch the DOM when something visible changed (this runs every frame)
    var pct = Math.round(Math.max(0, Math.min(100, coinMeter)) * 2) / 2;
    if (pct !== _meterCache.h) {
      _meterCache.h = pct;
      el.coinMeter.style.height = pct + '%';
      el.coinMeter.style.width = ''; // only bottom→top, never left→right
    }
    monkeyReady = coinMeter >= METER_MAX - 0.5 && monkeyTimer <= 0 && monkeyCooldown <= 0 && dist >= MONKEY_MIN_DIST;
    if (monkeyReady !== _meterCache.ready) {
      _meterCache.ready = monkeyReady;
      el.coinMeter.classList.toggle('ready', monkeyReady);
      if (el.btnMonkey) el.btnMonkey.classList.toggle('ready', monkeyReady);
    }
    if (el.btnMonkey) {
      if (_meterCache.dis !== !monkeyReady) { _meterCache.dis = !monkeyReady; el.btnMonkey.disabled = !monkeyReady; }
      var txt;
      if (monkeyTimer > 0) txt = 'РЕЙД ' + Math.ceil(monkeyTimer) + 'с';
      else if (monkeyCooldown > 0) txt = 'ОТДЫХ ' + Math.ceil(monkeyCooldown) + 'с';
      else if (dist < MONKEY_MIN_DIST) txt = Math.floor(coinMeter) + '% · ' + Math.max(0, Math.ceil(MONKEY_MIN_DIST - dist)) + 'м';
      else if (monkeyReady) txt = 'ВКЛЮЧИТЬ (E)';
      else txt = Math.floor(coinMeter) + '%';
      if (txt !== _meterCache.txt) { _meterCache.txt = txt; el.btnMonkey.textContent = txt; }
    }
  }

  function activateMonkey() {
    if (dist < MONKEY_MIN_DIST) return;
    if (coinMeter < METER_MAX - 0.5 || monkeyTimer > 0 || monkeyCooldown > 0) return;
    monkeyTimer = MONKEY_DUR;
    coinMeter = METER_MAX;
    invuln = MONKEY_DUR;
    document.body.classList.add('monkey-mode');
    updateMeterUI();
    gap = Math.min(GAP_MAX, gap + 3);
    sfxMonkey();
  }

  function renderPowers() {
    if (!el.powers) return;
    var html = '';
    var order = ['magnet', 'x2', 'board', 'jump', 'jet'];
    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      if (pwr[k] > 0.05) {
        html += '<div class="power-chip ' + k + '">' + POWER_DEFS[k].label +
          '<span class="t">' + Math.ceil(pwr[k]) + 'с</span></div>';
      }
    }
    el.powers.innerHTML = html;
    el.powers.classList.toggle('hidden', !html);
  }

  function makeBoost(laneIdx, z) {
    var g = new THREE.Group();
    var pad = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 0.12, 2.2),
      mat(0x1a4a2a, { emissive: 0x116633, ei: 0.25, roughness: 0.45, metalness: 0.2 })
    );
    pad.position.y = 0.06;
    g.add(pad);
    var arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.8, 3),
      mat(0x88ffaa, { emissive: 0x44ff88, ei: 0.8 })
    );
    arrow.rotation.x = -Math.PI / 2;
    arrow.position.set(0, 0.35, 0.2);
    g.add(arrow);
    // boost: no additive sprite (bloomed into a white ball on the path)

    g.position.set(LANES[laneIdx], 0, z);
    g.userData = { lane: laneIdx, taken: false };
    propGroup.add(g);
    boosts.push(g);
    return g;
  }

  function startGame(optSet) {
    if (isArchiveSealed()) { sealForever(); return; }
    // optSet: 1 = stage1/130, 0 = stage2/150
    if (typeof optSet === 'number') musicSet = optSet === 2 ? 0 : optSet;
    if (optSet === 1) activeStage = 1;
    else if (optSet === 0) activeStage = 2;
    else if (optSet === 2) activeStage = 3;
    else if (typeof optSet !== 'number' && activeStage >= 1 && activeStage <= 3) {
      // keep current stage (retry / internal restart)
    } else {
      activeStage = musicSet === 1 ? 1 : 2;
    }
    level = activeStage;
    if (activeStage === 2 && !isUnlocked(2)) { refreshMenuLocks(); return; }
    if (isArchiveSealed()) { sealForever(); return; }
    if (activeStage === 3) { refreshMenuLocks(); return; }
    // archive site progress flags (read by the archive achievements)
    try { if (activeStage === 1) localStorage.setItem('gleb_run_l1_started_v1', '1'); } catch (eLs) {}
    applyMusicSet(false);
    // Stage 2 must rebind classic 150 buffers even if stage 1 already decoded chill
    if (activeStage === 2) {
      musicSet = 0;
      applyMusicSet(false);
    } else if (activeStage === 1) {
      musicSet = 1;
      applyMusicSet(false);
    }
    // rebuild FULL ambiance (lamps/rails/portals were wiped if only worldScenery returned)
    if (sceneryGroup) {
      while (sceneryGroup.children.length) {
        var oldScenery = sceneryGroup.children[0];
        sceneryGroup.remove(oldScenery);
        disposeTree(oldScenery);
      }
      sceneryPieces = [];
      buildWorldScenery();
      buildCinematicScenery();
      buildPremiumEnvironment();
      // buildVisualPolish() also lives in sceneryGroup: it was wiped above on
      // the first start and never rebuilt, so portals / wet patches / GLEB RUN
      // facade panels vanished the moment the game began.
      buildVisualPolish();
      sceneryGroup.traverse(function(n){ if(n && n.isMesh){ n.castShadow=false; n.receiveShadow=false; } });
      freezeStaticScenery();
    }
    // re-dress the track corridor (rails/ties) if track group is sparse
    if (trackGroup && trackGroup.children.length < 8) {
      buildTrackHeroDetails();
    }
    // Stage 2: MINDER chased by MIND2.exe — stage 1: Gleb + Buddy Horror
    if (gleb) { scene.remove(gleb); disposeTree(gleb); gleb = null; }
    if (buddy) { scene.remove(buddy); disposeTree(buddy); buddy = null; }
    gleb = (activeStage === 2) ? buildMinder() : buildGleb();
    buddy = (activeStage === 2) ? buildMind2Exe() : buildBuddy();
    scene.add(gleb);
    scene.add(buddy);
    applyStageTheme(activeStage);
    try {
      ensureAudioCtx();
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    } catch (eAud) {}
    stopAmbient();
    startMusic();
    while (obstacles.length) {
      var o = obstacles.pop();
      if (o) {
        try { propGroup.remove(o); } catch (eO) {}
        try { disposeTree(o); } catch (eD) {}
      }
    }
    while (pickups.length) {
      var p = pickups.pop();
      if (p) {
        try { propGroup.remove(p); } catch (eP) {}
        try { disposeTree(p); } catch (eD2) {}
      }
    }
    while (boosts.length) {
      var b = boosts.pop();
      if (b) { try { propGroup.remove(b); } catch (eB) {} try { disposeTree(b); } catch (eBd) {} }
    }
    while (powerups.length) {
      var pu = powerups.pop();
      if (pu) { try { propGroup.remove(pu); } catch (eU) {} try { disposeTree(pu); } catch (eUd) {} }
    }
    pwr = { magnet: 0, x2: 0, board: 0, jump: 0, jet: 0 };
    boardHits = 0;
    coinMeter = 0;
    monkeyTimer = 0;
    monkeyCooldown = 0;
    // level + musicSet already set at top of startGame(optSet)
    if (typeof level !== 'number' || level < 1) level = (musicSet === 1) ? 1 : 2;
    levelBannerT = 0;
    paused = false;
    dying = false;
    dieT = 0;
    clearRagdoll();
    if (typeof clearMinderFx === 'function') clearMinderFx();
    if (gleb) gleb.visible = true;
    if (el.pause) el.pause.classList.add('hidden');
    if (el.levelBanner) {
      el.levelBanner.classList.remove('show');
      el.levelBanner.classList.add('hidden');
    }
    monkeyReady = false;
    document.body.classList.remove('monkey-mode');
    shake = 0;
    clearFx();
    laneSlowT = 0;
    laneInputLock = 0;
    keyHeld = Object.create(null);
    score = 0;
    coins = 0;
    if (typeof clearMinderFx === 'function') clearMinderFx();
    combo = 1;

    lane = 1;
    laneX = LANES[1];
    y = 0;
    vy = 0;
    sliding = false;
    slideT = 0;
    coyoteT = 0;
    jumpBufferT = 0;
    speed = 18.5;
    dist = 0;
    score = 0;
    combo = 1;
    coins = 0;
    spawnZ = -20;
    threat = 0;
    invuln = 0;
    boostTimer = 0;
    onRoof = false;
    roofGrace = 0;
    beatFxTimer = 0;
    if (el.beatFx) el.beatFx.classList.remove('show');
    beatClock = 0;
    beatIndex = 0;
    lastBeatIndex = -1;
    spawnBeatCursor = 12;
    spawnFillBeatCursor = 13;
    gap = GAP_MAX;
    distSinceBoostSpawn = 0;
    lastBoostDist = 0;
    lastPatternBucket = -1;
    safeLaneHint = 1;
    patternStreak = 0;
    gameOver = false;
    running = true;

    gleb.position.set(laneX, 0, 2);
    gleb.scale.set(1, 1, 1);
    buddy.position.set(0, 0, 16);

    el.title.classList.add('hidden');
    el.over.classList.add('hidden');
    el.hud.classList.remove('hidden');
    el.touch.classList.remove('hidden');
    el.warn.classList.add('hidden');
    if (el.powers) el.powers.classList.remove('hidden');
    if (el.meterWrap) el.meterWrap.classList.remove('hidden');
    resetUiCaches();
    renderPowers();
    updateMeterUI();
    updateHud();

    // PROCEDURAL COLD OPEN: the first ~10 seconds use the same director as the
    // rest of the run, but at low density. This keeps Subway-style teaching
    // while avoiding a memorized pile of hard-coded obstacles followed by a
    // dead stretch. Each run gets a fresh seed and therefore a fresh opening.
    sessionSeed = (Math.random() * 0x7fffffff) | 0;
    spawnBeatCursor = 7;
    spawnFillBeatCursor = 8;
    lastCommitObstacleBeat = -99;
    lastCommitObstacleKind = '';
    lastCommitObstacleZ = 0;
    lastPatternBucket = -1;
    // roll-under state leaked between runs: after a death at beat ~400 the next
    // run saw "beat - lastRollBeat < 8" as true for its whole length and silently
    // banned trains on that lane → the first stretch of a restart looked different.
    lastRollBeat = -99;
    lastRollLanes = [];
    patternStreak = 0;
    // Intro MUST pass real beat indices into spawnOnBeat (gates + phrase).
    // Old code used sessionSeed+beat as absoluteBeat → huge values → broken
    // patterns on the first stretch of every run.
    for (var introBeat = 7; introBeat <= 19; introBeat += 2) {
      var savedDist = dist;
      dist = Math.max(dist, introBeat * 4.5); // mild dens so early long/ramp can appear
      spawnOnBeat(introBeat, introBeat);
      dist = savedDist;
    }
    for (var introFill = 8; introFill <= 20; introFill += 2) {
      spawnBeatFill(introFill, introFill);
    }
    // Guarantee opening variety: at least one ramp car + one long solid
    // (procedural open can still skip them depending on seed)
    (function forceIntroTrainVariety() {
      var zRamp = zOnBeat(11);
      var zLong = zOnBeat(15);
      var hasRoof = false, hasLong = false;
      for (var oi = 0; oi < obstacles.length; oi++) {
        var k = obstacles[oi] && obstacles[oi].userData && obstacles[oi].userData.kind;
        if (!k) continue;
        if (k.indexOf('trainRoof') === 0) hasRoof = true;
        if (k === 'trainLong' || k === 'trainMega') hasLong = true;
      }
      var start = (sessionSeed >> 3) % 3, li, lane, zTry, tries;
      // never plant on top of anything: slide the slot back until a lane is really free
      function freeSlot(kind, z0) {
        for (tries = 0; tries < 4; tries++) {
          zTry = z0 - tries * beatDistUnits();
          for (li = 0; li < 3; li++) {
            lane = (start + li) % 3;
            if (!laneBlocked(lane, zTry, occDepth(kind) + 0.6, kind)) return { lane: lane, z: zTry };
          }
        }
        return null;
      }
      if (!hasRoof) {
        var sr = freeSlot('trainRoof', zRamp);
        if (sr) {
          makeObstacle('trainRoof', sr.lane, sr.z, { noApproach: true });
          // solid companions so it reads as a "2+1 climbable" beat
          for (li = 0; li < 3; li++) {
            if (li === sr.lane) continue;
            if (!laneBlocked(li, sr.z, occDepth('train') + 0.6, 'train'))
              makeObstacle('train', li, sr.z, { noApproach: true });
          }
        }
      }
      if (!hasLong) {
        var sl = freeSlot('trainLong', zLong);
        if (sl && !wouldCreateTrainWall(sl.lane, sl.z, occDepth('trainLong'))) makeObstacle('trainLong', sl.lane, sl.z, { noApproach: true });
      }
    })();
    spawnBeatCursor = 21;
    spawnFillBeatCursor = 22;
    sanitizeSpawns();
    repairImpossibleTrainWalls();
    scrubPropsInsideTrains(1.4);

  }

  function clearRagdoll() {
    for (var i = 0; i < ragdoll.length; i++) {
      scene.remove(ragdoll[i].mesh);
      disposeTree(ragdoll[i].mesh);
    }
    ragdoll = [];
  }

  
  
  // Gas / poop puffs are pooled: they used to allocate a new geometry + material
  // per particle (and passed a bogus `depth` option → a console warning each time),
  // which meant GC hitches every few frames while playing as Minder.
  var _fxSphereGeo = null;
  var minderPool = { gas: [], poop: [] };
  function releaseMinderFx(p) {
    var m = p.mesh;
    if (!m) return;
    if (m.parent) m.parent.remove(m);
    m.visible = false;
    var pool = minderPool[p.kind === 'gas' ? 'gas' : 'poop'];
    if (pool.length < 48) pool.push(m);
    else { m.material.dispose(); }
  }
  function clearMinderFx() {
    for (var i = 0; i < minderFx.length; i++) releaseMinderFx(minderFx[i]);
    minderFx = [];
  }

  function spawnMinderGas(burst) {
    if (!gleb || !gleb.userData || !gleb.userData.isMinder) return;
    var fxCap = PERF.low ? 16 : 40;
    if (minderFx.length > fxCap) return;
    var n = burst || 3;
    if (PERF.low) n = Math.max(1, (n + 1) >> 1);
    if (!_fxSphereGeo) _fxSphereGeo = new THREE.SphereGeometry(1, 6, 5);
    var bx = gleb.position.x;
    var by = gleb.position.y + 0.85;
    var bz = gleb.position.z + 0.35; // behind relative to facing -Z... root faces Math.PI so +Z is back
    // character faces -Z (rotation.y = PI), butt is local -Z → world +Z
    for (var i = 0; i < n; i++) {
      var col = Math.random() > 0.4 ? 0x66ff44 : 0x44cc33;
      var gr = 0.12 + Math.random() * 0.18;
      var mesh = minderPool.gas.pop();
      if (!mesh) {
        mesh = new THREE.Mesh(_fxSphereGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, depthWrite: false }));
      }
      mesh.material.color.setHex(col);
      mesh.material.opacity = 0.55;
      mesh.scale.setScalar(gr);
      mesh.visible = true;
      mesh.position.set(
        bx + (Math.random() - 0.5) * 0.35,
        by + Math.random() * 0.15,
        bz + Math.random() * 0.2
      );
      scene.add(mesh);
      minderFx.push({
        mesh: mesh,
        kind: 'gas',
        r: gr,
        life: 0.45 + Math.random() * 0.35,
        max: 0.8,
        vx: (Math.random() - 0.5) * 1.2,
        vy: 0.6 + Math.random() * 1.4,
        vz: 1.5 + Math.random() * 2.5
      });
    }
  }

  function spawnMinderPoop(heavy) {
    if (!gleb || !gleb.userData || !gleb.userData.isMinder) return;
    var fxCapP = PERF.low ? 16 : 40;
    if (minderFx.length > fxCapP) return;
    var n = heavy ? 3 : 2;
    if (PERF.low) n = 1;
    if (!_fxSphereGeo) _fxSphereGeo = new THREE.SphereGeometry(1, 6, 5);
    var bx = gleb.position.x;
    var by = gleb.position.y + 0.75;
    var bz = gleb.position.z + 0.4;
    for (var i = 0; i < n; i++) {
      var s = 0.08 + Math.random() * (heavy ? 0.12 : 0.08);
      var mesh = minderPool.poop.pop();
      if (!mesh) {
        mesh = new THREE.Mesh(_fxSphereGeo, new THREE.MeshStandardMaterial({ color: 0x5c3018, roughness: 0.95, transparent: true, opacity: 0.55 }));
      }
      var sy = 0.7 + Math.random() * 0.5;
      mesh.scale.set(s, s * sy, s);
      mesh.rotation.set(0, 0, 0);
      mesh.visible = true;
      mesh.position.set(
        bx + (Math.random() - 0.5) * 0.5,
        by,
        bz + Math.random() * 0.25
      );
      scene.add(mesh);
      minderFx.push({
        mesh: mesh,
        kind: 'poop',
        life: 1.2 + Math.random() * 0.8,
        max: 2,
        vx: (Math.random() - 0.5) * 2.5,
        vy: 1.5 + Math.random() * 3.5,
        vz: 2 + Math.random() * 4,
        spin: (Math.random() - 0.5) * 8
      });
    }
    // extra gas with every poop dump
    spawnMinderGas(heavy ? 2 : 1);
  }

  
  function updatePowerAnims(gdt, boardActive) {
    if (!gleb || !gleb.userData) return;
    var ud = gleb.userData;
    var jetOn = pwr.jet > 0;
    var magOn = pwr.magnet > 0;
    var jumpOn = pwr.jump > 0;
    var x2On = pwr.x2 > 0;
    var tnow = performance.now() * 0.001;

    if (ud.jetpack) {
      ud.jetpack.visible = jetOn;
      if (jetOn) {
        var flicker = 0.85 + Math.sin(tnow * 40) * 0.15;
        if (ud.jetFlame) ud.jetFlame.scale.set(flicker, 0.9 + Math.random() * 0.4, flicker);
        if (ud.jetFlame2) ud.jetFlame2.scale.set(flicker * 0.8, 0.8 + Math.random() * 0.5, flicker * 0.8);
        // lean forward and slightly bank
        if (monkeyTimer <= 0 && !dying) {
          gleb.rotation.x = -0.28;
          gleb.rotation.z = Math.sin(tnow * 2.2) * 0.14;
        }
        if (ud.isMinder) {
          ud._jetGasAcc = (ud._jetGasAcc || 0) + gdt;
          if (ud._jetGasAcc > 0.18) { ud._jetGasAcc = 0; spawnMinderGas(3); }
        } else if (ud.head && monkeyTimer <= 0) {
          // Gleb jet: mild lean — do NOT permanently crush head position
          ud.head.rotation.x = 0.55;
          ud.head.position.set(0, 1.92, 0.08);
          if (ud.torso) ud.torso.rotation.x = 0.35;
          if (ud.junkRoot) ud.junkRoot.rotation.x = -0.9;
        }
      } else if (!ud.isMinder && ud.head && monkeyTimer <= 0) {
        // restore Gleb head after jet ends
        if (ud.head.position.y < 1.85) ud.head.position.set(0, 1.92, 0);
        if (pwr.jet <= 0 && Math.abs(ud.head.rotation.x) > 0.3 && !sliding) {
          ud.head.rotation.x *= 0.8;
        }
      }
    }
    if (ud.magnetFx) {
      ud.magnetFx.visible = magOn;
      if (magOn) {
        ud.magnetFx.rotation.y += gdt * 3.5;
        ud.magnetFx.rotation.z = Math.sin(tnow * 2) * 0.2;
      }
    }
    if (ud.jumpBoots) {
      ud.jumpBoots.visible = jumpOn;
      if (jumpOn) ud.jumpBoots.position.y = 0.06 + Math.sin(tnow * 8) * 0.03;
    }
    if (ud.x2Aura) {
      ud.x2Aura.visible = x2On;
      if (x2On) {
        ud.x2Aura.rotation.z += gdt * 4;
        ud.x2Aura.scale.setScalar(1 + Math.sin(tnow * 5) * 0.08);
      }
    }
    // Board: freeze legs already via runCycle; Tails-tail spin for Gleb, light farts for Minder
    if (boardActive && monkeyTimer <= 0 && !dying) {
      if (ud.isMinder) {
        ud._boardGasAcc = (ud._boardGasAcc || 0) + gdt;
        if (ud._boardGasAcc > 0.55) { ud._boardGasAcc = 0; spawnMinderGas(2); }
      } else if (ud.tailBones && ud.tailBones.length) {
        // Tails-style propeller spin
        for (var ti = 0; ti < ud.tailBones.length; ti++) {
          ud.tailBones[ti].rotation.x = 0.2;
          ud.tailBones[ti].rotation.z = tnow * (18 + ti * 4);
        }
      }
      // slight board crouch idle
      if (ud.legs && !ud.isMinder) {
        ud.legs[0].rotation.x = 0.25;
        ud.legs[1].rotation.x = 0.25;
      }
    }
  }

  function updateMinderFx(dt) {
    for (var i = minderFx.length - 1; i >= 0; i--) {
      var p = minderFx[i];
      p.life -= dt;
      if (p.life <= 0) {
        releaseMinderFx(p);
        minderFx.splice(i, 1);
        continue;
      }
      p.vy -= 9 * dt;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      if (p.kind === 'gas') {
        var t = 1 - p.life / p.max;
        p.mesh.scale.setScalar(p.r * (1 + t * 2.2));
        p.mesh.material.opacity = 0.55 * (p.life / p.max);
      } else {
        p.mesh.rotation.x += p.spin * dt;
        p.mesh.rotation.z += p.spin * 0.7 * dt;
        if (p.mesh.position.y < 0.08) {
          p.mesh.position.y = 0.08;
          p.vy *= -0.25;
          p.vx *= 0.7;
          p.vz *= 0.7;
        }
      }
    }
  }


  function animateMinder(gdt, dt, runCycle, jumping, sliding, legPhase) {
    var ud = gleb.userData;
    if (!ud || !ud.isMinder) return;

    // Root pose
    if (monkeyTimer > 0 && !dying) {
      if (ud.ballSpin == null) ud.ballSpin = 0;
      ud.ballSpin -= gdt * 13;
      gleb.rotation.x = ud.ballSpin;
      gleb.rotation.y = Math.PI;
      gleb.scale.set(1, 1, 1);
    } else if (sliding) {
      gleb.rotation.set(0, Math.PI, 0);
      gleb.scale.set(1.2, 0.4, 1.2);
    } else {
      gleb.rotation.set(0, Math.PI, 0);
      if (pwr.jet > 0) {
        // jetpack: lean into the flight (this used to be erased every frame)
        gleb.rotation.x = -0.28;
        gleb.rotation.z = Math.sin(performance.now() * 0.0022) * 0.14;
      }
      gleb.scale.set(1, 1, 1);
    }
    if (!(monkeyTimer > 0)) ud.ballSpin = 0;

    // Bind positions — monkey: compact ball CENTRED on the root origin so the roll
    // spins about its own centre (root is lifted by ballLift in update()).
    // Slide: the root is squashed (see above), so the limbs keep a normal standing
    // layout — lowering them as well squashed the figure twice and tore it apart.
    if (ud.pelvis) {
      if (monkeyTimer > 0 && !dying) {
        ud.pelvis.position.set(0, -0.3, 0);
        ud.pelvis.rotation.set(-0.4, 0, 0);
      } else {
        ud.pelvis.position.set(0, 0.92, 0);
        ud.pelvis.rotation.set(sliding ? 0.15 : 0, 0, 0);
      }
    }
    if (ud.head) {
      if (monkeyTimer > 0 && !dying) {
        ud.head.position.set(0, 0.15, 0.35);
        ud.head.rotation.set(0.6, 0, 0);
      } else {
        ud.head.position.set(0, 1.88, sliding ? 0.1 : 0);
        ud.head.rotation.set(sliding ? 0.25 : Math.sin(legPhase * 2) * 0.04, 0, 0);
      }
    }
    if (ud.torso) {
      if (monkeyTimer > 0 && !dying) {
        ud.torso.position.set(0, -0.08, 0.05);
        ud.torso.rotation.x = 0.5;
      } else {
        ud.torso.position.set(0, 1.28, 0);
        ud.torso.rotation.x = sliding ? 0.3 : (jumping ? -0.2 : Math.sin(legPhase * 2) * 0.05);
      }
    }

    var legs = ud.legData;
    if (legs) {
      for (var li = 0; li < 2; li++) {
        var L = legs[li];
        L.hip.position.set((li === 0 ? -1 : 1) * 0.14, 0, 0);
        var ph = legPhase + li * Math.PI;
        if (monkeyTimer > 0) {
          // legs curled UNDER body — still visible as part of the ball
          L.hip.rotation.x = 1.35;
          L.knee.rotation.x = 1.55;
        } else if (sliding) {
          L.hip.rotation.x = 0.9;
          L.knee.rotation.x = 0.5;
        } else if (jumping) {
          L.hip.rotation.x = -0.55;
          L.knee.rotation.x = 0.75;
        } else if (runCycle) {
          var swing = Math.sin(ph) * 0.42;
          L.hip.rotation.x = swing;
          L.knee.rotation.x = Math.max(0.08, -swing) * 0.7 + 0.12;
        } else {
          L.hip.rotation.x = 0.05;
          L.knee.rotation.x = 0.1;
        }
      }
    }

    var arms = ud.armData;
    if (arms) {
      for (var ai = 0; ai < 2; ai++) {
        var A = arms[ai];
        A.shoulder.position.set((ai === 0 ? -1 : 1) * 0.34, 0.28, 0);
        var aph = legPhase + Math.PI * (ai + 1);
        if (monkeyTimer > 0) {
          // arms wrap around — stay readable while spinning
          A.shoulder.rotation.set(0.9, 0, (ai === 0 ? 0.9 : -0.9));
          A.elbow.rotation.x = 1.2;
        } else if (sliding) {
          A.shoulder.rotation.set(0.85, 0, (ai === 0 ? 0.25 : -0.25));
          A.elbow.rotation.x = 0.4;
        } else if (jumping) {
          A.shoulder.rotation.set(-0.5, 0, (ai === 0 ? 0.25 : -0.25));
          A.elbow.rotation.x = 0.25;
        } else if (runCycle) {
          A.shoulder.rotation.set(Math.sin(aph) * 0.5, 0, (ai === 0 ? 0.1 : -0.1));
          A.elbow.rotation.x = Math.max(0.12, -Math.sin(aph)) * 0.55;
        } else {
          A.shoulder.rotation.set(0.12, 0, (ai === 0 ? 0.08 : -0.08));
          A.elbow.rotation.x = 0.15;
        }
      }
    }

    // Soft butt jiggle
    if (ud.butt) {
      var impact = runCycle ? Math.abs(Math.sin(legPhase)) * 0.8 : 0;
      ud.buttJiggle = (ud.buttJiggle || 0) * 0.82 + impact * 0.18;
      var j = ud.buttJiggle;
      ud.butt.position.set(0, 0.02 + j * 0.04, -0.22);
      ud.butt.scale.set(1 + j * 0.08, 1 - j * 0.05, 1 + j * 0.1);
      if (ud.buttCheeks) {
        ud.buttCheeks[0].position.x = -0.16 - j * 0.02;
        ud.buttCheeks[1].position.x = 0.16 + j * 0.02;
      }
    }

    if (!ud._wasSliding) ud._wasSliding = false;
    if (!ud._wasJumping) ud._wasJumping = false;
    if (sliding && !ud._wasSliding) spawnMinderGas(4);
    if (jumping && !ud._wasJumping) spawnMinderGas(3);
    ud._wasSliding = sliding;
    ud._wasJumping = jumping;
    if (monkeyTimer > 0) {
      ud._poopAcc = (ud._poopAcc || 0) + gdt;
      if (ud._poopAcc > 0.28) { ud._poopAcc = 0; spawnMinderPoop(true); }
    } else ud._poopAcc = 0;
  }












function beginDeath(reason) {
    if (dying || gameOver) return;
    dying = true;
    deathReason = reason || 'crash';
    dieT = 1.35;
    running = false;
    if (reason === 'caught') sfxCaught();
    else sfxCrash();
    stopMusic();
    startAmbient('over');
    el.touch.classList.add('hidden');
    el.warn.classList.add('hidden');
    document.body.classList.remove('monkey-mode');
    // the red "he's close" vignette only gets toggled inside update(), which
    // stops running on death → it stayed stuck on the game-over screen/menu
    document.body.classList.remove('danger-close');
    // light ragdoll — palette matches runner (Gleb green / Minder white-black-red)
    clearRagdoll();
    if (typeof clearMinderFx === 'function') clearMinderFx();
    gleb.visible = false;
    var ox = gleb.position.x, oy = gleb.position.y, oz = gleb.position.z;
    var isM = !!(gleb.userData && gleb.userData.isMinder);
    var furMat = isM ? mat(0xf0f0f0, { roughness: 0.5 }) : mat(0x3ecf6a, { roughness: 0.85 });
    var darkMat = isM ? mat(0x111114, { roughness: 0.7 }) : mat(0x2a9a4a, { roughness: 0.9 });
    var accentMat = isM ? mat(0xe01020, { emissive: 0x880010, ei: 0.5 }) : darkMat;
    var parts = isM ? [
      [0.7, 0.7, 0.15, 0, 1.95, 0.2],
      [0.55, 0.55, 0.35, 0, 1.15, 0],
      [0.16, 0.45, 0.16, -0.35, 1.2, 0],
      [0.16, 0.45, 0.16, 0.35, 1.2, 0],
      [0.16, 0.45, 0.16, -0.18, 0.55, 0],
      [0.16, 0.45, 0.16, 0.18, 0.55, 0],
      [0.2, 0.24, 0.08, -0.16, 2.0, 0.45],
      [0.2, 0.24, 0.08, 0.16, 2.0, 0.45]
    ] : [
      [0.55, 0.5, 0.4, 0, 1.2, 0],
      [0.45, 0.4, 0.4, 0, 1.9, 0],
      [0.22, 0.5, 0.22, -0.25, 0.5, 0],
      [0.22, 0.5, 0.22, 0.25, 0.5, 0],
      [0.2, 0.4, 0.2, -0.4, 1.3, 0],
      [0.2, 0.4, 0.2, 0.4, 1.3, 0],
      [0.18, 0.18, 0.5, 0, 0.4, 0.3],
      [0.2, 0.2, 0.2, -0.15, 0.3, 0.2]
    ];
    for (var pi = 0; pi < parts.length; pi++) {
      var p = parts[pi];
      var mesh = new THREE.Mesh(
        new THREE.BoxGeometry(p[0], p[1], p[2]),
        (isM && pi >= 6) ? accentMat : (pi % 2 ? darkMat : furMat)
      );
      mesh.position.set(ox + p[3], oy + p[4], oz + p[5]);
      mesh.castShadow = true;
      scene.add(mesh);
      ragdoll.push({
        mesh: mesh,
        vx: (Math.random() - 0.5) * 9,
        vy: 5 + Math.random() * 7,
        vz: (Math.random() - 0.5) * 6 + 1,
        rx: (Math.random() - 0.5) * 12,
        ry: (Math.random() - 0.5) * 12,
        rz: (Math.random() - 0.5) * 10
      });
    }
  }

  function finishDeathUI() {
    gameOver = true;
    dying = false;
    el.hud.classList.add('hidden');
    if (el.powers) el.powers.classList.add('hidden');
    if (el.meterWrap) el.meterWrap.classList.add('hidden');
    el.over.classList.remove('hidden');
    var why = deathReason === 'caught'
      ? 'Бадихоррор догнал Глеба.'
      : 'Глеб врезался на пути.';
    el.overStats.textContent =
      why + ' Ур.' + level + ' · Очки: ' + Math.floor(score) + ' · ' + Math.floor(dist) + 'м · Монеты: ' + coins;
  }

  function endGame(reason) {
    beginDeath(reason);
  }

  function updateRagdoll(dt) {
    if (!dying) return;
    dieT -= dt;
    for (var i = 0; i < ragdoll.length; i++) {
      var r = ragdoll[i];
      r.vy -= 18 * dt;
      r.mesh.position.x += r.vx * dt;
      r.mesh.position.y += r.vy * dt;
      r.mesh.position.z += r.vz * dt;
      r.mesh.rotation.x += r.rx * dt;
      r.mesh.rotation.y += r.ry * dt;
      r.mesh.rotation.z += r.rz * dt;
      if (r.mesh.position.y < 0.05) {
        r.mesh.position.y = 0.05;
        r.vy *= -0.35;
        r.vx *= 0.85;
        r.vz *= 0.85;
      }
    }
    if (dieT <= 0) finishDeathUI();
  }

  // --- spawn occupancy: no boost-in-obstacle, no obstacle-in-obstacle ---
  var OCC_PAD = 1.8; // min gap between volumes on same lane

  function occDepth(kind) {
    if (kind === 'train') return 4.6;
    if (kind === 'trainLong') return 10.2;
    if (kind === 'trainMega') return 15.0;
    if (kind === 'trainRoof') return 5.4;
    if (kind === 'trainRoofLong') return 11.4;
    if (kind === 'trainRoofMega') return 16.0;
    if (kind === 'box' || kind === 'barrier') return 1.4;
    if (kind === 'cone') return 0.9;
    if (kind === 'low') return 1.3;
    if (kind === 'high' || kind === 'fence') return 1.0;
    if (kind === 'pillar') return 0.8;
    if (kind === 'bush') return 1.0;
    if (kind === 'curb') return 0.7;
    if (kind === 'boost') return 2.4;
    if (kind === 'roofBridge') return 6.2; // matches the fixed BRIDGE_DEPTH in slot 14
    if (kind === 'coin') return 0.6;
    if (kind === 'power') return 1.0;
    return 1.2;
  }

  function laneBlocked(laneIdx, z, depth, placingKind) {
    var pad = OCC_PAD;
    var pk = placingKind || '';
    var ground = pk === 'high' || pk === 'fence' || pk === 'box' || pk === 'barrier' ||
      pk === 'cone' || pk === 'low' || pk === 'pillar' || pk === 'bush' || pk === 'curb';
    if (ground) pad += 1.6;
    if (pk.indexOf('train') === 0) pad += 0.8;
    var half = depth * 0.5 + pad;
    var z0 = z - half;
    var z1 = z + half;
    function hitList(arr, getD) {
      for (var i = 0; i < arr.length; i++) {
        var o = arr[i];
        if (!o || o.userData.taken) continue;
        if ((o.userData.lane|0) !== (laneIdx|0)) continue;
        var od = getD(o);
        if (o.userData.approach) od += Math.min(12, o.userData.approach * 0.9);
        var ok = (o.userData.kind || '');
        if (ground && ok.indexOf('train') === 0) {
          od += 3.6;
          if (o.userData.depth != null) od = Math.max(od, o.userData.depth * 0.5 + 2.2);
          if (o.userData.approach) od += Math.min(12, o.userData.approach * 0.9);
        }
        if (pk.indexOf('train') === 0 && (ok === 'high' || ok === 'fence' || ok === 'curb' || ok === 'box' || ok === 'barrier' || ok === 'low')) {
          od += 3.6;
        }
        var oz = o.position.z;
        var o0 = oz - od * 0.5 - pad;
        var o1 = oz + od * 0.5 + pad;
        if (z0 <= o1 && z1 >= o0) return true;
      }
      return false;
    }
    if (hitList(obstacles, function (o) {
      return (o.userData.depth || occDepth(o.userData.kind || ''));
    })) return true;
    if (hitList(boosts, function () { return occDepth('boost'); })) return true;
    return false;
  }

  function pickFreeLane(z, depth, prefer, kind) {
    var order = [0, 1, 2];
    if (prefer != null) {
      order = [prefer, (prefer + 1) % 3, (prefer + 2) % 3];
    } else {
      for (var i = 2; i > 0; i--) {
        var j = (Math.random() * (i + 1)) | 0;
        var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
      }
    }
    for (var k = 0; k < order.length; k++) {
      if (!laneBlocked(order[k], z, depth, kind)) return order[k];
    }
    return -1;
  }

  function findClearZ(baseZ, depth, laneIdx, maxTries) {
    var z = baseZ;
    for (var t = 0; t < (maxTries || 10); t++) {
      if (laneIdx >= 0) {
        if (!laneBlocked(laneIdx, z, depth)) return z;
      } else {
        if (pickFreeLane(z, depth) >= 0) return z;
      }
      z -= 3.2; // push further ahead (more negative)
    }
    return null;
  }

  function spawnBoostSafe(baseZ) {
    var depth = occDepth('boost');
    // snap requested Z to beat plane first
    var zBeat = zOnBeat(snapBeatsAhead(baseZ));
    var z = findClearZ(zBeat, depth, -1, 12);
    if (z == null) return false;
    z = zOnBeat(snapBeatsAhead(z));
    var L = pickFreeLane(z, depth);
    if (L < 0) return false;
    makeBoost(L, z);
    // coins only on other free lanes, offset back
    var cz = z - 4;
    for (var i = 0; i < 3; i++) {
      if (i === L) continue;
      if (!laneBlocked(i, cz, occDepth('coin'))) makeCoin(i, cz, 1.0);
    }
    return true;
  }


  function spawnCoinArc(laneIdx, zCenter, span, peakY, count) {
    count = count || 7;
    span = span || 5.5;
    peakY = peakY != null ? peakY : H_COIN_ARC;
    for (var i = 0; i < count; i++) {
      var u = count === 1 ? 0.5 : i / (count - 1);
      var z = zCenter - span * 0.5 + span * u;
      var yOff = 0.45 + Math.sin(u * Math.PI) * peakY;
      if (!laneBlocked(laneIdx, z, occDepth('coin'))) makeCoin(laneIdx, z, yOff);
    }
  }

  // Off-beat (odd quarter-note) coin accents. The obstacle grid below only
  // ever gets called with even `absoluteBeat` values, so every branch it
  // checks against `slot = absoluteBeat % 16` always lands on an even
  // number — the odd slots (1,3,5...) and the catch-all fallback at the
  // bottom of spawnOnBeat were dead code, never once reached. That left
  // the track only filled on half-note beats (every 0.8s at 150 BPM):
  // musically sparse compared to a Subway Surfers coin trail, and it threw
  // away a free chance to make the world visibly pulse on every beat, not
  // just every other one. This fills the gaps with light, non-blocking
  // coin accents — it never places obstacles, so it can't make the game
  // harder, only busier and more clearly "in time".
  function spawnBeatFill(absoluteBeat, beatsAhead) {
    if ((absoluteBeat % 8) === 5) return; // one skipped beat per phrase = breathing room
    var z = zOnBeat(beatsAhead);
    var L = ((absoluteBeat / 2 | 0) + 2) % 3; // offset from the obstacle-slot lane rotation
    if (laneBlocked(L, z, occDepth('coin'))) {
      L = pickFreeLane(z, occDepth('coin'));
      if (L < 0) return;
    }
    makeCoin(L, z, 1.0);
  }

  function trainTooSoonAfterCommit(zz) {
    if (lastCommitObstacleBeat < 0) return false;
    var minGap = beatDistUnits() * 1.7;
    return Math.abs(zz - lastCommitObstacleZ) < minGap;
  }

  // Safety director: never build a physically inescapable wall out of solid trains.
  // A train may look like it belongs to a weave while its depth overlaps the next
  // train on another lane.  At speed this can close all three lanes for several
  // frames, which is an unfair death even though no single spawn point contains
  // three trains. Keep this conservative and only police SOLID trains; a roof car
  // remains a legitimate escape route.
  function isSolidTrainKind(k) {
    return k === 'train' || k === 'trainLong' || k === 'trainMega';
  }

  // Approaching trains sweep a longer Z corridor — treat them as thicker for safety
  function effectiveTrainDepth(o) {
    var k = o.userData.kind || '';
    var od = o.userData.depth != null ? o.userData.depth : occDepth(k);
    if (o.userData.approach) od += Math.min(14, o.userData.approach * 1.15);
    return od;
  }

  // Can this lane host a moving train without sealing all 3 lanes?
  function canTrainApproach(laneIdx, zz, depth) {
    var span = (depth || occDepth('train')) * 0.5 + 1.2;
    // Project forward: approach closes the gap, so check a wider Z band ahead of player
    var near = Math.max(3.2, beatDistUnits() * 1.1);
    var blocked = [false, false, false];
    // Future solid at this lane once it approaches
    blocked[laneIdx|0] = true;
    for (var oi = 0; oi < obstacles.length; oi++) {
      var o = obstacles[oi];
      if (!o || o.userData.taken || o.userData.roof) continue;
      if (!isSolidTrainKind(o.userData.kind)) continue;
      var od = effectiveTrainDepth(o);
      var delta = Math.abs(o.position.z - zz);
      if (delta <= Math.max(near, span + od * 0.5 + OCC_PAD)) {
        blocked[o.userData.lane|0] = true;
      }
    }
    // If both other lanes solid → only this lane is escape → no approach
    var others = 0;
    for (var li = 0; li < 3; li++) if (li !== (laneIdx|0) && blocked[li]) others++;
    if (others >= 2) return false;
    return true;
  }

  function wouldCreateTrainWall(laneIdx, zz, depth) {
    var span = (depth || occDepth('train')) * 0.5 + 0.55;
    var near = Math.max(2.4, beatDistUnits() * 0.82);
    var blocked = [false, false, false];
    blocked[laneIdx] = true;
    for (var oi = 0; oi < obstacles.length; oi++) {
      var o = obstacles[oi];
      if (!o || o.userData.taken || o.userData.roof) continue;
      if (!isSolidTrainKind(o.userData.kind)) continue;
      var od = effectiveTrainDepth(o);
      var delta = Math.abs(o.position.z - zz);
      if (delta <= Math.max(near, span + od * 0.5 + OCC_PAD)) {
        blocked[o.userData.lane|0] = true;
      }
    }
    return blocked[0] && blocked[1] && blocked[2];
  }

  function repairImpossibleTrainWalls() {
    // Sample swept Z volume including approach-expanded depth.
    // If all 3 lanes solid at any sample → convert offender to climbable roof
    // OR kill its approach speed if it's the only escape lane.
    var samples = 7;
    for (var oi = obstacles.length - 1; oi >= 0; oi--) {
      var o = obstacles[oi];
      if (!o || o.userData.taken || o.userData.roof) continue;
      if (!isSolidTrainKind(o.userData.kind)) continue;
      var d = effectiveTrainDepth(o);
      var a = o.position.z - d * 0.5 - 0.35;
      var b = o.position.z + d * 0.5 + 0.35;
      var bad = false;
      for (var si = 0; si <= samples; si++) {
        var z = a + (b - a) * (si / samples);
        var solid = [false, false, false];
        for (var sj = 0; sj < obstacles.length; sj++) {
          var q = obstacles[sj];
          if (!q || q.userData.taken || q.userData.roof) continue;
          if (!isSolidTrainKind(q.userData.kind)) continue;
          var qd = effectiveTrainDepth(q);
          if (Math.abs(q.position.z - z) <= qd * 0.5 + 0.22) solid[q.userData.lane|0] = true;
        }
        if (solid[0] && solid[1] && solid[2]) { bad = true; break; }
      }
      if (bad) {
        // Prefer stripping approach first (keeps pattern readable)
        if (o.userData.approach) {
          o.userData.approach = 0;
          // re-check without approach
          var stillBad = false;
          var d2 = o.userData.depth != null ? o.userData.depth : occDepth(o.userData.kind);
          var a2 = o.position.z - d2 * 0.5 - 0.25;
          var b2 = o.position.z + d2 * 0.5 + 0.25;
          for (var si2 = 0; si2 <= samples; si2++) {
            var z2 = a2 + (b2 - a2) * (si2 / samples);
            var solid2 = [false, false, false];
            for (var sj2 = 0; sj2 < obstacles.length; sj2++) {
              var q2 = obstacles[sj2];
              if (!q2 || q2.userData.taken || q2.userData.roof) continue;
              if (!isSolidTrainKind(q2.userData.kind)) continue;
              var qd2 = effectiveTrainDepth(q2);
              if (Math.abs(q2.position.z - z2) <= qd2 * 0.5 + 0.22) solid2[q2.userData.lane|0] = true;
            }
            if (solid2[0] && solid2[1] && solid2[2]) { stillBad = true; break; }
          }
          if (!stillBad) continue;
        }
        var laneFix = o.userData.lane|0;
        var zz = o.position.z;
        propGroup.remove(o);
        obstacles.splice(oi, 1);
        if (!laneBlocked(laneFix, zz, occDepth('trainRoof'))) {
          makeObstacle('trainRoof', laneFix, zz);
        }
      }
    }
  }

  function spawnOnBeat(absoluteBeat, beatsAhead) {
    // Subway Surfers pattern language:
    // - always ≥1 safe lane (except rare tight mixes)
    // - classic: 2 trains / 1 open path
    // - classic: 3 trains with one climbable ramp car
    // - jump / roll / single train / powerups
    var z = zOnBeat(beatsAhead);
    // absoluteBeat MUST stay a real beat index (not sessionSeed+beat) so
    // gates like absoluteBeat > 14 and phrase progression work.
    // sessionSeed only salts the RNG so each run differs.
    var phrase = (absoluteBeat / 32) | 0;
    var salt = (sessionSeed | 0) ^ ((absoluteBeat * 2654435761) >>> 0);
    var r = (((salt * 1103515245 + 12345) >>> 0) % 1000) / 1000;
    // dens ramps faster so long/ramp cars appear within the first stretch
    var dens = Math.min(1, 0.12 + dist / 220);
    if (activeStage === 2) dens = Math.min(1, dens + 0.1); // 150 BPM: keep pack density
    // Pick a safe-lane bias that gradually moves left/right, as in SS lane
    // weaving. The director also prevents the exact same pattern bucket from
    // repeating three times in a row.
    var laneWave = Math.floor(absoluteBeat / 8) % 4;
    var waveLane = [0, 1, 2, 1][laneWave];
    var prefer = (waveLane + Math.floor(phrase * 0.5)) % 3;
    if (lastPatternBucket >= 0) {
      var bucket = Math.min(8, Math.floor(r * 9));
      if (bucket === lastPatternBucket) {
        r = (r + 0.17 + (absoluteBeat % 3) * 0.031) % 1;
        bucket = Math.min(8, Math.floor(r * 9));
      }
      if (bucket === lastPatternBucket) {
        r = (r + 0.23) % 1;
      }
    }
    var directorBucket = Math.min(8, Math.floor(r * 9));
    lastPatternBucket = directorBucket;

    // === ROOF HIGHWAY (~8%): ramp lead + flat cars, optional side solid for roof-jumps ===
    if (r < 0.08 && absoluteBeat > 12) {
      var hz = zOnBeat(beatsAhead);
      var hLane = (prefer != null && !laneBlocked(prefer, hz, occDepth('trainRoofLong'))) ? prefer : pickFreeLane(hz, occDepth('trainRoofLong'));
      if (hLane >= 0) {
        var nFollow = 1 + ((absoluteBeat + (sessionSeed & 3)) % 3); // 1..3 flats
        var hKinds = ['trainRoof'];
        for (var hi = 0; hi < nFollow; hi++) {
          hKinds.push(beatRand(absoluteBeat, 50 + hi) < 0.4 ? 'trainMega' : 'trainLong');
        }
        if (placeConsist(hLane, hz, hKinds)) {
          var hTotal = 0;
          for (var hk = 0; hk < hKinds.length; hk++) hTotal += CONSIST_D[hKinds[hk]];
          for (var hc = 3.2; hc < hTotal - 1; hc += 2.2) makeCoin(hLane, hz - hc, H_ROOF + 0.35);
          // parallel solid for roof-to-roof jumps (not always)
          if (beatRand(absoluteBeat, 77) < 0.55) {
            var sideL = (hLane + 1 + ((sessionSeed >> 2) & 1)) % 3;
            if (sideL === hLane) sideL = (hLane + 2) % 3;
            var sKinds = recipeConsist(false, Math.max(dens, 0.3), absoluteBeat, 88);
            // force no ramp on side
            for (var si = 0; si < sKinds.length; si++) {
              if (String(sKinds[si]).indexOf('Roof') >= 0) sKinds[si] = 'trainLong';
            }
            if (placeConsist(sideL, hz - 1.5, sKinds)) {
              for (var cj = 0; cj < 5; cj++) makeCoin(sideL, hz - 1.5 - 3 - cj * 2.2, H_ROOF + 0.35);
            }
          }
          safeLaneHint = (hLane + 2) % 3;
          return;
        }
      }
    }

    patternStreak = patternStreak + 1;
    var L, d, i, skip, zz;

    function freeLane(zz, depth, preferL, kind) {
      if (preferL != null && !laneBlocked(preferL, zz, depth, kind)) return preferL;
      return pickFreeLane(zz, depth, preferL, kind);
    }
    function coinsOnLane(laneIdx, startAhead, count, yH) {
      for (var c = 0; c < count; c++) {
        var cz = zOnBeat(startAhead + c * 0.42);
        if (!laneBlocked(laneIdx, cz, occDepth('coin')))
          makeCoin(laneIdx, cz, yH || H_COIN_GROUND);
      }
    }
    function coinsSafeExcept(blockedLane, startAhead, count) {
      for (var a = 0; a < 3; a++) {
        if (a === blockedLane) continue;
        coinsOnLane(a, startAhead, count, H_COIN_GROUND);
      }
    }
    function recentlyRolled(laneIdx, beat) {
      // after a slide-bar, standing trains on same lanes for ~4 beats = unfair death mid-slide
      return beat - lastRollBeat < 8 && lastRollLanes.indexOf(laneIdx) >= 0;
    }
    function placeTrain(laneIdx, zz, climbable) {
      if (recentlyRolled(laneIdx, absoluteBeat)) return false;
      if (trainTooSoonAfterCommit(zz)) return false;
      var densL = (typeof dens !== 'undefined') ? dens : 0.15;
      // Stage 2 (150 BPM): slightly denser consists so the faster beat spacing still feels full
      if (activeStage === 2) densL = Math.min(1, densL + 0.1);
      var kinds = recipeConsist(!!climbable, densL, absoluteBeat, laneIdx * 13 + (climbable ? 99 : 0));
      var total = 0;
      for (var ki = 0; ki < kinds.length; ki++) total += (CONSIST_D[kinds[ki]] || 4.6);
      // For single-car, zz is the car center. For multi-car consist, treat zz as front tip.
      var zFront = zz + total * 0.5;
      if (!climbable && wouldCreateTrainWall(laneIdx, zz, total)) return false;
      if (laneBlocked(laneIdx, zz, total, kinds[0])) return false;
      if (kinds.length === 1) {
        if (wouldCreateTrainWall(laneIdx, zz, occDepth(kinds[0]))) return false;
        makeObstacle(kinds[0], laneIdx, zz, { noApproach: climbable });
        return true;
      }
      return placeConsist(laneIdx, zFront, kinds);
    }

    // HARD RULE: never leave 3 solid walls at the same Z (inescapable death)
    function laneHasSolidAt(zz, laneIdx) {
      var depth = 5;
      for (var oi = 0; oi < obstacles.length; oi++) {
        var o = obstacles[oi];
        if (o.userData.lane !== laneIdx) continue;
        if (o.userData.roof) continue; // climbable = escape
        var od = o.userData.depth || 2;
        if (Math.abs(o.position.z - zz) < (od * 0.5 + depth * 0.5) * 0.85) return true;
      }
      return false;
    }
    function ensureEscapeLane(zz, preferredOpen) {
      var solid = [
        laneHasSolidAt(zz, 0),
        laneHasSolidAt(zz, 1),
        laneHasSolidAt(zz, 2)
      ];
      if (!(solid[0] && solid[1] && solid[2])) {
        stripApproachOnEscapeLane(preferredOpen, zz, 10);
        return preferredOpen;
      }
      // all solid — convert preferred lane: remove solids on it, place roof
      for (var oi = obstacles.length - 1; oi >= 0; oi--) {
        var o = obstacles[oi];
        if (o.userData.lane === preferredOpen && Math.abs(o.position.z - zz) < 6) {
          propGroup.remove(o);
          obstacles.splice(oi, 1);
        }
      }
      makeObstacle('trainRoof', preferredOpen, zz);
      return preferredOpen;
    }
    // Kill approach on the only open path so a moving middle train can't seal L+R walls
    function stripApproachOnEscapeLane(escapeLane, zz, radius) {
      radius = radius || 10;
      for (var oi = 0; oi < obstacles.length; oi++) {
        var o = obstacles[oi];
        if (!o || o.userData.taken) continue;
        if ((o.userData.lane|0) !== (escapeLane|0)) continue;
        if (!o.userData.approach) continue;
        if (Math.abs(o.position.z - zz) > radius) continue;
        o.userData.approach = 0;
      }
    }

    // Breather: common early, rare late
    var breathP = 0.12 - dens * 0.03;
    if (r < breathP) {
      coinsOnLane(prefer, beatsAhead, 4, H_COIN_GROUND);
      coinsOnLane((prefer + 1) % 3, beatsAhead + 0.3, 2, H_COIN_GROUND);
      return;
    }
    r = (r - breathP) / (1 - breathP);

    // After a committed roll, give the player recovery time before another
    // major train commitment can appear. This prevents slide -> instant train
    // wall sequences that are impossible in practice.
    if (lastCommitObstacleBeat >= 0 && absoluteBeat - lastCommitObstacleBeat <= 2) {
      r = 0.65;
    }

    // === SS CLASSIC: 2 trains, 1 ALWAYS open (~18%) ===
    // ~35% of these: one wall is climbable ramp (SS-readable ladder car)
    if (r < 0.14) {
      skip = prefer;
      safeLaneHint = skip;
      zz = z;
      var makeOneRamp = beatRand(absoluteBeat, 3) < 0.42;
      var rampSide = (skip + 1) % 3;
      for (i = 0; i < 3; i++) {
        if (i === skip) continue;
        placeTrain(i, zz, makeOneRamp && i === rampSide);
      }
      coinsOnLane(skip, beatsAhead, 5, H_COIN_GROUND);
      ensureEscapeLane(zz, skip);
      stripApproachOnEscapeLane(skip, zz, 10);
      return;
    }

    // === SS: 2 solid + 1 climbable ramp (~18%) — more frequent ===
    if (r < 0.26) {
      var climbLane = prefer;
      safeLaneHint = climbLane;
      zz = z;
      for (i = 0; i < 3; i++) {
        if (i === climbLane) placeTrain(i, zz, true);
        else placeTrain(i, zz, false);
      }
      ensureEscapeLane(zz, climbLane);
      for (i = 0; i < 6; i++) {
        var u = i / 5;
        makeCoin(climbLane, zOnBeat(beatsAhead - 0.1 + i * 0.38), 0.3 + u * (H_ROOF + 0.2));
      }
      return;
    }

    // === SS CONVOY: long solid train rows, 1 lane always free (~10%) ===
    if (r < 0.28 && absoluteBeat > 16) {
      var freeC = prefer != null ? prefer : (absoluteBeat % 3);
      // pick two lanes for convoy walls (or one mega wall)
      var lanesWall = [];
      for (var li = 0; li < 3; li++) if (li !== freeC) lanesWall.push(li);
      var mega = dens > 0.35 && (absoluteBeat % 5 === 0);
      var cars = mega ? 3 : (2 + (absoluteBeat % 2)); // 2..3 joined cars per wall lane
      for (var wi = 0; wi < lanesWall.length; wi++) {
        // sometimes only one wall lane gets the full convoy (easier read)
        if (!mega && wi === 1 && (absoluteBeat % 2 === 0)) continue;
        var wL = lanesWall[wi];
        var cKinds = [];
        for (var ci = 0; ci < cars; ci++) cKinds.push(cars >= 3 ? 'trainMega' : 'trainLong');
        // rare climb escape: the lead car has stairs
        if (dens > 0.4 && wi === 0 && beatRand(absoluteBeat, 19) < 0.28) cKinds[0] = 'trainRoofLong';
        var cTotal = 0;
        for (var ck = 0; ck < cKinds.length; ck++) cTotal += CONSIST_D[cKinds[ck]];
        if (cKinds[0].indexOf('Roof') < 0 && wouldCreateTrainWall(wL, z - cTotal * 0.5, cTotal)) continue;
        placeConsist(wL, z, cKinds);
      }
      // free path coin line
      coinsOnLane(freeC, beatsAhead, 6 + cars, H_COIN_GROUND);
      // mid-run jump prop on free lane late in convoy to keep attention
      if (dens > 0.25) {
        var pz = zOnBeat(beatsAhead + cars * 1.2);
        var pk = groundPropKind(absoluteBeat + 13);
        if (!laneBlocked(freeC, pz, occDepth(pk), pk)) makeObstacle(pk, freeC, pz);
      }
      safeLaneHint = freeC;
      repairImpossibleTrainWalls();
      stripApproachOnEscapeLane(freeC, z, 14);
      return;
    }

    // === Single train (~12%) ===
    if (r < 0.40) {
      zz = z;
      L = freeLane(zz, occDepth('train'), prefer);
      if (L < 0) return;
      safeLaneHint = (L + 1 + (absoluteBeat % 2)) % 3;
      var climb1 = dens > 0.08 && (phrase % 2 === 0 || Math.random() < 0.42);
      var long1 = !climb1 && dens > 0.4 && (phrase % 5 === 2);
      if (long1) {
        if (!laneBlocked(L, zz, occDepth('trainLong'))) makeObstacle('trainLong', L, zz);
        coinsSafeExcept(L, beatsAhead, 4);
        return;
      }
      placeTrain(L, zz, climb1);
      // SS ground clutter beside the train path
      if (!climb1 && dens > 0.12 && (absoluteBeat % 3 === 1)) {
        var clutterLane = (L + 1 + (absoluteBeat % 2)) % 3;
        if (clutterLane !== L) {
          var ck2 = groundPropKind(absoluteBeat + 11);
          var cz2 = zOnBeat(beatsAhead + 1.2);
          if (!laneBlocked(clutterLane, cz2, occDepth(ck2))) makeObstacle(ck2, clutterLane, cz2);
        }
      }
      // A short follow-up obstacle one beat later creates the familiar SS weave
      // without turning the track into a wall: the adjacent lane remains open.
      if (!climb1 && dens > 0.18 && (absoluteBeat % 4 === 0)) {
        var followLane = (L + (absoluteBeat % 2 ? 1 : 2)) % 3;
        var followZ = zOnBeat(beatsAhead + 1.0);
        var followKind = (absoluteBeat % 8 === 0) ? 'box' : 'cone';
        if (!laneBlocked(followLane, followZ, occDepth(followKind))) {
          makeObstacle(followKind, followLane, followZ);
          safeLaneHint = (followLane + 1) % 3;
        }
      }
      if (climb1) {
        for (i = 0; i < 5; i++) {
          var u1 = i / 4;
          makeCoin(L, zOnBeat(beatsAhead + i * 0.35), 0.3 + u1 * (H_ROOF + 0.2));
        }
      } else {
        coinsSafeExcept(L, beatsAhead, 4);
      }
      return;
    }

    // === SS GATE: walls left+right, free middle with coin line (~5%) ===
    if (r < 0.44) {
      zz = z;
      var mid = 1;
      // outer lanes blocked by jump props / trains
      var leftK = dens > 0.4 ? 'train' : groundPropKind(absoluteBeat);
      var rightK = dens > 0.4 ? 'train' : groundPropKind(absoluteBeat + 3);
      if (!laneBlocked(0, zz, occDepth(leftK), leftK)) makeObstacle(leftK, 0, zz);
      if (!laneBlocked(2, zz, occDepth(rightK), rightK)) makeObstacle(rightK, 2, zz);
      // middle is free path with coin line
      coinsOnLane(mid, beatsAhead, 5, H_COIN_GROUND);
      // follow-up jump one beat later on a side lane
      if (dens > 0.2) {
        var side = (absoluteBeat % 2 === 0) ? 0 : 2;
        var fz = zOnBeat(beatsAhead + 1.6);
        var fk = groundPropKind(absoluteBeat + 9);
        if (!laneBlocked(side, fz, occDepth(fk), fk)) makeObstacle(fk, side, fz);
      }
      safeLaneHint = mid;
      return;
    }

    // === SS WEAVE: staggered props forcing lane swaps (~5%) ===
    if (r < 0.50) {
      zz = z;
      var w0 = groundPropKind(absoluteBeat);
      var w1 = groundPropKind(absoluteBeat + 2);
      var w2 = groundPropKind(absoluteBeat + 4);
      // beat 0: block prefer lane
      L = prefer;
      if (!laneBlocked(L, zz, occDepth(w0), w0)) makeObstacle(w0, L, zz);
      // beat +1.2: block adjacent
      var L2 = (L + 1) % 3;
      var z2 = zOnBeat(beatsAhead + 1.2);
      if (!laneBlocked(L2, z2, occDepth(w1), w1)) makeObstacle(w1, L2, z2);
      // beat +2.4: block other adjacent — forces weave
      var L3 = (L + 2) % 3;
      var z3 = zOnBeat(beatsAhead + 2.4);
      if (!laneBlocked(L3, z3, occDepth(w2), w2)) makeObstacle(w2, L3, z3);
      coinsOnLane((L + 1) % 3, beatsAhead + 0.4, 3, H_COIN_ARC);
      return;
    }

    // === GROUND CLUTTER (~4%): SS bushes / pillars / curbs ===
    if (r < 0.60) {
      zz = z;
      var g1 = groundPropKind(absoluteBeat);
      L = freeLane(zz, occDepth(g1), prefer, g1);
      if (L < 0) return;
      if (laneBlocked(L, zz, occDepth(g1), g1)) return;
      makeObstacle(g1, L, zz);
      // often a second prop on another lane — weave like SS
      if (dens > 0.15) {
        var L3 = (L + 1 + (phrase % 2)) % 3;
        var g2 = groundPropKind(absoluteBeat + 5);
        var z2 = zOnBeat(beatsAhead + 1.5);
        if (L3 !== L && !laneBlocked(L3, z2, occDepth(g2), g2)) makeObstacle(g2, L3, z2);
      }
      coinsOnLane(L, beatsAhead, 2, H_COIN_ARC);
      return;
    }

    // === JUMP (~10%) ===
    if (r < 0.72) {
      // Keep a beat of setup before the jump: the coin arc starts slightly
      // early so the player reads the jump as an intentional route, not a
      // random hazard.
      var jk = ['box', 'barrier', 'cone', 'low', 'pillar', 'bush', 'curb'][(phrase + absoluteBeat) % 7];
      zz = z;
      L = freeLane(zz, occDepth(jk), prefer, jk);
      if (L < 0) return;
      if (laneBlocked(L, zz, occDepth(jk), jk)) return;
      makeObstacle(jk, L, zz);
      // late game: second jump on adjacent lane
      if (dens > 0.5 && jk !== 'barrier') {
        var L2 = (L + 1) % 3;
        var k2 = ['cone', 'box', 'bush', 'curb'][(absoluteBeat >> 1) % 4];
        if (!laneBlocked(L2, zz, occDepth(k2))) makeObstacle(k2, L2, zz);
      }
      spawnCoinArc(L, zz, beatDistUnits() * 1.45, H_COIN_ARC, 7);
      return;
    }

    // === ROLL under (~10%) ===
    if (r < 0.82) {
      var rk = 'high';
      zz = z;
      L = freeLane(zz, occDepth(rk), prefer, rk);
      if (L < 0) return;
      if (laneBlocked(L, zz, occDepth(rk), rk)) return;
      makeObstacle(rk, L, zz);
      lastRollBeat = absoluteBeat;
      lastRollLanes = [L];
      lastCommitObstacleBeat = absoluteBeat;
      lastCommitObstacleKind = rk;
      lastCommitObstacleZ = zz;
      // Single roll-under bar only — spawning a second one in another lane
      // at once was the duplicate/buggy "two bars" case, so that's removed.
      coinsOnLane((L + 1) % 3, beatsAhead, 3, H_COIN_GROUND);
      return;
    }

    // === Mixed: jump + roll same lane sequence (~6%) ===
    if (r < 0.89) {
      L = prefer;
      zz = z;
      if (!laneBlocked(L, zz, occDepth('box'))) makeObstacle('box', L, zz);
      var zr = zOnBeat(beatsAhead + 2);
      if (!laneBlocked(L, zr, occDepth('high'), 'high')) makeObstacle('high', L, zr);
      // A second route in the adjacent lane creates the familiar SS weave:
      // the player can stay, jump/roll, or immediately switch away.
      var weaveLane = (L + 1) % 3;
      var wz = zOnBeat(beatsAhead + 1.0);
      if (dist > 120 && !laneBlocked(weaveLane, wz, occDepth('cone'))) {
        makeObstacle('cone', weaveLane, wz);
      }
      coinsOnLane((L + 1) % 3, beatsAhead, 3, H_COIN_GROUND);
      safeLaneHint = (L + 2) % 3;
      return;
    }

    // === POWERUP (~6%) ===
    if (r < 0.93) {
      var kinds = ['magnet', 'board', 'x2', 'jump', 'jet', 'board', 'magnet'];
      var pk = kinds[(phrase + absoluteBeat) % kinds.length];
      L = freeLane(z, 1.0, prefer);
      if (L < 0) L = prefer;
      makePowerup(pk, L, z, 1.15);
      coinsOnLane(L, beatsAhead + 0.35, 3, H_COIN_GROUND);
      safeLaneHint = L;
      return;
    }

    // === BOOST (~4%) ===
    if (r < 0.97) {
      L = freeLane(z, occDepth('boost'), prefer);
      if (L < 0) return;
      makeBoost(L, z);
      coinsSafeExcept(L, beatsAhead + 0.25, 2);
      return;
    }

    // === Single climbable car fallback ===
    d = occDepth('trainRoof');
    L = freeLane(z, d, prefer);
    if (L < 0) return;
    makeObstacle('trainRoof', L, z);
    for (i = 0; i < 6; i++) {
      var u2 = i / 5;
      makeCoin(L, zOnBeat(beatsAhead - 0.1 + i * 0.38), 0.3 + u2 * (H_ROOF + 0.2));
    }
  }

  // Level-design cleanup: patterns are spawned independently (convoys, coin lines,
  // boosts, props...) so a later pattern could bury an earlier one inside a solid
  // train — coins/boosts/powerups you can never reach, props hidden in a carriage.
  // Remove anything that ended up inside a non-climbable train body.
  function sanitizeSpawns() {
    // Hard rule: nothing (bars, boxes, cones…) inside any train hull
    scrubPropsInsideTrains(1.35);
    var bodies = [];
    var i, j, o, b;
    for (i = 0; i < obstacles.length; i++) {
      o = obstacles[i];
      // ALL trains (solid + climbable) occupy a volume
      if (o && isTrainKind(o.userData.kind)) bodies.push(o);
    }
    if (!bodies.length) return;
    function inside(lane, z, y, pad, maxY) {
      for (var k = 0; k < bodies.length; k++) {
        var bb = bodies[k];
        if ((bb.userData.lane | 0) !== (lane | 0)) continue;
        var bd = trainHalfDepth(bb) * 2;
        var idz = z - bb.position.z;
        if (Math.abs(idz) >= bd * 0.5 + pad && !(idz > 0 && idz < bd * 0.5 + pad + sweepExtra(bb, z))) continue;
        if (y < (bb.userData.roofH || H_ROOF) - maxY) return true;
      }
      return false;
    }
    // props buried in a train (any Z — do not skip near-field)
    for (i = obstacles.length - 1; i >= 0; i--) {
      o = obstacles[i];
      if (!o || isTrainKind(o.userData.kind)) continue;
      var ok = o.userData.kind || '';
      if (!PROP_KINDS_NO_TRAIN[ok]) continue;
      var od = o.userData.depth != null ? o.userData.depth : occDepth(ok);
      for (j = 0; j < bodies.length; j++) {
        b = bodies[j];
        if ((b.userData.lane | 0) !== (o.userData.lane | 0)) continue;
        var sdz = o.position.z - b.position.z;
        if (Math.abs(sdz) < trainHalfDepth(b) + od * 0.5 + 1.1 ||
            (sdz > 0 && sdz < trainHalfDepth(b) + od * 0.5 + 1.1 + sweepExtra(b, o.position.z))) {
          try { propGroup.remove(o); } catch (eS) {}
          try { disposeTree(o); } catch (eSd) {}
          obstacles.splice(i, 1);
          break;
        }
      }
    }
    // coins below roof height inside a body
    for (i = pickups.length - 1; i >= 0; i--) {
      var c = pickups[i];
      if (c.position.z > -12) continue;
      if (inside(c.userData.lane, c.position.z, c.position.y, 0.25, 0.05)) {
        propGroup.remove(c);
        pickups.splice(i, 1);
      }
    }
    // climbable cars: the coin line is longer than the 2.6u ramp, so coins past the
    // ramp ended up sunk inside the car body — lift them onto the roof deck instead
    for (i = 0; i < pickups.length; i++) {
      var pc = pickups[i];
      if (pc.position.z > -12) continue;
      for (j = 0; j < obstacles.length; j++) {
        o = obstacles[j];
        if (!o.userData.roof || (o.userData.lane | 0) !== (pc.userData.lane | 0)) continue;
        var rh = o.userData.roofH || H_ROOF;
        var hf = (o.userData.depth != null ? o.userData.depth : occDepth(o.userData.kind)) * 0.5;
        var lz = pc.position.z - o.position.z;
        if (Math.abs(lz) < hf + 0.2 && lz < hf - (o.userData.rampLen || RAMP_LEN) - 0.2 && pc.position.y < rh - 0.25) {
          pc.position.y = rh + 0.35;
        }
      }
    }
    // a moving (approaching) train would drive through another train in its lane
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (!b.userData.approach) continue;
      for (j = 0; j < bodies.length; j++) {
        if (i === j || (bodies[j].userData.lane | 0) !== (b.userData.lane | 0)) continue;
        if (Math.abs(bodies[j].position.z - b.position.z) < 45) { b.userData.approach = 0; break; }
      }
    }
    // moving trains overrun the coins/pads ahead of them in their own lane
    for (i = 0; i < bodies.length; i++) {
      b = bodies[i];
      if (!b.userData.approach) continue;
      var reach = (b.userData.depth || 5) * 0.5 + Math.max(30, sweepExtra(b, -60));
      var bl = b.userData.lane | 0;
      for (j = pickups.length - 1; j >= 0; j--) {
        var qc = pickups[j];
        if ((qc.userData.lane | 0) === bl && qc.position.y < (b.userData.roofH || H_ROOF) - 0.25 &&
            qc.position.z > b.position.z - 1 && qc.position.z < b.position.z + reach && qc.position.z < -12) {
          propGroup.remove(qc);
          pickups.splice(j, 1);
        }
      }
    }
    // boost pads / powerups inside a body
    for (i = boosts.length - 1; i >= 0; i--) {
      if (boosts[i].position.z > -12) continue;
      if (inside(boosts[i].userData.lane, boosts[i].position.z, 0.1, 0.8, 0.25)) {
        propGroup.remove(boosts[i]);
        boosts.splice(i, 1);
      }
    }
    for (i = powerups.length - 1; i >= 0; i--) {
      if (powerups[i].position.z > -12) continue;
      if (inside(powerups[i].userData.lane, powerups[i].position.z, powerups[i].userData.y || 1.1, 0.8, 0.25)) {
        propGroup.remove(powerups[i]);
        powerups.splice(i, 1);
      }
    }
  }

    function togglePause() {
    if (!running || gameOver) return;
    paused = !paused;
    if (el.pause) {
      el.pause.classList.toggle('hidden', !paused);
      el.pause.style.pointerEvents = paused ? 'auto' : '';
      el.pause.style.zIndex = paused ? '60' : '';
    }
    if (el.touch) el.touch.style.pointerEvents = paused ? 'none' : '';
    if (paused) {
      try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
      duckGameMusic(true);
      startAmbient('pause');
    } else {
      try { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); } catch (e) {}
      stopAmbient();
      duckGameMusic(false);
      // restore live volumes from updateMusic targets
      if (musicStarted && gainRun) {
        try {
          var now = audioCtx.currentTime;
          gainRun.gain.linearRampToValueAtTime(Math.max(0.0001, volRun), now + 0.25);
          if (gainBoost) gainBoost.gain.linearRampToValueAtTime(Math.max(0.0001, volBoost), now + 0.25);
        } catch (e2) {}
      } else if (!musicStarted) {
        startAmbient('menu');
      }
    }
  }

  function exitToMenu() {
    levelBannerT = 0;
    if (el.levelBanner) { el.levelBanner.classList.remove('show'); el.levelBanner.classList.add('hidden'); }
    refreshMenuLocks();
    paused = false;
    running = false;
    gameOver = false;
    if (el.pause) el.pause.classList.add('hidden');
    el.hud.classList.add('hidden');
    el.touch.classList.add('hidden');
    el.warn.classList.add('hidden');
    if (el.powers) el.powers.classList.add('hidden');
    if (el.meterWrap) el.meterWrap.classList.add('hidden');
    el.over.classList.add('hidden');
    el.title.classList.remove('hidden');
    stopMusic();
    startAmbient('menu');
    document.body.classList.remove('monkey-mode');
    // don't leave the dead run (frozen trains, coins, ragdoll) behind the menu
    while (obstacles.length) propGroup.remove(obstacles.pop());
    while (pickups.length) propGroup.remove(pickups.pop());
    while (boosts.length) propGroup.remove(boosts.pop());
    while (powerups.length) propGroup.remove(powerups.pop());
    clearRagdoll();
    clearMinderFx();
    dying = false;
    if (gleb) {
      gleb.visible = true;
      gleb.scale.set(1, 1, 1);
      gleb.rotation.set(0, 0, 0);
      gleb.position.set(0, 0, 2);
    }
    el.warn.classList.add('hidden');
    document.body.classList.remove('danger-close');
  }

    function onKey(e) {
    if (e.repeat) return;
    // prevent page scroll from arrows/space while playing
    if (running && !paused && (
      e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'ArrowLeft' || e.code === 'ArrowRight' ||
      e.code === 'Space' || e.code === 'KeyW' || e.code === 'KeyA' || e.code === 'KeyS' || e.code === 'KeyD'
    )) {
      e.preventDefault();
    }
    if (e.code === 'KeyX' || e.code === 'Escape') {
      if (running && !gameOver) togglePause();
      return;
    }
    if (paused) return;
    if (!running) {
      if (e.code === 'Space' || e.code === 'Enter') {
        var overOpen = el.over && !el.over.classList.contains('hidden');
        var titleOpen = el.title && !el.title.classList.contains('hidden');
        if (overOpen) {
          // retry same stage
          startGame(activeStage === 1 ? 1 : (activeStage === 3 ? 2 : 0));
        } else if (titleOpen) {
          // menu: start selected/unlocked default stage 1
          startGame(1);
        }
      }
      return;
    }
    if (keyHeld[e.code]) return;
    keyHeld[e.code] = true;
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') changeLane(-1);
    if (e.code === 'ArrowRight' || e.code === 'KeyD') changeLane(1);
    if (e.code === 'ArrowUp' || e.code === 'Space' || e.code === 'KeyW') jump();
    if (e.code === 'ArrowDown' || e.code === 'KeyS') slide();
    if (e.code === 'KeyE' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') activateMonkey();
  }

function onKeyUp(e) {
    keyHeld[e.code] = false;
  }


  function changeLane(dir) {
    if (dying || gameOver || paused || !running) return;
    var next = Math.max(0, Math.min(2, lane + dir));
    if (next === lane) return;
    // Prevent accidental double-swipes from teleporting through two lanes in
    // one frame, but allow a rapid second input after a very short lock —
    // close to the feel of real swipe controls.
    if (laneInputLock > 0) return;
    laneInputLock = 0.055;
    lane = next;
    sfxLane();
    // SS scrape: only if train is RIGHT in front in the new lane (not far ahead)
    if (!onRoof && pwr.jet <= 0 && !sliding) {
      for (var si = 0; si < obstacles.length; si++) {
        var so = obstacles[si];
        if (!so || so.userData.taken) continue;
        var sk = so.userData.kind || '';
        if (sk.indexOf('train') !== 0) continue;
        if ((so.userData.lane | 0) !== next) continue;
        // skip climbable if we can board
        if (so.userData.roof) continue;
        var dzTrain = so.position.z - gleb.position.z;
        var halfT = (so.userData.depth || 4) * 0.5;
        // only body overlap or ≤1.1 units ahead — was halfT+3.2 (ghost slows)
        if (dzTrain < halfT + 1.1 && dzTrain > -halfT * 0.4) {
          laneSlowT = Math.max(laneSlowT, 0.32);
          if (typeof shake !== 'undefined') shake = Math.max(shake || 0, 0.12);
          if (typeof sfxTone === 'function') {
            try { sfxTone(140, 0.08, { type: 'square', slideTo: 70, gain: 0.05 }); } catch (e) {}
          }
          break;
        }
      }
    }
    actionStreak = Math.min(12, actionStreak + 1);
    actionStreakT = 1.8;
    laneSwitchStreak = Math.min(6, laneSwitchStreak + 1);
    lastLaneSwitchT = 1.15;
    // Pull most of the way immediately, then let the regular lerp finish it.
    // lane glide is handled in the main update lerp only (no hard snap)
    beatBonusCheck();
    if (laneSwitchStreak >= 2 && nearMissCd <= 0) {
      score += 8 * Math.max(1, Math.floor(combo));
      combo = Math.min(9, combo + 0.08);
    }
  }

  function doJump() {
    if (sliding) {
      sliding = false;
      slideT = 0;
    }
    var jv = JUMP_V;
    if (pwr.jump > 0) jv *= JUMP_PWR_MULT;
    if (pwr.jet > 0) jv *= JET_JUMP_MULT;
    vy = jv;
    y = Math.max(y, 0.02);
    wasAirborne = true;
    if (onRoof) roofGrace = Math.max(roofGrace, 0.55);
    onRoof = false;
    coyoteT = 0;
    jumpBufferT = 0;
    sfxJump();
    actionStreak = Math.min(12, actionStreak + 1);
    actionStreakT = 1.8;
    beatBonusCheck();
  }

  function jump() {
    if (pwr.jet > 0) return; // flying — no hop
    if (dying || gameOver || paused) return;
    // cancel ground slide into jump (SS: leave roll with up)
    if (sliding && y <= 0.4) {
      doJump();
      return;
    }
    var grounded = (y <= 0.14 || onRoof || coyoteT > 0) && !sliding;
    if (grounded) doJump();
    else jumpBufferT = 0.18; // early press buffer (covers short rolls)
  }

  function slide() {
    if (pwr.jet > 0 || dying || gameOver || paused) return;
    // Subway Surfers jump-cancel: down in air = fast drop + roll
    if (y > 0.45 || vy > 0.4) {
      sliding = true;
      slideT = SLIDE_T;
      vy = Math.min(vy, -14);
      if (onRoof && y > H_ROOF + 0.15) {
        onRoof = false;
        roofGrace = 0;
      }
      sfxSlide();
      actionStreak = Math.min(12, actionStreak + 1);
      actionStreakT = 1.8;
      beatBonusCheck();
      return;
    }
    if (onRoof) return; // standing on deck — no roll under the train
    sliding = true;
    slideT = SLIDE_T;
    vy = Math.min(vy, 0);
    y = Math.min(y, 0.2);
    sfxSlide();
    actionStreak = Math.min(12, actionStreak + 1);
    actionStreakT = 1.8;
    beatBonusCheck();
  }

  function setupTouch() {
    var x0 = 0, y0 = 0, fired = false;
    var zone = el.touch;
    if (!zone) return;
    function swipe(tch) {
      var dx = tch.clientX - x0;
      var dy = tch.clientY - y0;
      var adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) < 24) return false;
      if (adx > ady) changeLane(dx > 0 ? 1 : -1);
      else if (dy < 0) jump();
      else slide();
      return true;
    }
    zone.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0];
      x0 = t.clientX;
      y0 = t.clientY;
      fired = false;
    }, { passive: true });
    // Fire the moment the finger has travelled far enough (like Subway Surfers)
    // instead of waiting for it to lift — swipes felt ~100ms late.
    zone.addEventListener('touchmove', function (e) {
      if (fired || !running || paused || dying || gameOver) return;
      if (swipe(e.changedTouches[0])) fired = true;
    }, { passive: true });
    zone.addEventListener('touchend', function (e) {
      if (fired || !running || paused || dying || gameOver) return;
      swipe(e.changedTouches[0]);
    }, { passive: true });
  }

  // Shared height rule for roof-type obstacles (trainRoof / roofBridge):
  // one function, used by BOTH collide() and tryBoardRoof(), so there is
  // no gap between "high enough to not crash" and "high enough to land".
  // Previously tryBoardRoof used a flat 0.55 threshold while collide()
  // used a separate power-aware formula — with jump/jet active, collide()
  // let you through at a lower height than tryBoardRoof required to land
  // on, so the player would fly straight through the solid mesh: no
  // crash, no landing, just clipping through it.
  function roofSupportY(o) {
    if (!o) return null;
    var ud = o.userData;
    var roofH = ud.roofH || H_ROOF;
    // Climbable cars always; solid tops only during an active roof-run (not a high jump from ground)
    var solidTop = ud.solidRoof && y >= roofH * 0.7 && y <= roofH + 0.55 && (onRoof || roofGrace > 0.08 || pwr.jet > 0);
    if (!ud.roof && !solidTop) return null;
    var laneOk = (ud.lane === lane) || (Math.abs(laneX - LANES[ud.lane]) < 1.35);
    if (!laneOk) return null;
    var depth = ud.depth || 5;
    var half = depth * 0.5;
    // Climbable ramps use rampLen; solid tops have no ramp
    var rampLen = ud.roof ? (ud.rampLen || RAMP_LEN) : 0;
    var localZ = gleb.position.z - o.position.z;
    // Tight bounds — no giant invisible pads between distant cars
    if (localZ > half + 0.9 || localZ < -half - 0.45) return null;
    if (rampLen > 0 && localZ >= half - rampLen - 0.15 && localZ <= half + 0.9) {
      var tt = (half - localZ) / rampLen;
      if (tt < 0) tt = 0;
      if (tt > 1) tt = 1;
      return Math.min(roofH, Math.max(0.3, tt * roofH));
    }
    // On the flat deck only
    if (Math.abs(localZ) <= half + 0.35) return roofH;
    return null;
  }


  // Functional ladder access. It is intentionally forgiving: if the player
  // is on the same lane, grounded, and reaches either visible ladder, the
  // game mounts them to the roof instead of routing through the solid-body
  // crash check. This makes the visual affordance truthful.
  function ladderProgress(o) {
    if (!o.userData.roof || o.userData.ladderFrontZ == null) return -1;
    var localZ = gleb.position.z - o.position.z;
    var candidates = [o.userData.ladderFrontZ, o.userData.ladderBackZ];
    var best = Infinity;
    for (var li = 0; li < candidates.length; li++) {
      if (candidates[li] == null) continue;
      best = Math.min(best, Math.abs(localZ - candidates[li]));
    }
    return best <= (o.userData.ladderHalfZ || 0.72) ? best : -1;
  }

  // Local Z: player relative to obstacle center. Leading edge (hits you first) = +half.
  function rampProgress(o) {
    if (!o.userData.roof || !o.userData.rampLen) return -1;
    var depth = o.userData.depth || 5;
    var half = depth * 0.5;
    var rampLen = o.userData.rampLen;
    var localZ = gleb.position.z - o.position.z;
    // Start boarding slightly before the visible ramp reaches the player's
    // feet. The obstacle sweep has to look ahead by roughly the player's
    // body depth; without this lead-in the collision test can kill the player
    // while they are visibly standing just in front of the stairs.
    if (localZ > half + 0.7) return -1;
    if (localZ < half - rampLen - 0.25) return -1;
    var t = (half - localZ) / rampLen;
    if (t < 0) t = 0;
    if (t > 1) t = 1;
    return t;
  }

  // A forgiving boarding window around the foot of the stairs/ramp. This is
  // intentionally separate from ladderProgress(): the visible staircase is
  // centered on the lane and should be usable even when the exact side ladder
  // mesh is not under the character's feet.
  // Front entry is the primary climb route. Keep it independent from the
  // decorative ladder meshes so geometry changes can never make a climbable
  // train lethal again.
  function applyRampRide(o) {
    var t = rampProgress(o);
    if (t < 0) return false;
    var roofH = o.userData.roofH || H_ROOF;
    y = t * roofH;
    vy = 0;
    sliding = false;
    if (t >= 0.85) {
      onRoof = true;
      roofGrace = 0.55;
      y = roofH;
    }
    return true;
  }

  function isFrontalObstacle(o) {
    // Frontal = still overlapping the front 2/3 of the volume (side = already past center)
    var depth = (o.userData && o.userData.depth != null)
      ? o.userData.depth
      : (occDepth(o.userData && o.userData.kind) || 1.2);
    var half = Math.max(0.4, depth * 0.5);
    var localZ = gleb.position.z - o.position.z;
    // past the rear third → side clip, not a lethal face-plant
    return localZ > -half * 0.55;
  }

  function sideBumpFrom(o) {
    // Only real train side-scrapes — not props (caused invisible slowdowns)
    var k = (o && o.userData && o.userData.kind) || '';
    if (k.indexOf('train') !== 0) return;
    if (onRoof || pwr.jet > 0 || monkeyTimer > 0) return;
    boostTimer = 0;
    laneSlowT = Math.max(laneSlowT, 0.28);
    if (typeof shake !== 'undefined') shake = Math.max(shake || 0, 0.15);
    if (typeof sfxTone === 'function') {
      try { sfxTone(180, 0.06, { type: 'square', slideTo: 90, gain: 0.05 }); } catch (e) {}
    }
    if (o.userData && typeof o.userData.lane === 'number') {
      var obs = o.userData.lane;
      if (lane === obs) {
        if (typeof prevLane === 'number' && prevLane !== obs) lane = prevLane;
        else if (obs < 2) lane = obs + 1;
        else lane = obs - 1;
      }
    } else if (typeof prevLane === 'number') {
      lane = prevLane;
    }
    invuln = Math.max(invuln, 0.18);
  }

  function collide(o) {
    var k = o && o.userData ? o.userData.kind : '';
    var known = k === 'box' || k === 'barrier' || k === 'cone' || k === 'low' ||
      k === 'fence' || k === 'high' || k === 'pillar' || k === 'bush' || k === 'curb' ||
      k === 'train' || k === 'trainLong' || k === 'trainMega' ||
      k === 'trainRoof' || k === 'trainRoofLong' || k === 'trainRoofMega';
    if (!known) return false;
    // Climbable cars are never a "body hit" — ramp/roof support handles them
    if (o.userData.roof) return false;

    if (o.userData.solidRoof) {
      // SS: ordinary jump NEVER clears a solid train from the ground.
      // Safe only when already on a roof-run (onRoof / roofGrace) or jet.
      var rh = o.userData.roofH || H_ROOF;
      var onDeck = y >= rh - 0.12 && y <= rh + 0.55 && vy <= 3.0;
      if (onDeck && (onRoof || roofGrace > 0.08 || pwr.jet > 0)) return false;
      return true;
    }

    // FIX: ground props (bars, fences, boxes...) can never hit a player who is
    // standing on / running along a train roof or ramp. Roof height (~1.73) used
    // to sit just under the bar top (~1.75-1.79), so an "invisible" bar inside the
    // train killed you on the roof.
    if (onRoof || roofGrace > 0 || roofContact || y >= H_ROOF - 0.25) return false;

    // Overhead bar / fence: slide under OR jump clear of the bar top
    if (o.userData.slideOk || o.userData.lowOnly) {
      if (sliding) return false;
      var barTop = (o.userData.h || H_BAR) * 0.92; // slightly under visual top
      if (pwr.jump > 0) barTop *= 0.85;
      // clear if feet above bar, or rising through the clear arc
      if (y > barTop) return false;
      if (vy > 3 && y > barTop * 0.7) return false;
      return true;
    }

    // Jumpable props (box, cone, pillar, bush, curb, low…)
    if (o.userData.jumpOk) {
      var h = o.userData.h || 1.0;
      // feet must clear ~40% of prop height (was 55% — felt sticky)
      var thr = h * (pwr.jump > 0 ? 0.28 : 0.40);
      if (y > thr) return false;
      if (vy > 4 && y > thr * 0.65) return false; // rising jump arc
      return true;
    }

    // Fallback solid
    return true;
  }

  // Height of the ramp's walkable surface at a given local-Z offset from
  // the obstacle's own center. Returns null when localZ is off the ramp
  // (i.e. not currently over the sloped section at all).
  function tryBoardRoof(o) {
    var can = o.userData.roof || (o.userData.solidRoof && (onRoof || roofGrace > 0.1));
    if (!can) return false;
    if (o.userData.roof && applyRampRide(o)) return true;
    var roofH = o.userData.roofH || H_ROOF;
    var depth = o.userData.depth || 5;
    var half = depth * 0.5;
    var localZ = gleb.position.z - o.position.z;
    // only board when near deck height (no sky platforms)
    if (Math.abs(localZ) <= half + 0.4 && y >= roofH * 0.75 && y <= roofH + 0.35) {
      onRoof = true;
      roofGrace = 0.5;
      y = roofH;
      vy = 0;
      return true;
    }
    return false;
  }

  function levelFromScore(s) {
    return 1 + Math.floor(Math.max(0, s) / LEVEL_SCORE);
  }
  // localStorage reads are synchronous (slow on phones) and this runs from the
  // per-frame HUD update, so keep a 1-second in-memory copy.
  var _unlockVal = 1, _unlockAt = -1e9;
  function getUnlocks() {
    var nowT = performance.now();
    if (nowT - _unlockAt < 1000) return _unlockVal;
    _unlockAt = nowT;
    try {
      var raw = localStorage.getItem(LS_UNLOCK);
      var n = raw ? parseInt(raw, 10) : 1;
      _unlockVal = isNaN(n) ? 1 : Math.max(1, Math.min(3, n));
    } catch (e) { _unlockVal = 1; }
    return _unlockVal;
  }
  function isUnlocked(stage) {
    return getUnlocks() >= stage;
  }
  function unlockStage(stage) {
    var cur = getUnlocks();
    if (stage <= cur) return;
    try { localStorage.setItem(LS_UNLOCK, String(stage)); } catch (e) {}
    _unlockAt = -1e9;
    if (stage === 3) {
      if (el.levelBannerText) el.levelBannerText.textContent = 'ТАЙНА';
      if (el.levelBannerSub) el.levelBannerSub.textContent = 'ДОСТУП РАЗРЕШЁН';
      if (el.levelBanner) {
        el.levelBanner.classList.remove('hidden');
        el.levelBanner.classList.add('show');
        levelBannerT = 2.4;
      }
      if (typeof showBeatFx === 'function') showBeatFx('УЗНАТЬ ТАЙНУ…', true);
      refreshMenuLocks();
      return;
    }
    showLevelBanner(stage);
    if (typeof showBeatFx === 'function') showBeatFx('ОТКРЫТ УРОВЕНЬ ' + stage, true);
  }
  function isArchiveSealed() {
    try { return localStorage.getItem(LS_SEALED) === '1'; } catch (e) { return false; }
  }
  function sealForever() {
    try { localStorage.setItem(LS_SEALED, '1'); } catch (e) {}
    running = false;
    paused = false;
    gameOver = true;
    try { stopMusic(); } catch (e2) {}
    try { stopAmbient(); } catch (eAmb) {}
    try { billAudioStop(0.05); } catch (eBa) {}
    document.body.classList.add('game-sealed');
    var br = document.getElementById('broken');
    if (br) {
      br.classList.remove('hidden');
      br.setAttribute('aria-hidden', 'false');
    }
    var title = document.getElementById('title');
    if (title) title.classList.add('hidden');
    var hud = document.getElementById('hud');
    if (hud) hud.classList.add('hidden');
    var over = document.getElementById('over');
    if (over) over.classList.add('hidden');
    var pause = document.getElementById('pause');
    if (pause) pause.classList.add('hidden');
    var bill = document.getElementById('billScene');
    if (bill) bill.classList.add('hidden');
  }
  function refreshMenuLocks() {
    if (isArchiveSealed()) { sealForever(); return; }
    var u = getUnlocks();
    if (el.btnStart150) {
      el.btnStart150.disabled = u < 2;
      el.btnStart150.textContent = u < 2 ? 'УРОВЕНЬ 2 · ЗАКРЫТ (12k)' : 'УРОВЕНЬ 2 · 150 BPM ↗';
      el.btnStart150.classList.toggle('locked', u < 2);
    }
    if (el.btnSecret) {
      var ready = u >= 3;
      el.btnSecret.classList.toggle('hidden', !ready);
      el.btnSecret.disabled = !ready;
      el.btnSecret.setAttribute('aria-hidden', ready ? 'false' : 'true');
    }
  }

  function showLevelBanner(lv) {
    if (!el.levelBanner) return;
    var set130 = (lv <= 1);
    if (el.levelBannerText) el.levelBannerText.textContent = 'УРОВЕНЬ ' + lv;
    if (el.levelBannerSub) {
      el.levelBannerSub.textContent = set130 ? '130 BPM · НОВЫЙ РИТМ' : '150 BPM · КЛАССИКА';
    }
    el.levelBanner.classList.remove('hidden');
    el.levelBanner.classList.add('show');
    levelBannerT = 2.2;
  }

  function updateHud() {
    // DOM is only touched when a displayed value really changes
    var sc = Math.floor(score);
    if (sc !== _hudCache.score) { _hudCache.score = sc; el.score.textContent = String(sc); }
    var cb = Math.floor(combo);
    if (el.combo && cb !== _hudCache.combo) { _hudCache.combo = cb; el.combo.textContent = 'x' + cb; }
    var ds = Math.floor(dist);
    if (ds !== _hudCache.dist) { _hudCache.dist = ds; el.dist.textContent = ds + 'm'; }

    // Stage stays fixed for the whole run (track/BPM never switches mid-run).
    if (el.levelNum && _hudCache.stage !== activeStage) {
      _hudCache.stage = activeStage;
      el.levelNum.textContent = String(activeStage);
    }
    if (el.levelProg) {
      // progress toward unlock challenge on stage 1
      var w;
      if (activeStage === 1 && !isUnlocked(2)) {
        w = Math.round(Math.max(0, Math.min(100, (score / UNLOCK_SCORE_2) * 100)) * 2) / 2 + '%';
        if (score >= UNLOCK_SCORE_2) unlockStage(2);
      } else if (activeStage === 2 && !isUnlocked(3)) {
        w = Math.round(Math.max(0, Math.min(100, (score / UNLOCK_SCORE_SECRET) * 100)) * 2) / 2 + '%';
        if (score >= UNLOCK_SCORE_SECRET) unlockStage(3);
      } else {
        w = '100%';
      }
      if (w !== _hudCache.prog) { _hudCache.prog = w; el.levelProg.style.width = w; }
    }
  }

  var menuSkip = false;
  var _coinGeo = null, _coinMat = null;
  var _tipPos = null;
  var _closeCallPrev = null;
  function update(dt) {
    dt = Math.min(dt, 0.05);
    if (paused) return;
    if (dying) {
      updateRagdoll(dt);
      if (renderer && scene && camera) renderer.render(scene, camera);
      return;
    }
    if (!running) {
      // menu / game-over backdrop: nothing fast moves, 30 fps is plenty (saves battery + heat)
      menuSkip = !menuSkip;
      if (menuSkip) return;
      var t = performance.now() * 0.001;
      camera.position.x = Math.sin(t * 0.4) * 0.3;
      camera.position.y = 5.2 + Math.sin(t * 0.5) * 0.1;
      camera.lookAt(0, 1.2, -4);
      renderer.render(scene, camera);
      return;
    }

    // Scroll visual environment toward the player like a true endless runner.
    // Obstacles and side-scene modules share the same world speed.
    var sceneDz = speed * dt;
    if (laneInputLock > 0) laneInputLock = Math.max(0, laneInputLock - dt);
    if (lastLaneSwitchT > 0) lastLaneSwitchT = Math.max(0, lastLaneSwitchT - dt);
    if (lastLaneSwitchT <= 0) laneSwitchStreak = 0;
    for (var ssi = 0; ssi < sceneryPieces.length; ssi++) {
      var scp = sceneryPieces[ssi];
      if (!scp || !scp.parent) continue;
      if (scp.userData && scp.userData.segmentedScenery) {
        // Some art passes are intentionally authored as a collection of many
        // props inside one parent group. Moving/wrapping that parent made the
        // entire background pop out at once. Recycle top-level props instead,
        // preserving continuous side scenery and wall lamps.
        for (var sci = 0; sci < scp.children.length; sci++) {
          var child = scp.children[sci];
          if (!child) continue;
          child.position.z += sceneDz;
          if (child.position.z > 20) child.position.z -= 216;
        }
      } else {
        scp.position.z += sceneDz;
        if (scp.position.z > 20) {
          // wrap by the module ring's real length so spacing stays even
          // (36*6.4 / 28*7.2 modules used to be wrapped by a fixed 216)
          scp.position.z -= (scp.userData && scp.userData.wrapPeriod) || 216;
        }
      }
    }

    // boost / power timers in real time; world runs in music time
    if (boostTimer > 0) boostTimer -= dt;
    var pKeys = ['magnet', 'x2', 'board', 'jump', 'jet'];
    var pChanged = false;
    for (var pi = 0; pi < pKeys.length; pi++) {
      var pk = pKeys[pi];
      if (pwr[pk] > 0) {
        pwr[pk] -= dt;
        if (pwr[pk] <= 0) {
          pwr[pk] = 0; pChanged = true; if (pk === 'board') boardHits = 0;
          if (pk === 'jet') {
            // Jet ran out: fall is safe. Previously, expiring above a train meant y > roof+0.55,
            // collide() treated that as a body hit and the run ended mid-air.
            invuln = Math.max(invuln, 1.0);
            for (var jo = 0; jo < obstacles.length; jo++) {
              var jt = obstacles[jo];
              if (!jt || !(jt.userData.solidRoof || jt.userData.roof)) continue;
              if (!inLaneX(jt.userData.lane, laneX)) continue;
              var jhalf = (jt.userData.depth || 5) * 0.5;
              if (Math.abs(gleb.position.z - jt.position.z) < jhalf + 0.3) {
                onRoof = true; roofGrace = 0.6; vy = 0;
                break;
              }
            }
          }
        }
        else pChanged = true;
      }
    }
    if (pChanged) renderPowers();
    // combo decays slowly without pickups (SS multiplier pressure)
    if (combo > 1) {
      combo = Math.max(1, combo - dt * 0.12);
    }
    if (actionStreakT > 0) {
      actionStreakT -= dt;
      if (actionStreakT <= 0) actionStreak = 0;
    }
    // monkey duration + meter drains smoothly with remaining time
    if (monkeyTimer > 0) {
      monkeyTimer -= dt;
      if (monkeyTimer <= 0) {
        monkeyTimer = 0;
        coinMeter = 0;
        monkeyCooldown = MONKEY_CD;
        invuln = Math.max(0, Math.min(invuln, 0.4));
        document.body.classList.remove('monkey-mode');
      } else {
        coinMeter = (monkeyTimer / MONKEY_DUR) * METER_MAX;
      }
      updateMeterUI();
    } else if (monkeyCooldown > 0) {
      monkeyCooldown -= dt;
      if (monkeyCooldown < 0) monkeyCooldown = 0;
      updateMeterUI();
    } else {
      updateMeterUI();
    }
    // musicRate < 1 when Buddy warps the track — whole run slows with it
    // world time follows musicRate → boost speeds run without breaking the metronome
    var rate = (musicStarted && musicRate > 0) ? musicRate : 1;
    var gdt = dt * rate; // gameplay delta (shared by world, anim, spawns)
    // SS-like ramp: gentle early, then climb, soft cap (boosts still spike)
    // strong first seconds, then SS-like climb
    // BPM-aware: 130 = baseline, 150 ≈ +12% world speed (spawn spacing already uses BEAT)
    var bpmScale = BPM / BPM_CHILL; // 1.0 @130, ~1.154 @150
    // Rhythm-locked units/sec. Boost/monkey accelerate via musicRate → gdt → beatClock
    // so scroll, BPM, metronome and spawns stay in lockstep (hear full boost track on-beat).
    var baseSpeed = (musicSet === 1 ? 18.8 : 21.6);
    // gentle difficulty ramp: up to +20% over the first ~3000 m (speed used to stay flat forever)
    speed = baseSpeed * (1 + Math.min(0.2, dist / 15000));
    if (laneSlowT > 0) {
      laneSlowT -= gdt;
      speed *= 0.78; // mild scrape — was 0.52 (felt like random freeze)
    }
    if (pwr.jet > 0) { speed *= 1.12; invuln = Math.max(invuln, 0.12); }
    if (monkeyTimer > 0) {
      invuln = Math.max(invuln, 0.2);
    }
    dist += speed * gdt;
    // light distance score (SS always ticks score while moving)
    score += speed * gdt * 0.35 * (pwr.x2 > 0 ? 2 : 1);
    distSinceBoostSpawn += speed * gdt;

    // metronome in the same slowed timebase as the track
    var prevBeat = beatClock;
    beatClock += gdt;
    if (beatFxTimer > 0) {
      beatFxTimer -= dt;
      if (beatFxTimer <= 0 && el.beatFx) el.beatFx.classList.remove('show');
    }
    // quarter-note pulse for feel
    var qPrev = Math.floor(prevBeat / BEAT);
    var qNext = Math.floor(beatClock / BEAT);
    if (qNext > qPrev && scene && scene.userData.chaseLight) {
      scene.userData.chaseLight.intensity = 0.55 + threat * 1.5 + 0.35;
      for (var li = 0; li < laneLines.length; li++) {
        laneLines[li].material.emissiveIntensity = 0.7;
      }
    }
    for (var li2 = 0; li2 < laneLines.length; li2++) {
      laneLines[li2].material.emissiveIntensity = Math.max(0.2, laneLines[li2].material.emissiveIntensity - gdt * 1.4);
    }

    // Buddy pressure: mild, scales slowly. Boost clearly helps but is not the only survival tool.
    if (boostTimer > 0) {
      gap = Math.min(GAP_MAX, gap + 4.2 * gdt);
    } else {
      // Soft chase: SS has no pursuer — Buddy is flavor, not main killer until late
      var closeRate = 0.025 + Math.min(0.16, dist * 0.00022);
      if (dist < 200) closeRate *= 0.35;
      if (gap < 6) closeRate *= 0.45;
      if (pwr.jet > 0 || pwr.board > 0 || boostTimer > 0 || monkeyTimer > 0) closeRate *= 0.25;
      gap -= closeRate * gdt;
    }
    if (gap < GAP_MIN_CATCH && monkeyTimer <= 0) {
      endGame('caught');
      return;
    }
    if (monkeyTimer > 0 && gap < 4) gap = 4;
    threat = 1 - Math.max(0, Math.min(1, (gap - GAP_MIN_CATCH) / (GAP_MAX - GAP_MIN_CATCH)));
    updateMusic(dt);

    var targetX = LANES[lane];
    laneX += (targetX - laneX) * Math.min(1, LANE_LERP * gdt);

    if (onRoof && vy <= 0 && roofJumpLock <= 0) {
      // stand on deck surface (slightly above mesh)
      var deckY = H_ROOF + 0.08;
      if (y > deckY + 0.2) {
        y = Math.max(deckY, y + GRAVITY * gdt * 0.8);
        if (y <= deckY + 0.05) { y = deckY; vy = 0; }
      } else {
        y = deckY;
        vy = 0;
      }
    } else if (pwr.jet > 0) {
      // SS jet: locked high flight — over trains/boxes, not magnet gameplay
      var cruise = 2.85;
      // still climbing from launch
      if (y < cruise - 0.15) {
        vy = Math.max(vy, 6);
        vy += -GRAVITY * 0.15 * gdt; // anti-gravity climb assist
        y += vy * gdt;
        if (y > cruise) { y = cruise; vy = 0; }
      } else {
        y = cruise + Math.sin(performance.now() * 0.012) * 0.06;
        vy = 0;
      }
      onRoof = false;
      sliding = false;
      invuln = Math.max(invuln, 0.15);
    } else if (y > 0 || vy > 0) {
      vy += GRAVITY * gdt;
      y += vy * gdt;
      if (y <= 0) {
        if (wasAirborne) { sfxLand(); fxBurst(laneX, 0.06, 2, 0x9aa4b4, 7, 2.2); }
        y = 0; vy = 0; onRoof = false;
        wasAirborne = false;
      } else {
        wasAirborne = true;
      }
    } else {
      onRoof = false;
    }
    if (sliding) {
      slideT -= gdt;
      if (slideT <= 0) sliding = false;
    }
    // coyote time
    if (y <= 0.14 || onRoof) coyoteT = 0.1;
    else if (coyoteT > 0) coyoteT -= gdt;
    if (jumpBufferT > 0) {
      jumpBufferT -= gdt;
      if (jumpBufferT > 0 && (y <= 0.14 || onRoof || coyoteT > 0) && pwr.jet <= 0) {
        if (!sliding || slideT < 0.12) doJump();
      }
    }
    if (invuln > 0) invuln -= gdt;
    if (beatBonusCd > 0) beatBonusCd -= gdt;
    if (nearMissCd > 0) nearMissCd -= gdt;

    gleb.position.x = laneX;
    // hoverboard: visible board + slight float when active (SS board read)
    var boardActive = pwr.board > 0 && boardHits > 0;
    var boardFloat = (boardActive && y < 0.08) ? 0.22 : 0;
    // monkey ball: enough lift so X-spin around feet doesn't sink through floor
    var ballLift = 0;
    if (monkeyTimer > 0 && !dying) {
      ballLift = (gleb.userData && gleb.userData.isMinder) ? 0.8 : 1.4;
    }
    gleb.position.y = y + boardFloat + ballLift;
    updatePowerAnims(gdt, boardActive);
    if (gleb.userData.board) {
      gleb.userData.board.visible = boardActive;
      if (boardActive) {
        gleb.userData.board.rotation.z = Math.sin(performance.now() * 0.006) * 0.06;
        gleb.userData.board.position.y = -0.06 + Math.sin(performance.now() * 0.004) * 0.015;
      }
    }
    gleb.position.z = 2;
    if (pwr.jet > 0 && gleb.userData.torso) {
      gleb.userData.torso.rotation.x = -0.35;
    }
    var legPhase = dist * 0.45;
    // running animation plays whenever feet are actually planted: on the
    // ground OR standing on a roof car (not mid-jump, vy ~ 0 either way).
    // Previously this only checked y < 0.05, which is never true on a roof
    // (y sits at H_ROOF there), so the character stood frozen while "running".
    var onGroundAnim = (y < 0.05 || (onRoof && vy <= 0.01));
    var boardSkating = pwr.board > 0 && boardHits > 0;
    var runCycle = onGroundAnim && !sliding && monkeyTimer <= 0 && !dying && !boardSkating;
    var jumping = !onGroundAnim && !sliding && monkeyTimer <= 0 && !dying;
    // Minder has its own limb / booty / monkey animation set
    if (gleb.userData && gleb.userData.isMinder) {
      animateMinder(gdt, dt, runCycle, jumping, sliding, legPhase);
    } else if (gleb.userData.legs) {
      if (monkeyTimer > 0 && !dying) {
        // pose finalized in ouroboros block
        gleb.userData.legs[0].rotation.x = -2.55;
        gleb.userData.legs[1].rotation.x = -2.55;
      } else if (runCycle) {
        gleb.userData.legs[0].rotation.x = Math.sin(legPhase) * 0.75;
        gleb.userData.legs[1].rotation.x = Math.sin(legPhase + Math.PI) * 0.75;
      } else if (sliding) {
        gleb.userData.legs[0].rotation.x = 0.8;
        gleb.userData.legs[1].rotation.x = 0.9;
      } else if (jumping) {
        gleb.userData.legs[0].rotation.x = -0.85;
        gleb.userData.legs[1].rotation.x = -0.55;
      } else {
        gleb.userData.legs[0].rotation.x = 0.2;
        gleb.userData.legs[1].rotation.x = 0.2;
      }
    }
    if (gleb.userData.feet) {
      for (var fi = 0; fi < 2; fi++) {
        var foot = gleb.userData.feet[fi];
        if (runCycle) {
          var swing = Math.sin(legPhase + fi * Math.PI);
          foot.rotation.x = -swing * 0.65;
        } else if (sliding) foot.rotation.x = 0.5;
        else if (jumping || monkeyTimer > 0) foot.rotation.x = -0.4;
        else foot.rotation.x = 0.05;
      }
    }
    if (gleb.userData.arms && !(gleb.userData && gleb.userData.isMinder)) {
      var aL = gleb.userData.arms[0], aR = gleb.userData.arms[1];
      if (monkeyTimer > 0 && !dying) {
        aL.upper.rotation.x = 2.1; aR.upper.rotation.x = 2.1;
        aL.upper.rotation.z = 0.9; aR.upper.rotation.z = -0.9;
        aL.fore.rotation.x = 1.2; aR.fore.rotation.x = 1.2;
      } else if (sliding) {
        aL.upper.rotation.x = 1.1; aR.upper.rotation.x = 1.1;
        aL.fore.rotation.x = 0.3; aR.fore.rotation.x = 0.3;
      } else if (jumping) {
        aL.upper.rotation.x = -0.9; aR.upper.rotation.x = -0.9;
        aL.fore.rotation.x = -0.5; aR.fore.rotation.x = -0.5;
      } else if (runCycle) {
        aL.upper.rotation.x = 0.25 + Math.sin(legPhase + Math.PI) * 0.55;
        aR.upper.rotation.x = 0.25 + Math.sin(legPhase) * 0.55;
        aL.fore.rotation.x = 0.2; aR.fore.rotation.x = 0.2;
      }
    }
    // --- body pose ---
    if (sliding && !dying && !(gleb.userData && gleb.userData.isMinder)) {
      // Gleb slide squash only
      gleb.scale.set(1.12, 0.42, 1.12);
      gleb.rotation.x = 0;
      gleb.rotation.z = 0;
      if (gleb.userData.torso) {
        gleb.userData.torso.rotation.x = 0.3;
        gleb.userData.torso.position.set(0, 1.1, 0);
      }
      if (gleb.userData.head) {
        gleb.userData.head.rotation.x = 0.1;
        gleb.userData.head.position.set(0, 1.88, 0);
      }
      if (gleb.userData.junkRoot) {
        gleb.userData.junkRoot.position.set(0, 0.32, 0.3);
        gleb.userData.junkRoot.rotation.x = 0.3;
      }
    } else if (jumping && !dying && !(gleb.userData && gleb.userData.isMinder)) {
      gleb.scale.set(1, 1, 1);
      gleb.rotation.x = 0;
      gleb.rotation.z = 0;
      if (gleb.userData.torso) {
        gleb.userData.torso.rotation.x = -0.2;
        gleb.userData.torso.position.y = 1.15;
      }
      if (gleb.userData.head) gleb.userData.head.rotation.x = 0.1;
      if (gleb.userData.junkRoot) {
        gleb.userData.junkRoot.position.set(0, 0.55, 0.30);
        gleb.userData.junkRoot.rotation.x = -0.3;
      }
    } else if (monkeyTimer > 0 && !dying && !(gleb.userData && gleb.userData.isMinder)) {
      // Gleb ouroboros only — Minder handled in animateMinder
      gleb.scale.set(1, 1, 1);
      if (gleb.userData.ballSpin == null) gleb.userData.ballSpin = 0;
      gleb.userData.ballSpin -= gdt * 13;
      gleb.rotation.x = gleb.userData.ballSpin;
      gleb.rotation.z = 0;
      gleb.rotation.y = Math.PI;

      if (gleb.userData.torso) {
        gleb.userData.torso.position.set(0, 1.0, 0.08);
        gleb.userData.torso.rotation.x = 0.95;
        gleb.userData.torso.scale.set(1.0, 0.92, 1.0);
      }
      if (gleb.userData.head) {
        gleb.userData.head.position.set(0, 0.88, 0.62);
        gleb.userData.head.rotation.x = 1.45;
        gleb.userData.head.rotation.z = 0;
      }
      if (gleb.userData.legs) {
        gleb.userData.legs[0].position.set(-0.16, 1.05, -0.28);
        gleb.userData.legs[1].position.set(0.16, 1.05, -0.28);
        gleb.userData.legs[0].rotation.x = -2.55;
        gleb.userData.legs[1].rotation.x = -2.55;
        gleb.userData.legs[0].rotation.z = 0.15;
        gleb.userData.legs[1].rotation.z = -0.15;
      }
      if (gleb.userData.arms) {
        var aL = gleb.userData.arms[0], aR = gleb.userData.arms[1];
        aL.upper.rotation.set(1.85, 0, 1.05);
        aR.upper.rotation.set(1.85, 0, -1.05);
        aL.fore.rotation.set(1.35, 0, 0);
        aR.fore.rotation.set(1.35, 0, 0);
        if (aL.paw) aL.paw.rotation.set(0.4, 0, 0);
        if (aR.paw) aR.paw.rotation.set(0.4, 0, 0);
      }
      // shaft arcs UP into the mouth (Gleb only)
      if (gleb.userData.junkRoot) {
        gleb.userData.junkRoot.position.set(0, 0.78, 0.42);
        gleb.userData.junkRoot.rotation.x = -2.05;
        gleb.userData.junkRoot.rotation.y = 0;
        gleb.userData.junkRoot.rotation.z = 0;
      }
      if (gleb.userData.shaftBones) {
        for (var sbi = 0; sbi < gleb.userData.shaftBones.length; sbi++) {
          var sb = gleb.userData.shaftBones[sbi];
          sb.rotation.x = -0.55 - sbi * 0.12;
          sb.rotation.y = 0;
          sb.rotation.z = 0;
        }
      }
      // Minder: spin the face hard, keep silhouette clean
      if (gleb.userData.isMinder && gleb.userData.head) {
        gleb.userData.head.rotation.z = Math.sin((gleb.userData.ballSpin || 0) * 2) * 0.15;
      }
    } else if (!dying && !(gleb.userData && gleb.userData.isMinder)) {
      // Gleb-only default pose. For Minder this block used to run too and every
      // frame reset his legs (+0.38 up, ±0.2 apart), torso and head to Gleb's
      // numbers, cancel the monkey roll and the slide pose — that is what tore the
      // body apart. Minder's pose is owned entirely by animateMinder().
      gleb.scale.set(1, 1, 1);
      gleb.rotation.x = 0;
      gleb.rotation.z = 0;
      gleb.userData.ballSpin = 0;
      if (gleb.userData.torso) {
        gleb.userData.torso.rotation.x = 0;
        gleb.userData.torso.position.set(0, 1.15, 0);
        gleb.userData.torso.scale.set(1, 1, 1);
      }
      if (gleb.userData.head) {
        gleb.userData.head.rotation.x = 0;
        gleb.userData.head.position.set(0, 1.92, 0);
      }
      if (gleb.userData.legs) {
        gleb.userData.legs[0].position.set(-0.2, 0.38, 0);
        gleb.userData.legs[1].position.set(0.2, 0.38, 0);
      }
      if (gleb.userData.junkRoot) {
        gleb.userData.junkRoot.position.set(0, 0.52, 0.30);
        gleb.userData.junkRoot.rotation.x = 0;
        gleb.userData.junkRoot.rotation.z = 0;
      }
    }
    // hose: drop to floor then drag forward — tip never under ground
    if (gleb.userData.shaftBones && monkeyTimer <= 0 && !dying) {
      var jBase = dist * 0.48;
      var bones = gleb.userData.shaftBones;
      // pose: seg0 drops down, seg1-2 flatten along ground in front
      if (sliding) {
        bones[0].rotation.x = 0.35;
        if (bones[1]) bones[1].rotation.x = 0.85;
        if (bones[2]) bones[2].rotation.x = 0.95;
      } else if (jumping) {
        // curl up while airborne so it doesn't stretch through floor mesh
        bones[0].rotation.x = -0.4;
        if (bones[1]) bones[1].rotation.x = -0.25;
        if (bones[2]) bones[2].rotation.x = -0.15;
      } else {
        bones[0].rotation.x = 0.2 + Math.sin(jBase) * 0.05;
        if (bones[1]) bones[1].rotation.x = 0.6 + Math.sin(jBase * 0.9) * 0.08;
        if (bones[2]) bones[2].rotation.x = 0.8 + Math.sin(jBase * 1.1) * 0.06;
      }
      for (var sbi2 = 0; sbi2 < bones.length; sbi2++) {
        var lag = sbi2 * 0.45;
        bones[sbi2].rotation.z = Math.sin(jBase - lag) * (0.1 + sbi2 * 0.04);
        bones[sbi2].rotation.y = 0;
      }
      if (gleb.userData.balls) {
        gleb.userData.balls[0].position.y = -0.02 + Math.sin(jBase) * 0.015;
        gleb.userData.balls[1].position.y = -0.02 + Math.sin(jBase + 1.2) * 0.015;
      }
      // hard floor clamp on tip (world Y)
      if (gleb.userData.shaftTip) {
        gleb.updateMatrixWorld(true);
        var tipPos = _tipPos || (_tipPos = new THREE.Vector3());
        gleb.userData.shaftTip.getWorldPosition(tipPos);
        if (tipPos.y < 0.06) {
          // pull last bone up a bit so tip sits on floor
          var extra = (0.06 - tipPos.y);
          var last = bones[bones.length - 1];
          last.rotation.x = Math.min(1.2, last.rotation.x + extra * 1.8);
        }
      }
    }
    // cascade tail bones: phase lag down the chain (FK wave)
    if (gleb.userData.tailBones) {
      var bones = gleb.userData.tailBones;
      var tBase = dist * 0.42;
      for (var bi = 0; bi < bones.length; bi++) {
        var lag = bi * 0.75;
        var w = Math.sin(tBase - lag);
        var w2 = Math.cos(tBase - lag * 1.1);
        // rest pose + wave (amplify toward tip)
        var amp = 0.28 + bi * 0.18;
        bones[bi].rotation.z = w * amp;
        bones[bi].rotation.x = (0.55 - bi * 0.12) + w2 * (0.1 + bi * 0.06);
        bones[bi].rotation.y = w * 0.08 * bi;
      }
    }
    // arms cascade: opposite phase to legs, lag down the chain (Gleb only —
    // Minder's arms are posed in animateMinder and share one joint for fore/paw)
    if (gleb.userData.arms && !(gleb.userData && gleb.userData.isMinder)) {
      for (var ai = 0; ai < 2; ai++) {
        var arm = gleb.userData.arms[ai];
        var side = ai === 0 ? -1 : 1;
        // opposite to same-index leg phase
        var aPhase = legPhase + (ai === 0 ? Math.PI : 0);
        var swing = runCycle ? Math.sin(aPhase) : 0;
        if (sliding) {
          arm.upper.rotation.x = 1.1;
          arm.fore.rotation.x = 0.6;
          arm.paw.rotation.x = 0.2;
          arm.upper.rotation.z = side * 0.2;
        } else if (!runCycle) {
          // jump: arms slightly out/up (also covers mid-air on/above a roof car —
          // previously this used `y > 0.15`, which is always true while standing
          // on a roof at H_ROOF, so arms were stuck in the jump pose while running)
          arm.upper.rotation.x = -0.35;
          arm.fore.rotation.x = 0.15;
          arm.paw.rotation.x = 0;
          arm.upper.rotation.z = side * 0.25;
        } else {
          arm.upper.rotation.x = 0.2 + swing * 0.55;
          arm.upper.rotation.z = side * (0.1 + Math.abs(swing) * 0.05);
          // forearm lags behind upper
          arm.fore.rotation.x = 0.15 + Math.sin(aPhase - 0.55) * 0.5;
          // paw lags more
          arm.paw.rotation.x = Math.sin(aPhase - 1.1) * 0.35;
        }
      }
    }
    // buddy eyes pulse when close
    if (buddy.userData.eyes) {
      var pulse = 1.2 + threat * 1.5 + Math.sin(performance.now() * 0.01) * 0.3;
      buddy.userData.eyes.forEach(function (m) {
        if (m.material && m.material.emissiveIntensity != null) m.material.emissiveIntensity = pulse;
      });
    }

    var dz = speed * gdt;

    // scroll the ground texture so the (otherwise static) floor reads as
    // moving at the same rate as obstacles — cheap, big win for speed feel
    // Ground plane is 200 units long with 46 texture repeats → one tile is
    // 200/46 world units, so the offset must advance by dz*46/200 to match the
    // obstacle speed. The old 0.05 made the floor crawl at ~1/5 of real speed.
    if (groundTex) groundTex.offset.y += dz * (46 / 200);
    updateFx(dt, dz);
    // rails' ties, edge markers and wall pipes were static — scroll + wrap them
    for (var tsi = 0; tsi < trackScroll.length; tsi++) {
      var ts = trackScroll[tsi];
      ts.m.position.z += dz;
      if (ts.m.position.z > 12) ts.m.position.z -= ts.p;
    }

    // drift the ambient dust field forward and recycle it out of view
    if (dustPoints) {
      var dpos = dustPoints.geometry.attributes.position.array;
      for (var di = 0; di < dustCount; di++) {
        var idx = di * 3;
        dpos[idx + 2] += dz * 0.6;
        dpos[idx] += Math.sin(performance.now() * 0.0006 + di) * 0.004;
        if (dpos[idx + 2] > 10) {
          dpos[idx + 2] = -85 - Math.random() * 10;
          dpos[idx] = (Math.random() - 0.5) * 11;
          dpos[idx + 1] = 0.2 + Math.random() * 5.5;
        }
      }
      dustPoints.geometry.attributes.position.needsUpdate = true;
    }

    // FIX: moving/approaching trains can overtake props that were fine at spawn time.
    // Re-scrub a few times per second so no hidden prop ever lives inside a hull.
    propScrubT = (typeof propScrubT === 'number' ? propScrubT : 0) - dt;
    if (propScrubT <= 0) {
      propScrubT = 0.25;
      try { scrubPropsInsideTrains(0.6); } catch (eScrub) {}
    }

    var i, o, p;
    var roofStill = false;
    roofContact = false;
    for (i = obstacles.length - 1; i >= 0; i--) {
      o = obstacles[i];
      var prevObstacleZ = o.position.z;
      // Live safety: if this moving train is about to seal all 3 lanes, stop approaching
      if (o.userData.approach && isSolidTrainKind(o.userData.kind) && !o.userData.roof) {
        if (!canTrainApproach(o.userData.lane|0, o.position.z, effectiveTrainDepth(o))) {
          o.userData.approach = 0;
        }
      }
      var approach = o.userData.approach || 0;
      o.position.z += dz + approach * gdt;
      // train approach whoosh
      if (o.userData.approach && !o.userData._whooshed) {
        var wz = o.position.z - gleb.position.z;
        if (wz < 7 && wz > 2) {
          o.userData._whooshed = true;
          sfxWhoosh();
        }
      }

      if (o.position.z > 14) {
        propGroup.remove(o);
        obstacles.splice(i, 1);
        continue;
      }
      // continuous roof support — one deck height only, never stack into the sky
      if (pwr.jet <= 0 && roofJumpLock <= 0 && (o.userData.roof || o.userData.solidRoof)) {
        var sy = roofSupportY(o);
        if (sy != null) {
          var roofH2 = o.userData.roofH || H_ROOF;
          var standY = roofH2 + 0.08; // above car mesh — no sinking into texture
          sy = Math.min(sy, roofH2);
          var depth = o.userData.depth || 5;
          var half = depth * 0.5;
          var localZ = gleb.position.z - o.position.z;
          var onFlatDeck = !!o.userData.roof && localZ <= half - 0.1 && localZ >= -half + 0.1;
          // boarded flat deck: lock height, stop approach so Z doesn't slide us into the hull
          if (onFlatDeck && y >= roofH2 * 0.75) {
            sy = roofH2;
            o.userData.approach = 0;
          }
          if (vy > 0.45) {
            if (y >= roofH2 - 0.05 && y <= roofH2 + 0.6) roofStill = true;
          } else if (y < sy - 0.02) {
            if (o.userData.roof) {
              // follow the stairs (they rise 1.65 in ~0.15s): the old slow lerp reached deck height only
              // at the rear of a short car, so a train directly behind it hit you in the legs
              y = Math.min(sy, y + Math.max(0.25, (sy - y) * 0.6) * Math.min(1, gdt * 40));
              vy = 0;
              sliding = false;
              roofContact = true;
              if (y >= roofH2 - 0.2) {
                onRoof = true;
                roofGrace = 0.5;
                y = standY;
                o.userData.approach = 0;
              }
              roofStill = true;
            }
          } else if (y <= sy + 0.35) {
            y = standY;
            vy = 0;
            sliding = false;
            onRoof = true;
            roofContact = true;
            roofGrace = 0.5;
            roofStill = true;
            if (o.userData.roof) o.userData.approach = 0;
          }
        }
      }
      // Hitbox depth = half real depth + small pad (was fixed 1.35 — trains too thin, props too fat)
      var halfD = Math.max(0.3, ((o.userData.depth != null ? o.userData.depth : occDepth(o.userData.kind)) * 0.5));
      var hitPad = (o.userData.roof || o.userData.solidRoof) ? 0.4 : 0.28;
      var hitWin = halfD + hitPad;
      var zLo = Math.min(prevObstacleZ, o.position.z);
      var zHi = Math.max(prevObstacleZ, o.position.z);
      var playerZ = gleb.position.z;
      // player body thickness in Z (~0.35)
      var sweptHit = playerZ >= zLo - hitWin - 0.2 && playerZ <= zHi + hitWin + 0.2;
      // Near miss: if the player is very close to a train/prop but avoids it,
      // reward the risky weave. This is a core Subway Surfers-style feedback
      // loop and also makes the rhythm layer feel more reactive.
      if (pwr.jet <= 0 && nearMissCd <= 0 && !o.userData.roof && Math.abs(o.position.z - playerZ) < 1.35) {
        var laneDist = Math.abs(o.position.x - laneX);
        if (laneDist > LANE_HIT_HALF && laneDist < 1.55) {
          nearMissCd = 0.28;
          sfxNearMiss();
          score += 18 * (pwr.x2 > 0 ? 2 : 1);
          combo = Math.min(9, combo + 0.12);
          showBeatFx('БЛИЗКО!', false);
        }
      }
      if (pwr.jet <= 0 && inLaneX(o.userData.lane, laneX) && sweptHit) {
        // FIX: a ground prop buried inside / on a train on this lane is not a real obstacle
        if (PROP_KINDS_NO_TRAIN[o.userData.kind] && (onRoof || roofGrace > 0 || y >= H_ROOF - 0.25)) continue;
        if (o.userData.roof) {
          // sliding into a climbable car: stand up and board instead of dying
          if (sliding) {
            sliding = false;
            slideT = 0;
          }
          continue;
        }
        // if any climbable car overlaps this Z on this lane, don't die on a solid either
        if (sliding && y >= H_ROOF * 0.55) {
          var hasRoofHere = false;
          for (var rj = 0; rj < obstacles.length; rj++) {
            var ro = obstacles[rj];
            if (!ro.userData.roof || ro.userData.lane !== o.userData.lane) continue;
            if (Math.abs(ro.position.z - o.position.z) < 4.5) { hasRoofHere = true; break; }
          }
          if (hasRoofHere) continue;
        }
        if (invuln <= 0 && collide(o)) {
          // Climbable under feet while already roof-running — safe
          if (o.userData.roof && (onRoof || roofGrace > 0) && y > H_ROOF * 0.65) {
            onRoof = true;
            roofGrace = Math.max(roofGrace, 0.35);
            continue;
          }
          // Solid deck only if we are ALREADY on a roof-run (not a ground jump arc)
          if (o.userData.solidRoof && (onRoof || roofGrace > 0.08) && y >= (o.userData.roofH || H_ROOF) - 0.15) {
            continue;
          }
          // Side clip (Subway): no death — cancel green boost, bounce lane
          if (!isFrontalObstacle(o)) {
            sideBumpFrom(o);
            continue;
          }
          // monkey rampage: smash obstacle
          if (monkeyTimer > 0) {
            propGroup.remove(o);
            obstacles.splice(i, 1);
            score += 30 * (pwr.x2 > 0 ? 2 : 1);
            continue;
          }
          // SS hoverboard: while timer active, smash-through with bounce, no death
          if (pwr.board > 0) {
            invuln = Math.max(invuln, 0.45);
            vy = Math.max(vy, 5.2);
            y = Math.max(y, 0.35);
            boardHits = 0;
            pwr.board = 0;
            propGroup.remove(o);
            obstacles.splice(i, 1);
            score += 50 * (pwr.x2 > 0 ? 2 : 1);
            invuln = Math.max(invuln, 0.85); // SS: short free window after board breaks
            if (typeof shake !== 'undefined') shake = Math.max(shake || 0, 0.45);
            sfxCrash();
            showBeatFx('БОРД!', true);
            renderPowers();
            continue;
          }
          endGame('crash');
          return;
        }
      }
      // maintain roof state while overlapping roof train — but only snap
      // the player back down to the roof surface when they're not actively
      // rising from a jump (vy > 0). Previously this ran unconditionally
      // every frame, which zeroed vy the instant jump() set it, silently
      // cancelling every jump attempt while standing on a roof car.
      if (onRoof && roofJumpLock <= 0 && (o.userData.roof || o.userData.solidRoof) && inLaneX(o.userData.lane, laneX)) {
        var depth = o.userData.depth || 5;
        if (Math.abs(o.position.z - gleb.position.z) < depth * 0.5 + 0.55) {
          if (vy <= 0.5 && y <= (o.userData.roofH || H_ROOF) + 0.5) {
            y = (o.userData.roofH || H_ROOF) + 0.08;
            vy = 0;
            roofContact = true;
            o.userData.approach = 0;
            roofStill = true;
            roofGrace = Math.max(roofGrace, 0.35);
          }
        }
      }
    }
    for (i = pickups.length - 1; i >= 0; i--) {
      p = pickups[i];
      if (p.userData.taken) continue;
      p.position.z += dz;
      p.rotation.z += gdt * 4;
      if (p.position.z > 14) {
        propGroup.remove(p);
        pickups.splice(i, 1);
        continue;
      }
      // jet: ONLY airborne highway coins — never vacuum ground coins
      var jetOn = pwr.jet > 0;
      var jetPick = jetOn && inLaneX(p.userData.lane, laneX)
        && p.position.y >= 2.2
        && Math.abs(p.position.z - gleb.position.z) < 1.35
        && Math.abs(p.position.y - (y + 0.5)) < 1.4;
      var normalPick = !jetOn && inLaneX(p.userData.lane, laneX)
        && Math.abs(p.position.z - gleb.position.z) < 0.9;
      if (jetPick || normalPick) {
        var py = p.position.y;
        var gy = sliding ? 0.4 : y + 1.0;
        var heightOk = jetPick
          ? (py >= 2.2)
          : (Math.abs(py - gy) < 1.15);
        if (heightOk) {
          p.userData.taken = true;
          propGroup.remove(p);
          pickups.splice(i, 1);
          coins++;
          fxBurst(p.position.x, p.position.y, p.position.z, 0xffd24a, 6, 3);
          combo = Math.min(9, combo + 0.05);
          if (Math.floor(combo) > Math.floor(combo - 0.05) && Math.floor(combo) >= 2) {
            showBeatFx('КОМБО x' + Math.floor(combo), true);
          }
          var gain = 15 * (pwr.x2 > 0 ? 2 : 1) * Math.max(1, Math.floor(combo));
          score += gain;
          sfxCoin(combo);
          // meter does not fill during monkey (prevents infinite re-up mid-raid)
          // slow fill + blocked during raid/cooldown (anti-spam)
          if (monkeyTimer <= 0.05 && monkeyCooldown <= 0) {
            // ~90-100 coins to full; magnet no longer blocks fill
            if (dist < 15) { /* tiny grace */ }
            else {
              var fill = 1.05;
              coinMeter = Math.min(METER_MAX, coinMeter + fill);
              updateMeterUI();
            }
          }
        }
      }
    }

    if (roofStill) {
      roofGrace = 0.15;
    } else if (onRoof) {
      roofGrace -= gdt;
    }
    if (onRoof && !wasOnRoof) sfxRoof();
    wasOnRoof = onRoof;
    if (onRoof && !roofStill && roofGrace <= 0 && vy <= 0) {
      onRoof = false;
      if (y > 0.5 && y < H_ROOF + 0.2) {
        // walk off end — fall, don't snap-kill
        vy = -1.5;
      }
    }


    // magnet power only — jet is flight, not a vacuum
    if (pwr.magnet > 0) {
      for (i = 0; i < pickups.length; i++) {
        p = pickups[i];
        if (!p || p.userData.taken) continue;
        // jet + magnet: only attract sky coins, not ground
        if (pwr.jet > 0 && p.position.y < 2.2) continue;
        var dx = laneX - p.position.x;
        var dzm = gleb.position.z - p.position.z;
        var dy = (y + 1) - p.position.y;
        var distSq = dx * dx + dzm * dzm + dy * dy;
        if (distSq < 72) {
          p.position.x += dx * Math.min(1, gdt * 8);
          p.position.z += dzm * Math.min(1, gdt * 8);
          p.position.y += dy * Math.min(1, gdt * 6);
        }
      }
    }

    // powerups
    for (i = powerups.length - 1; i >= 0; i--) {
      var pu = powerups[i];
      if (!pu || pu.userData.taken) continue;
      pu.position.z += dz;
      if (pu.children[0]) pu.children[0].rotation.y += gdt * 3;
      if (pu.children[1]) pu.children[1].rotation.z += gdt * 2;
      if (pu.position.z > 16) {
        propGroup.remove(pu);
        powerups.splice(i, 1);
        continue;
      }
      var puy = pu.userData.y || 1.1;
      if ((inLaneX(pu.userData.lane, laneX) || pwr.magnet > 0) && Math.abs(pu.position.z - gleb.position.z) < 1.2) {
        if (pwr.magnet > 0 || Math.abs((y + 1.0) - puy) < 1.4 || (onRoof && puy > 1.5)) {
          pu.userData.taken = true;
          propGroup.remove(pu);
          powerups.splice(i, 1);
          activatePower(pu.userData.kind);
          score += 50 * (pwr.x2 > 0 ? 2 : 1);
          sfxPower();
        }
      }
    }

    // boost pads (wide Z window — на высокой скорости иначе «туннель» и пропадают)
    for (i = boosts.length - 1; i >= 0; i--) {
      var bp = boosts[i];
      if (bp.userData.taken) continue;
      var prevZ = bp.position.z;
      bp.position.z += dz;
      bp.rotation.y = Math.sin(performance.now() * 0.008) * 0.15;
      // hit if player crossed pad this frame or is near
      var z0 = Math.min(prevZ, bp.position.z) - 0.4;
      var z1 = Math.max(prevZ, bp.position.z) + 1.2;
      var hitZ = gleb.position.z >= z0 && gleb.position.z <= z1;
      if (inLaneX(bp.userData.lane, laneX) && hitZ && y < 1.5) {
        bp.userData.taken = true;
        propGroup.remove(bp);
        boosts.splice(i, 1);
        boostTimer = Math.min(5.5, boostTimer + 2.6);
        gap = Math.min(GAP_MAX, gap + 5.0);
        score += 25;
        sfxBoost();
        continue;
      }
      if (bp.position.z > 20) {
        propGroup.remove(bp);
        boosts.splice(i, 1);
      }
    }

    // guaranteed boost — only into free space
    // --- beat-grid spawn (SS-style: one clear beat-hit, then space to react) ---
    // Obstacles every 4 quarter-notes (~1.6s at 150 BPM) — matches readable
    // Surfers spacing better than packing a threat every 2 beats.
    beatIndex = Math.floor(beatClock / BEAT);
    if (beatIndex > lastBeatIndex) {
      lastBeatIndex = beatIndex;
      // every 3 beats once rolling — denser than empty SS-void start
      // heal desync (e.g. after BPM/track switch)
      if (spawnBeatCursor < beatIndex + 6 || spawnBeatCursor > beatIndex + 40) {
        spawnBeatCursor = beatIndex + 12;
      }
      if (spawnFillBeatCursor < beatIndex + 6 || spawnFillBeatCursor > beatIndex + 42) {
        spawnFillBeatCursor = beatIndex + 13;
      }
      // denser waves (SS never goes sparse for long)
      if (beatIndex % 2 === 0) {
        while (spawnBeatCursor < beatIndex + 22) {
          var ahead = spawnBeatCursor - beatIndex;
          if (ahead >= 6) {
            spawnOnBeat(spawnBeatCursor, ahead);
            repairImpossibleTrainWalls();
            scrubPropsInsideTrains(1.2);
          }
          spawnBeatCursor += 2;
        }
      }
      if (beatIndex % 2 === 1) {
        while (spawnFillBeatCursor < beatIndex + 22) {
          var fahead = spawnFillBeatCursor - beatIndex;
          if (fahead >= 7) {
            spawnBeatFill(spawnFillBeatCursor, fahead);
          }
          spawnFillBeatCursor += 2;
        }
      }
      sanitizeSpawns();
    }
    // boosts also on beat grid, denser for chains
    distSinceBoostSpawn += speed * gdt;
    if (distSinceBoostSpawn > 36) {
      var boostAhead = 14 + ((beatIndex % 4) * 2);
      if (spawnBoostSafe(zOnBeat(boostAhead))) { distSinceBoostSpawn = 0; sanitizeSpawns(); }
      else distSinceBoostSpawn = 18;
    }

    // Buddy position from real gap (z behind player)
    var chaseExtra = (buddy.userData && buddy.userData.isMind2) ? 2.6 : 1.3;
    var buddyZ = gleb.position.z + gap + chaseExtra + Math.sin(performance.now() * 0.004) * 0.2;
    buddy.position.z = buddyZ;
    buddy.position.x += (laneX * 0.35 - buddy.position.x) * (0.05 + threat * 0.06);
    buddy.position.y = ((buddy.userData && buddy.userData.isMind2) ? -0.15 : 0) + Math.sin(performance.now() * 0.006) * 0.1;
    // MIND2: soft swirl jiggle
    if (buddy.userData && buddy.userData.isMind2 && buddy.userData.blobs) {
      var bt = performance.now() * 0.004;
      for (var bi = 0; bi < buddy.userData.blobs.length; bi++) {
        var bl = buddy.userData.blobs[bi];
        bl.rotation.y = Math.sin(bt + bi * 0.8) * 0.15;
        bl.scale.y = 0.75 + Math.sin(bt * 1.3 + bi) * 0.04;
      }
      if (buddy.userData.face) {
        buddy.userData.face.position.y = 1.55 + Math.sin(bt * 1.5) * 0.04;
      }
    }
    var baseSc = (buddy.userData && buddy.userData.isMind2) ? 0.7 : 0.95;
    buddy.scale.setScalar(baseSc + threat * 0.16);
    if (scene.userData.chaseLight) {
      scene.userData.chaseLight.intensity = 0.4 + threat * 1.8;
      scene.userData.chaseLight.position.set(buddy.position.x, 3, buddy.position.z - 1);
    }
    // warn only when actually dangerous
    var closeCall = gap <= 3.5 && !gameOver && dist > 100;
    if (closeCall !== _closeCallPrev) {
      _closeCallPrev = closeCall;
      el.warn.classList.toggle('hidden', !closeCall);
      document.body.classList.toggle('danger-close', closeCall);
    }
    if (el.warn && closeCall) {
      var warnTxt = gap <= 2.2 ? 'ОН ХВАТАЕТ!' : 'ОН БЛИЗКО';
      if (warnTxt !== _hudCache.warn) { _hudCache.warn = warnTxt; el.warn.textContent = warnTxt; }
    }

    // SS-like chase cam: lower, closer, follows lane
    shake = Math.max(0, shake - dt * 1.2);
    var shk = threat * 0.04 + (monkeyTimer > 0 ? 0.06 : 0) + shake;
    var camTargetX = laneX * 0.22;
    camera.position.x += (camTargetX - camera.position.x) * 0.08; // tighter SS-like follow
    if (shk) camera.position.x += (Math.random() - 0.5) * shk;
    // High/back cam — large runners and chasers don't hide the track
    var camY = 5.4 + y * 0.08 + (pwr.jet > 0 ? 0.35 : 0);
    camera.position.y += (camY - camera.position.y) * 0.14;
    camera.position.z = 11.5;
    camera.lookAt(laneX * 0.12, 0.9 + y * 0.08, -14);
    // cinematic camera: FOV kick on boost / monkey / jet + slight roll into lane changes
    var fovT = 65 + (boostTimer > 0 ? 5 : 0) + (monkeyTimer > 0 ? 7 : 0) + (pwr.jet > 0 ? 4 : 0);
    fovCur += (fovT - fovCur) * Math.min(1, dt * 4);
    if (Math.abs(camera.fov - fovCur) > 0.02) { camera.fov = fovCur; camera.updateProjectionMatrix(); }
    camera.rotation.z = (camTargetX - camera.position.x) * -0.035;
    // rain doubles as speed streaks: brighter while boosting
    if (rainPoints && rainPoints.material) {
      var rTarget = (boostTimer > 0 || monkeyTimer > 0) ? 0.4 : 0.18;
      rainPoints.material.opacity += (rTarget - rainPoints.material.opacity) * Math.min(1, dt * 3);
    }

    visualTime += dt;
    if (rainPoints) {
      var rp = rainPoints.geometry.attributes.position.array;
      for (var ri = 0; ri < rainCount; ri++) {
        var idx = ri * 6;
        rp[idx+1] -= (18 + (ri % 7)) * dt;
        rp[idx+4] -= (18 + (ri % 7)) * dt;
        rp[idx+2] += speed * dt * 0.32;
        rp[idx+5] += speed * dt * 0.32;
        if (rp[idx+1] < 0.3 || rp[idx+2] > 7) {
          var nx = (Math.random() - 0.5) * 16;
          var ny = 4.5 + Math.random() * 5;
          var nz = -85 - Math.random() * 12;
          rp[idx]=nx; rp[idx+1]=ny; rp[idx+2]=nz;
          rp[idx+3]=nx+0.05; rp[idx+4]=ny-0.22; rp[idx+5]=nz+0.2;
        }
      }
      rainPoints.geometry.attributes.position.needsUpdate = true;
    }
    if (scene.userData.chaseLight && monkeyTimer <= 0.01) {
      var pulse = 0.82 + Math.sin(visualTime * 5.4) * 0.08;
      scene.userData.chaseLight.intensity *= pulse;
    }

    // SAFETY: roof deck is a single height — block sky-stack exploits
    // never zero upward velocity (would cancel jumps off the train)
    if (pwr.jet <= 0 && onRoof && roofJumpLock <= 0 && y > H_ROOF + 0.25 && vy <= 0) {
      y = H_ROOF + 0.08;
      vy = 0;
    }
    updateMinderFx(dt);
    // enforce Minder slide squash after any later Gleb pose resets
    if (gleb && gleb.userData && gleb.userData.isMinder && sliding && monkeyTimer <= 0 && !dying) {
      gleb.scale.set(1.2, 0.4, 1.2);
    }
    updateHud();
    renderer.render(scene, camera);
  }



  // ========== BILL CIPHER // SECRET ENDING ==========
  var billRaf = 0;
  var billRenderer = null;
  var billScene3 = null;
  var billCam = null;
  var billMesh = null;
  var billTalkIdx = 0;
  var billTalkT = 0;
  var BILL_LINES = [
    'ХА.\nНАКОНЕЦ-ТО КТО-ТО\n*ДОБЕЖАЛ* ДО КОНЦА.',
    'Я — *БИЛЛ ШИФЕР*.\nТРИ УГЛА. ОДИН ГЛАЗ.\nНОЛЬ ПОЩАДЫ.',
    'ВЫ ДУМАЛИ, ЭТО\nПРО ГЛЕБА И БАДИ?\n*МИЛО.*',
    'СКОРО ВЫ УЗНАЕТЕ\n*ВСЕ ТАЙНЫ*.\nВСЕ.',
    'ТОЛЬКО ВОТ…\n*АРХИВ* УЖЕ\nНЕ ВАШ.',
    'ПРОЩАЙТЕ.\nИГРА *ЗАКРЫВАЕТСЯ*.\n*НАВСЕГДА.*'
  ];
  var BILL_STAMPS = ['???', 'СИГНАЛ ПЕРЕХВАЧЕН', 'БИЛЛ ШИФЕР', 'ДОСТУП К ТАЙНАМ', 'АРХИВ ИЗЪЯТ', 'КОНЕЦ СВЯЗИ'];

  // ----- cutscene audio (all synthesized, no extra assets) -----
  var billAud = null;
  function billAudioStart() {
    try {
      var bus = ensureSfxBus();
      if (!bus || !audioCtx) return;
      try { audioCtx.resume(); } catch (e0) {}
      var t = audioCtx.currentTime;
      var master = audioCtx.createGain();
      master.gain.setValueAtTime(0.0001, t);
      master.gain.exponentialRampToValueAtTime(0.5, t + 2.5);
      master.connect(audioCtx.destination);
      var filt = audioCtx.createBiquadFilter();
      filt.type = 'lowpass'; filt.frequency.value = 240; filt.Q.value = 3;
      filt.connect(master);
      var oscs = [];
      [[55, 'sawtooth', 0], [55, 'sawtooth', 9], [82.4, 'triangle', -6], [110, 'sine', 0]].forEach(function (d) {
        var o = audioCtx.createOscillator();
        o.type = d[1]; o.frequency.value = d[0]; o.detune.value = d[2];
        var g = audioCtx.createGain(); g.gain.value = d[1] === 'sine' ? 0.12 : 0.1;
        o.connect(g); g.connect(filt); o.start(t); oscs.push(o);
      });
      // slow wobble on the filter = breathing drone
      var lfo = audioCtx.createOscillator(); lfo.frequency.value = 0.35;
      var lg = audioCtx.createGain(); lg.gain.value = 90;
      lfo.connect(lg); lg.connect(filt.frequency); lfo.start(t); oscs.push(lfo);
      // tape hiss
      var n = audioCtx.sampleRate * 2, buf = audioCtx.createBuffer(1, n, audioCtx.sampleRate), d0 = buf.getChannelData(0);
      for (var i = 0; i < n; i++) d0[i] = Math.random() * 2 - 1;
      var ns = audioCtx.createBufferSource(); ns.buffer = buf; ns.loop = true;
      var bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.6;
      var ng = audioCtx.createGain(); ng.gain.value = 0.015;
      ns.connect(bp); bp.connect(ng); ng.connect(master); ns.start(t); oscs.push(ns);
      billAud = { master: master, filt: filt, noise: ng, oscs: oscs, mid: oscs[1] };
    } catch (e) { billAud = null; }
  }
  // 0..1: drone opens up, hiss grows, second saw detunes sour
  function billAudioIntensity(x) {
    if (!billAud || !audioCtx) return;
    var t = audioCtx.currentTime;
    try {
      billAud.filt.frequency.setTargetAtTime(240 + x * 1500, t, 0.4);
      billAud.noise.gain.setTargetAtTime(0.015 + x * 0.09, t, 0.3);
      billAud.mid.detune.setTargetAtTime(9 + x * 70, t, 0.5);
    } catch (e) {}
  }
  function billAudioStop(fade) {
    if (!billAud || !audioCtx) return;
    var a = billAud; billAud = null;
    var t = audioCtx.currentTime;
    try { a.master.gain.cancelScheduledValues(t); a.master.gain.setValueAtTime(Math.max(0.0001, a.master.gain.value), t); a.master.gain.exponentialRampToValueAtTime(0.0001, t + (fade || 0.3)); } catch (e) {}
    setTimeout(function () { a.oscs.forEach(function (o) { try { o.stop(); } catch (e2) {} }); try { a.master.disconnect(); } catch (e3) {} }, ((fade || 0.3) + 0.1) * 1000);
  }
  function billBlip() { sfxTone(150 + Math.random() * 130, 0.05, { type: 'square', gain: 0.045, attack: 0.004 }); }
  function billGlitchHit(k) {
    k = k == null ? 1 : k;
    sfxThud(0.12 + 0.1 * k, { freq: 2600, gain: 0.22 * k });
    sfxTone(200 + Math.random() * 1200, 0.09, { type: 'sawtooth', slideTo: 60 + Math.random() * 900, gain: 0.07 * k });
  }
  function billStinger() {
    sfxThud(1.0, { freq: 90, gain: 0.8 });
    sfxTone(62, 1.3, { type: 'sawtooth', slideTo: 28, gain: 0.3 });
    sfxTone(990, 0.7, { type: 'triangle', slideTo: 110, gain: 0.12 });
  }
  function billFinalCut() {
    sfxThud(0.7, { freq: 7000, gain: 0.9 });
    sfxTone(1800, 0.55, { type: 'square', slideTo: 18, gain: 0.28 });
    sfxThud(0.9, { freq: 70, gain: 0.9 });
    billAudioStop(0.05);
  }

  // ----- typewriter with highlighted words (*word*) -----
  function parseBillLine(t) {
    var out = [], hl = false;
    for (var i = 0; i < t.length; i++) {
      var ch = t.charAt(i);
      if (ch === '*') { hl = !hl; continue; }
      out.push({ c: ch, h: hl });
    }
    return out;
  }
  function billRender(chars, n, cursor) {
    var html = '', run = '', cur = false;
    function flush() { if (run) html += cur ? '<span class="hl">' + run + '</span>' : run; run = ''; }
    for (var i = 0; i < n; i++) {
      var x = chars[i];
      if (x.h !== cur) { flush(); cur = x.h; }
      run += x.c === '<' ? '&lt;' : (x.c === '&' ? '&amp;' : x.c);
    }
    flush();
    if (cursor) html += '<span class="cur">\u258C</span>';
    return html;
  }
  function createBillTalk(lineEl, stampEl, hooks) {
    var CPS = 30, last = BILL_LINES.length - 1;
    var idx = -1, t = 0, chars = [], typed = 0, state = 'idle', holdT = 0, finT = 0, ended = false;
    function start(i) {
      idx = i; t = 0; typed = 0; holdT = 0;
      chars = parseBillLine(BILL_LINES[i]);
      state = 'type';
      lineEl.classList.toggle('final', i === last);
      lineEl.innerHTML = billRender(chars, 0, true);
      if (stampEl) {
        stampEl.textContent = BILL_STAMPS[i] || '';
        stampEl.classList.remove('pop'); void stampEl.offsetWidth; stampEl.classList.add('pop');
      }
      hooks.onLine(i);
    }
    return {
      get index() { return idx; },
      get state() { return state; },
      get ended() { return ended; },
      tick: function (dt) {
        if (ended) return;
        if (idx < 0) { start(0); return; }
        t += dt;
        if (state === 'type') {
          var n = Math.min(chars.length, Math.floor(t * CPS));
          if (n !== typed) {
            for (var k = typed; k < n; k++) hooks.onChar(k, chars[k]);
            typed = n;
            lineEl.innerHTML = billRender(chars, typed, true);
          }
          if (typed >= chars.length) { state = 'hold'; holdT = 0; }
        } else if (state === 'hold') {
          holdT += dt;
          if (holdT >= (idx === last ? 2.2 : 1.5)) {
            if (idx < last) start(idx + 1);
            else { state = 'fin'; finT = 0; hooks.onFinale(); }
          }
        } else if (state === 'fin') {
          finT += dt;
          hooks.onFinaleTick(finT, dt);
          if (finT >= hooks.finaleLen) { ended = true; hooks.onEnd(); }
        }
      }
    };
  }

  function buildCrudeBill() {
    var g = new THREE.Group();
    var geo = new THREE.ConeGeometry(1.35, 2.2, 3);
    var matY = new THREE.MeshStandardMaterial({
      color: 0xffcc22, emissive: 0xaa7700, emissiveIntensity: 0.55,
      roughness: 0.55, metalness: 0.15, flatShading: true
    });
    var body = new THREE.Mesh(geo, matY);
    body.rotation.y = Math.PI / 6;
    g.add(body);
    var edge = new THREE.Mesh(
      new THREE.ConeGeometry(1.42, 2.28, 3),
      new THREE.MeshBasicMaterial({ color: 0x1a0a00, wireframe: true })
    );
    edge.rotation.y = Math.PI / 6;
    g.add(edge);
    var eyeW = new THREE.Mesh(
      new THREE.SphereGeometry(0.38, 10, 8),
      new THREE.MeshStandardMaterial({ color: 0xfff8e0, emissive: 0x444422, emissiveIntensity: 0.3 })
    );
    eyeW.position.set(0, 0.15, 0.55);
    g.add(eyeW);
    var iris = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 8, 6),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x220000, emissiveIntensity: 0.4 })
    );
    iris.position.set(0, 0.15, 0.88);
    g.add(iris);
    var brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.05, 0.08, 8),
      new THREE.MeshStandardMaterial({ color: 0x1a1208, roughness: 0.9 })
    );
    brim.position.y = 1.05;
    g.add(brim);
    var top = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.42, 0.55, 6),
      new THREE.MeshStandardMaterial({ color: 0x0e0a06, roughness: 0.85 })
    );
    top.position.y = 1.35;
    g.add(top);
    for (var s = -1; s <= 1; s += 2) {
      var arm = new THREE.Mesh(
        new THREE.CylinderGeometry(0.04, 0.04, 1.4, 5),
        new THREE.MeshStandardMaterial({ color: 0x222018 })
      );
      arm.position.set(s * 1.05, -0.1, 0);
      arm.rotation.z = s * 0.85;
      g.add(arm);
      var hand = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, 0.18, 0.18),
        new THREE.MeshStandardMaterial({ color: 0xffee99, emissive: 0x664400, emissiveIntensity: 0.2 })
      );
      hand.position.set(s * 1.55, -0.55, 0.1);
      g.add(hand);
    }
    g.userData.iris = iris;
    g.userData.body = body;
    return g;
  }

  function openBillSecret() {
    if (typeof isArchiveSealed === 'function' && isArchiveSealed()) { sealForever(); return; }
    if (!isUnlocked(3)) return;
    try { stopMusic(); } catch (e) {}
    try { stopAmbient(); } catch (eA) {}
    running = false;
    paused = false;
    if (el.title) el.title.classList.add('hidden');
    if (el.hud) el.hud.classList.add('hidden');
    if (el.over) el.over.classList.add('hidden');
    if (el.pause) el.pause.classList.add('hidden');
    var panel = document.getElementById('billScene');
    if (!panel) { sealForever(); return; }
    panel.classList.remove('hidden', 'glitching', 'rage');
    panel.setAttribute('aria-hidden', 'false');
    var lineEl = document.getElementById('billLine');
    var stampEl = document.getElementById('billStamp');
    var flashEl = document.getElementById('billFlash');
    var uiEl = panel.querySelector('.bill-ui');
    if (lineEl) lineEl.innerHTML = '';

    function flash(red, ms) {
      if (!flashEl) return;
      flashEl.classList.toggle('red', !!red);
      flashEl.classList.add('hit');
      setTimeout(function () { flashEl.classList.remove('hit'); }, ms || 70);
    }
    function uiShake() {
      if (!uiEl) return;
      uiEl.classList.remove('shake'); void uiEl.offsetWidth; uiEl.classList.add('shake');
    }

    billAudioStart();
    var fxState = { inten: 0, jolt: 0, pulse: 0, final: false };
    var talk;
    var onEndSeal = function () {
      flash(false, 400);
      billFinalCut();
      setTimeout(function () { teardown(); sealForever(); }, 450);
    };
    var hooks = {
      finaleLen: 1.5,
      onLine: function (i) {
        fxState.inten = i / (BILL_LINES.length - 1);
        fxState.jolt = 1;
        flash(false, 60);
        uiShake();
        if (i === 0) billStinger(); else billGlitchHit(0.6 + fxState.inten * 0.6);
        if (i === 1) { billStinger(); fxState.pulse = 1; }
        billAudioIntensity(fxState.inten * 0.7);
      },
      onChar: function (k, ch) {
        if (ch.c === ' ' || ch.c === '\n') return;
        if (k % 2 === 0) billBlip();
        if (ch.h) fxState.pulse = Math.max(fxState.pulse, 0.5);
      },
      onFinale: function () {
        fxState.final = true;
        panel.classList.add('glitching', 'rage');
        billAudioIntensity(1);
        flash(true, 120);
        billGlitchHit(1.4);
        if (billRenderer) billRenderer.setClearColor(0x1a0200, 1);
      },
      onFinaleTick: function (ft) {
        // stutter flashes + noise bursts until the cut
        if (Math.floor(ft * 6) !== Math.floor((ft - 0.016) * 6)) { flash(Math.random() < 0.6, 50); billGlitchHit(1.2); fxState.jolt = 1; }
      },
      onEnd: onEndSeal
    };

    var canvas = document.getElementById('billCanvas');
    if (!canvas || typeof THREE === 'undefined') {
      talk = createBillTalk(lineEl, stampEl, hooks);
      var iv = setInterval(function () {
        talk.tick(0.05);
        if (talk.ended) clearInterval(iv);
      }, 50);
      return;
    }
    var w = window.innerWidth, h = window.innerHeight;
    billRenderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false, alpha: false });
    billRenderer.setSize(w, h);
    billRenderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    billRenderer.setClearColor(0x050200, 1);
    billScene3 = new THREE.Scene();
    billScene3.fog = new THREE.Fog(0x050200, 4, 16);
    billCam = new THREE.PerspectiveCamera(42, w / h, 0.1, 40);
    billCam.position.set(0, 0.4, 6.4);
    billCam.lookAt(0, 0.2, 0);
    billScene3.add(new THREE.HemisphereLight(0xffeeaa, 0x220800, 0.9));
    var key = new THREE.PointLight(0xffaa33, 1.6, 20);
    key.position.set(2, 3, 4);
    billScene3.add(key);
    var fill = new THREE.PointLight(0x4422ff, 0.5, 18);
    fill.position.set(-3, 1, 2);
    billScene3.add(fill);
    billMesh = buildCrudeBill();
    billScene3.add(billMesh);
    var floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 24),
      new THREE.MeshStandardMaterial({ color: 0x120800, roughness: 1 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.35;
    billScene3.add(floor);

    // rotating triangle rings behind Bill (his "dimension" frame)
    var rings = [];
    [[3.6, 0xffcc22, 0.22], [2.7, 0xff8a1a, -0.35], [4.6, 0x7a4cff, 0.14]].forEach(function (d, ri) {
      var ring = new THREE.Mesh(
        new THREE.TorusGeometry(d[0], 0.025, 4, 3),
        new THREE.MeshBasicMaterial({ color: d[1], transparent: true, opacity: 0.55 })
      );
      ring.position.set(0, 0.1, -1.6 - ri * 0.4);
      ring.userData.spin = d[2];
      billScene3.add(ring);
      rings.push(ring);
    });
    // drifting shards
    var shards = [];
    var shardGeo = new THREE.ConeGeometry(0.1, 0.28, 3);
    for (var si = 0; si < 46; si++) {
      var sh = new THREE.Mesh(shardGeo, new THREE.MeshBasicMaterial({ color: si % 3 === 0 ? 0xffee88 : (si % 3 === 1 ? 0xff9a22 : 0xffffff), transparent: true, opacity: 0.6 }));
      var ang = Math.random() * Math.PI * 2, rad = 2.6 + Math.random() * 5;
      sh.position.set(Math.cos(ang) * rad, -1 + Math.random() * 5, -3 + Math.random() * 4 - Math.abs(Math.sin(ang)) * 2);
      sh.userData.vy = 0.12 + Math.random() * 0.4;
      sh.userData.rs = (Math.random() - 0.5) * 3;
      billScene3.add(sh);
      shards.push(sh);
    }

    var mouseX = 0, mouseY = 0;
    function onBillMouse(e) {
      mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
      mouseY = (e.clientY / window.innerHeight - 0.5) * 2;
    }
    window.addEventListener('mousemove', onBillMouse);
    function onBillResize() {
      if (!billRenderer || !billCam) return;
      var ww = window.innerWidth, hh = window.innerHeight;
      billCam.aspect = ww / hh;
      billCam.updateProjectionMatrix();
      billRenderer.setSize(ww, hh);
    }
    window.addEventListener('resize', onBillResize);
    function teardown() {
      if (billRaf) { cancelAnimationFrame(billRaf); billRaf = 0; }
      window.removeEventListener('resize', onBillResize);
      window.removeEventListener('mousemove', onBillMouse);
      try { if (billRenderer) { billRenderer.dispose(); billRenderer = null; } } catch (e3) {}
    }

    talk = createBillTalk(lineEl, stampEl, hooks);
    var start = performance.now();
    var last = start;
    function billLoop(now) {
      billRaf = requestAnimationFrame(billLoop);
      var dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      var tsec = (now - start) / 1000;
      talk.tick(dt);
      fxState.jolt = Math.max(0, fxState.jolt - dt * 3.2);
      fxState.pulse = Math.max(0, fxState.pulse - dt * 2.4);
      var inten = fxState.final ? 1 : fxState.inten;
      if (billMesh) {
        var wob = 0.35 + inten * 0.4;
        billMesh.rotation.y = Math.sin(tsec * 0.7) * wob + (mouseX * 0.35);
        billMesh.rotation.x = mouseY * 0.15;
        billMesh.position.y = Math.sin(tsec * 1.4) * 0.12;
        billMesh.rotation.z = Math.sin(tsec * (2.1 + inten * 6)) * (0.05 + inten * 0.08);
        var sc = 1 + fxState.pulse * 0.12 + (fxState.final ? (Math.random() - 0.5) * 0.12 : 0);
        billMesh.scale.set(sc, sc, sc);
        if (billMesh.userData.iris) {
          var iris = billMesh.userData.iris;
          iris.scale.setScalar(1 + Math.sin(tsec * 5) * 0.08 + fxState.pulse * 0.6);
          iris.position.x = mouseX * 0.16;
          iris.position.y = 0.15 - mouseY * 0.1;
        }
      }
      for (var ri = 0; ri < rings.length; ri++) {
        rings[ri].rotation.z += rings[ri].userData.spin * dt * (1 + inten * 3);
        rings[ri].material.opacity = 0.35 + fxState.pulse * 0.4 + inten * 0.2;
      }
      for (var si2 = 0; si2 < shards.length; si2++) {
        var sh2 = shards[si2];
        sh2.position.y += sh2.userData.vy * dt * (1 + inten * 4);
        sh2.rotation.x += sh2.userData.rs * dt;
        sh2.rotation.z += sh2.userData.rs * dt * 0.7;
        if (sh2.position.y > 4.5) sh2.position.y = -1.3;
      }
      // lights flicker harder as it escalates
      key.intensity = 1.6 + Math.sin(tsec * 17) * 0.25 * (0.3 + inten) + fxState.pulse * 1.5 + (fxState.final && Math.random() < 0.3 ? 2 : 0);
      fill.intensity = 0.5 + inten * 1.2 + (Math.random() < inten * 0.15 ? 1.5 : 0);
      // slow dolly in + shake
      var dolly = 6.4 - Math.min(1.6, tsec * 0.07) - inten * 0.6;
      var shk = fxState.jolt * 0.16 + (fxState.final ? 0.1 : 0) + inten * 0.012;
      billCam.position.set((Math.random() - 0.5) * shk, 0.4 + (Math.random() - 0.5) * shk, dolly);
      billCam.lookAt(0, 0.2, 0);
      billCam.rotation.z = (Math.random() - 0.5) * shk * 0.25;
      if (billRenderer && billScene3 && billCam) billRenderer.render(billScene3, billCam);
    }
    billRaf = requestAnimationFrame(billLoop);
  }

  function loop(now) {
    requestAnimationFrame(loop);
    var rawMs = now - lastT;
    var dt = Math.min(0.05, rawMs / 1000);
    lastT = now;
    // Banner timer runs in REAL time from the render loop. It used to be counted inside
    // the running-game update, so it froze on pause / death / menu and "ТАЙНА" stayed forever.
    if (levelBannerT > 0) {
      levelBannerT -= dt;
      if (levelBannerT <= 0 && el.levelBanner) {
        el.levelBanner.classList.remove('show');
        el.levelBanner.classList.add('hidden');
      }
    }
    update(dt);
    adaptQuality(rawMs);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
