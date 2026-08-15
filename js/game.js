/* ============================================================
   game.js — Proportion Eye: divide lengths by eye, answer with
   the hand. Six items per round, every answer is a short drawn
   tick across the thing being measured: midpoint of a bare
   segment (x2), both thirds (x2), half a standing figure's
   height, then a stated ratio like 5/8 from the left end.
   Ticks are undoable until the item auto-scores (400ms grace).
   All scoring is pure fraction geometry — the functions at the
   top take numbers in and return 0–100, no canvas, no DOM.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'proportion-eye';
  var ITEMS_PER_ROUND = 6;
  var MIN_SAMPLES = 3;      /* fewer sampled points = accidental tap  */
  var MIN_TICK_LEN = 6;     /* px of drawn path below this = a tap    */
  var GRACE_MS = 400;       /* undo window after the last tick lands  */
  var REVEAL_MS = 2100;
  var REVEAL_FIGURE_MS = 3200; /* the head-unit ruler needs a beat    */
  var PERFECT_ZONE = 0.01;  /* err within 1% of the length is perfect */
  var ZERO_AT = 0.10;       /* beyond perfect zone, 10% more = zero   */

  /* ============================================================
     Pure scoring — fractions in, 0–100 out. Unit-testable.
     ============================================================ */
  function clamp01(v) { return Math.max(0, Math.min(1, v)); }

  /* err = |actualFraction − idealFraction| of the full length.
     1% perfect-zone, then linear to zero at 11% off.
     Non-finite err (missing/garbage mark) scores 0, never NaN. */
  function markScore(err) {
    if (typeof err !== 'number' || isNaN(err)) return 0;
    var e = Math.max(0, err - PERFECT_ZONE);
    return 100 * clamp01(1 - e / ZERO_AT);
  }

  /* Pair player fractions with ideal fractions (both ascending) so
     two thirds-ticks each get judged against their nearer division.
     A missing/non-finite mark pairs with err = Infinity (scores 0). */
  function pairMarks(actuals, ideals) {
    var a = actuals.slice().sort(function (x, y) { return x - y; });
    var out = [], i, v;
    for (i = 0; i < ideals.length; i++) {
      v = (typeof a[i] === 'number' && isFinite(a[i])) ? a[i] : null;
      out.push({
        actual: v === null ? ideals[i] : v,
        ideal: ideals[i],
        err: v === null ? Infinity : Math.abs(v - ideals[i]),
      });
    }
    return out;
  }

  /* Item = mean of its marks' scores. */
  function itemScore(actuals, ideals) {
    var pairs = pairMarks(actuals, ideals);
    var sum = 0, i;
    for (i = 0; i < pairs.length; i++) sum += markScore(pairs[i].err);
    return pairs.length ? sum / pairs.length : 0;
  }

  /* Round = mean of its items' scores. */
  function roundScore(scores) {
    if (!scores.length) return 0;
    var sum = 0, i;
    for (i = 0; i < scores.length; i++) sum += scores[i];
    return sum / scores.length;
  }

  /* ---- pure geometry: a drawn tick → a fraction along a→b ---- */
  function projFraction(p, a, b) {
    var abx = b.x - a.x, aby = b.y - a.y;
    var len2 = abx * abx + aby * aby;
    if (len2 === 0) return 0;
    return clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2);
  }

  function pointSegDist(p, a, b) {
    var t = projFraction(p, a, b);
    return Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t));
  }

  /* Where p1→p2 crosses a→b: the fraction along a→b, else null. */
  function segCrossFraction(p1, p2, a, b) {
    var rx = p2.x - p1.x, ry = p2.y - p1.y;
    var sx = b.x - a.x, sy = b.y - a.y;
    var denom = rx * sy - ry * sx;
    if (denom === 0) return null;
    var qpx = a.x - p1.x, qpy = a.y - p1.y;
    var t = (qpx * sy - qpy * sx) / denom; /* along the stroke piece */
    var u = (qpx * ry - qpy * rx) / denom; /* along a→b              */
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return u;
  }

  /* The player's mark: where their tick crosses the axis a→b, or —
     if it never crosses — the nearest sample projected onto it.
     dist lets the caller forgive strokes drawn nowhere near. */
  function strokeFraction(points, a, b) {
    var i, u, d, best = Infinity, bestFrac = 0;
    for (i = 1; i < points.length; i++) {
      u = segCrossFraction(points[i - 1], points[i], a, b);
      if (u !== null) return { frac: u, dist: 0 };
    }
    for (i = 0; i < points.length; i++) {
      d = pointSegDist(points[i], a, b);
      if (d < best) { best = d; bestFrac = projFraction(points[i], a, b); }
    }
    return { frac: bestFrac, dist: best };
  }

  function pathLength(points) {
    var sum = 0, i;
    for (i = 1; i < points.length; i++) {
      sum += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return sum;
  }

  /* ============================================================
     Canvas / DOM from here down.
     ============================================================ */
  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnUndo = document.getElementById('btnUndo');

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  /* Pure mint on the paper card is ~2.9:1 — too faint for the reveal
     lines and labels. On the light theme mix the accent 55/45 toward
     ink (the same recipe the template's .toast-accent uses); the night
     studio keeps the pure accent. Mixed in JS because canvas fillStyle
     can't be trusted with color-mix() everywhere. */
  function mixHex(x, y, wx) {
    var mx = /^#([0-9a-f]{6})$/i.exec(x), my = /^#([0-9a-f]{6})$/i.exec(y);
    if (!mx || !my) return x;
    var out = '#', i, a, b, v;
    for (i = 0; i < 3; i++) {
      a = parseInt(mx[1].substr(i * 2, 2), 16);
      b = parseInt(my[1].substr(i * 2, 2), 16);
      v = Math.round(a * wx + b * (1 - wx));
      out += (v < 16 ? '0' : '') + v.toString(16);
    }
    return out;
  }

  function inks() {
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--mint').trim();
    return {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: ArtDaily.theme() === 'light' ? mixHex(accent, ink, 0.55) : accent,
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---- round state ---- */
  var round = 0, itemIdx = 0, itemScores = [], item = null, playing = false;
  var drawing = false, strokePts = [], activeId = null, revealing = null;
  var graceTimer = null, revealTimer = null;
  var roundResult = null; /* ArtDaily.report() result, set the moment
                             the 6th item scores — so a completed round
                             is reported even if "new round" cuts the
                             final reveal short. Consumed by finishRound. */

  var RATIOS = [
    { f: 3 / 8, l: '3/8' },
    { f: 5 / 8, l: '5/8' },
    { f: 2 / 5, l: '2/5' },
    { f: 3 / 5, l: '3/5' },
  ];

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  /* ---- item geometry ---- */
  function segGeom(angDeg, fracLo, fracHi) {
    var margin = 36;
    var len = W * rand(fracLo, fracHi);
    var ang = angDeg * Math.PI / 180;
    var dx = Math.cos(ang), dy = Math.sin(ang);
    if (Math.abs(dx) > 0.01) len = Math.min(len, (W - 2 * margin) / Math.abs(dx));
    if (Math.abs(dy) > 0.01) len = Math.min(len, (H - 2 * margin) / Math.abs(dy));
    len = Math.max(60, len);
    var hx = dx * len / 2, hy = dy * len / 2;
    var mx = rand(margin + Math.abs(hx), W - margin - Math.abs(hx));
    var my = rand(margin + Math.abs(hy), H - margin - Math.abs(hy));
    return { a: { x: mx - hx, y: my - hy }, b: { x: mx + hx, y: my + hy } };
  }

  function perpUnit(a, b) {
    var len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
  }

  /* Difficulty ramps within the round: flat long midpoint → any-angle
     midpoint → flat thirds → steep thirds → the figure → a stated ratio. */
  function makeItem(idx) {
    clearTimeout(graceTimer);
    graceTimer = null;
    var g, n, r;
    if (idx === 4) {
      var h = H * 0.8;
      var u = h / 7.5;
      var top = H * 0.085;
      var cx = W * rand(0.34, 0.66);
      item = {
        kind: 'figure',
        a: { x: cx, y: top }, b: { x: cx, y: top + h },
        nx: 1, ny: 0,
        ideals: [0.5], labels: ['1/2'], required: 1,
        maxDist: Math.max(70, u * 2),
        ticks: [],
        fig: { cx: cx, top: top, h: h, u: u },
      };
    } else {
      var kind = 'seg', ideals = [0.5], labels = ['1/2'];
      if (idx === 0) g = segGeom(rand(-8, 8), 0.58, 0.72);
      else if (idx === 1) g = segGeom(Math.random() < 0.5 ? rand(25, 65) : rand(115, 155), 0.42, 0.58);
      else if (idx === 2) { g = segGeom(rand(-10, 10), 0.58, 0.75); ideals = [1 / 3, 2 / 3]; labels = ['1/3', '2/3']; }
      else if (idx === 3) { g = segGeom(rand(58, 122), 0.5, 0.68); ideals = [1 / 3, 2 / 3]; labels = ['1/3', '2/3']; }
      else {
        kind = 'ratio';
        g = segGeom(rand(-6, 6), 0.5, 0.66); /* dx>0, so a is the left end */
        r = RATIOS[Math.floor(Math.random() * RATIOS.length)];
        ideals = [r.f];
        labels = [r.l];
      }
      n = perpUnit(g.a, g.b);
      item = {
        kind: kind,
        a: g.a, b: g.b, nx: n.x, ny: n.y,
        ideals: ideals, labels: labels, required: ideals.length,
        maxDist: 48,
        ticks: [],
      };
    }
    hint.textContent = itemHint();
    updateUndo();
  }

  function itemHint() {
    var lbl = 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND + ' — ';
    if (!item) return '';
    if (item.kind === 'figure') return lbl + 'tick across the figure at half its height.';
    if (item.kind === 'ratio') return lbl + 'tick ' + item.labels[0] + ' of the way from the left end.';
    if (item.required === 2) return lbl + 'tick both thirds of the line (' + item.ticks.length + ' of 2 placed).';
    return lbl + 'draw a tick across the line at its midpoint.';
  }

  function newRound() {
    clearTimeout(graceTimer);
    clearTimeout(revealTimer);
    graceTimer = null;
    round += 1;
    itemIdx = 0;
    itemScores = [];
    drawing = false;
    strokePts = [];
    revealing = null;
    roundResult = null; /* any completed round was already reported in scoreItem */
    playing = true;
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    makeItem(0);
    draw();
  }

  /* ============================================================
     Painting (canvas bg stays clear so the CSS dot-grid shows).
     ============================================================ */
  function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

  function drawPolyline(pts) {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }

  function putText(text, x, y, color, size, align) {
    ctx.fillStyle = color;
    ctx.font = '700 ' + size + 'px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = align || 'center';
    ctx.fillText(text, Math.max(14, Math.min(W - 14, x)), Math.max(12, Math.min(H - 6, y)));
  }

  function drawSegmentBase(c) {
    var a = item.a, b = item.b, nx = item.nx, ny = item.ny;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    /* measured-length end caps: | ————— | */
    var e, ends = [a, b];
    for (var i = 0; i < 2; i++) {
      e = ends[i];
      ctx.beginPath();
      ctx.moveTo(e.x - nx * 8, e.y - ny * 8);
      ctx.lineTo(e.x + nx * 8, e.y + ny * 8);
      ctx.stroke();
    }
    if (item.kind === 'ratio') {
      putText('left', a.x, a.y + 22, c.muted, 11);
      putText('right', b.x, b.y + 22, c.muted, 11);
    }
  }

  function drawFigure(c) {
    var f = item.fig, u = f.u, cx = f.cx;
    function y(k) { return f.top + k * u; }
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = c.muted;
    ctx.strokeStyle = c.muted;
    ctx.lineCap = 'round';
    /* head (crown exactly at the top of the height being divided) */
    ctx.beginPath();
    ctx.ellipse(cx, y(0.5), u * 0.36, u * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    /* neck */
    ctx.fillRect(cx - u * 0.09, y(0.85), u * 0.18, u * 0.5);
    /* torso: shoulders → waist → hips (crotch lands at 3.75 = half) */
    ctx.beginPath();
    ctx.moveTo(cx - u * 0.72, y(1.4));
    ctx.lineTo(cx + u * 0.72, y(1.4));
    ctx.lineTo(cx + u * 0.5, y(2.85));
    ctx.lineTo(cx + u * 0.62, y(3.75));
    ctx.lineTo(cx - u * 0.62, y(3.75));
    ctx.lineTo(cx - u * 0.5, y(2.85));
    ctx.closePath();
    ctx.fill();
    /* arms */
    ctx.lineWidth = u * 0.22;
    var s;
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(cx + s * u * 0.64, y(1.55));
      ctx.lineTo(cx + s * u * 0.8, y(2.9));
      ctx.lineTo(cx + s * u * 0.72, y(4.5));
      ctx.stroke();
    }
    /* legs */
    ctx.lineWidth = u * 0.3;
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(cx + s * u * 0.3, y(3.8));
      ctx.lineTo(cx + s * u * 0.27, y(5.6));
      ctx.lineTo(cx + s * u * 0.22, y(7.3));
      ctx.stroke();
    }
    /* feet (soles at exactly 7.5 heads) */
    ctx.lineWidth = u * 0.14;
    for (s = -1; s <= 1; s += 2) {
      ctx.beginPath();
      ctx.moveTo(cx + s * u * 0.22, y(7.43));
      ctx.lineTo(cx + s * u * 0.58, y(7.43));
      ctx.stroke();
    }
    ctx.restore();
    /* dashed extent guides: this is the length you are halving */
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    var ky;
    for (var k = 0; k <= 1; k++) {
      ky = k === 0 ? y(0) : y(7.5);
      ctx.beginPath();
      ctx.moveTo(cx - u * 1.1, ky);
      ctx.lineTo(cx + u * 1.1, ky);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawTicks(c) {
    var i, t, p;
    for (i = 0; i < item.ticks.length; i++) {
      t = item.ticks[i];
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      drawPolyline(t.points);
      /* the mark the tick registered, dotted onto the axis */
      p = lerp(item.a, item.b, t.frac);
      ctx.fillStyle = c.ink;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawReveal(c) {
    var i, P, M, off;
    if (item.kind === 'figure') {
      var f = item.fig, u = f.u, cx = f.cx;
      var rx0 = cx - u * 1.5;
      /* the classic 7.5-heads ruler — the lesson of this item */
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(rx0, f.top);
      ctx.lineTo(rx0, f.top + f.h);
      ctx.stroke();
      for (i = 1; i <= 7; i++) {
        ctx.beginPath();
        ctx.moveTo(rx0 - 4, f.top + i * u);
        ctx.lineTo(rx0 + 4, f.top + i * u);
        ctx.stroke();
        putText(String(i), rx0 - 8, f.top + i * u + 3, c.muted, 10, 'right');
      }
      putText('7.5', rx0 - 8, f.top + f.h + 3, c.muted, 10, 'right');
      /* the true half, in accent */
      var hy = f.top + f.h * 0.5;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(cx - u * 1.05, hy);
      ctx.lineTo(cx + u * 1.05, hy);
      ctx.stroke();
      putText('1/2 · 3.75 heads', cx, hy - 9, c.accent, 12);
      /* how far off the tick landed */
      M = lerp(item.a, item.b, revealing.pairs[0].actual);
      off = (revealing.pairs[0].err * 100).toFixed(1) + '% off';
      putText(off, Math.min(W - 50, cx + u * 1.25), M.y + 4, c.ink, 11, 'left');
      return;
    }
    var nx = item.nx, ny = item.ny;
    for (i = 0; i < revealing.pairs.length; i++) {
      /* true division line + fraction label, in accent */
      P = lerp(item.a, item.b, item.ideals[i]);
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(P.x - nx * 14, P.y - ny * 14);
      ctx.lineTo(P.x + nx * 14, P.y + ny * 14);
      ctx.stroke();
      putText(item.labels[i], P.x + nx * 27, P.y + ny * 27 + 4, c.accent, 12);
      /* the player's mark, labeled with its % off, opposite side */
      M = lerp(item.a, item.b, revealing.pairs[i].actual);
      off = (revealing.pairs[i].err * 100).toFixed(1) + '% off';
      putText(off, M.x - nx * 27, M.y - ny * 27 + 4, c.ink, 11);
    }
  }

  /* First screen of the first round: a dashed ghost tick near the left
     end cap (obviously not the midpoint) shows the verb before a word
     of the hint is read. Gone the moment a real tick lands. */
  function drawDemo(c) {
    var p = lerp(item.a, item.b, 0.13);
    var nx = item.nx, ny = item.ny;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p.x - nx * 16, p.y - ny * 16);
    ctx.lineTo(p.x + nx * 16, p.y + ny * 16);
    ctx.stroke();
    ctx.restore();
    /* label left-aligned from just before the tick: item 1's segment is
       near-flat and its 13% point sits in the left half, so the text
       always has room to run right without clipping */
    putText('a tick, like this', p.x - 10, p.y + ny * 34 + 4, c.muted, 11, 'left');
  }

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (!item) return;
    if (item.kind === 'figure') drawFigure(c);
    else drawSegmentBase(c);
    if (playing && !revealing && !drawing && round === 1 && itemIdx === 0 && !item.ticks.length) drawDemo(c);
    drawTicks(c);
    if (drawing) {
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2.5;
      drawPolyline(strokePts);
    }
    if (revealing) drawReveal(c);
  }

  /* ============================================================
     Input: short drawn ticks, pointerId-guarded, undoable.
     ============================================================ */
  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  function updateUndo() {
    btnUndo.disabled = !(playing && !revealing && item && item.ticks.length > 0);
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!playing || revealing || drawing || !item) return;
    if (item.ticks.length >= item.required) return; /* grace: undo or wait */
    ev.preventDefault();
    activeId = ev.pointerId;
    drawing = true;
    strokePts = [pointerPos(ev)];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!drawing || ev.pointerId !== activeId) return;
    ev.preventDefault();
    strokePts.push(pointerPos(ev));
    draw();
  });

  function endTick(ev) {
    if (!drawing || ev.pointerId !== activeId) return;
    ev.preventDefault();
    drawing = false;
    var pts = strokePts;
    strokePts = [];
    /* accidental tap — ignore, never penalize */
    if (pts.length < MIN_SAMPLES || pathLength(pts) < MIN_TICK_LEN) {
      hint.textContent = itemHint().replace(/ —.*$/, '') + ' — just a tap; draw a short stroke across it.';
      draw();
      return;
    }
    var m = strokeFraction(pts, item.a, item.b);
    /* stroke nowhere near the thing being measured — ignore, no penalty */
    if (m.dist > item.maxDist) {
      hint.textContent = itemHint().replace(/ —.*$/, '') +
        ' — tick across the ' + (item.kind === 'figure' ? 'figure' : 'line') + ' itself.';
      draw();
      return;
    }
    item.ticks.push({ points: pts, frac: m.frac });
    updateUndo();
    if (item.ticks.length >= item.required) {
      hint.textContent = 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND + ' — scoring… undo still works.';
      clearTimeout(graceTimer);
      graceTimer = setTimeout(scoreItem, GRACE_MS);
    } else {
      hint.textContent = itemHint();
    }
    draw();
  }
  canvas.addEventListener('pointerup', endTick);
  /* fallback if pointer capture failed and the release lands off-canvas */
  window.addEventListener('pointerup', endTick);

  canvas.addEventListener('pointercancel', function () {
    /* interrupted stroke (system gesture etc.) — reset, no penalty */
    if (!drawing) return;
    drawing = false;
    strokePts = [];
    if (playing && !revealing) hint.textContent = itemHint();
    draw();
  });

  function undo() {
    if (!playing || revealing || !item || !item.ticks.length) return;
    clearTimeout(graceTimer);
    graceTimer = null;
    item.ticks.pop();
    hint.textContent = itemHint();
    updateUndo();
    draw();
  }
  btnUndo.addEventListener('click', undo);
  window.addEventListener('keydown', function (ev) {
    if (ev.key === 'z' || ev.key === 'Z' || ev.key === 'u' || ev.key === 'U') undo();
  });

  /* ============================================================
     Score → reveal → advance.
     ============================================================ */
  function scoreItem() {
    graceTimer = null;
    if (!playing || !item || item.ticks.length < item.required) return;
    var fracs = [], i;
    for (i = 0; i < item.ticks.length; i++) fracs.push(item.ticks[i].frac);
    var sc = itemScore(fracs, item.ideals);
    itemScores.push(sc);
    /* The round is complete right here, not after the last reveal —
       report now so an interrupting "new round" can't swallow it. */
    if (itemScores.length === ITEMS_PER_ROUND) {
      roundResult = ArtDaily.report(roundScore(itemScores));
      hudBest.textContent = roundResult.best === null ? '–' : String(roundResult.best);
    }
    revealing = { score: Math.round(sc), pairs: pairMarks(fracs, item.ideals) };
    updateUndo();
    hint.textContent = 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND + ' — ' + revealing.score +
      (item.kind === 'figure' ? '. half a figure = 3.75 of its 7.5 heads.' : '. mint lines are the true divisions.');
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(nextStep, item.kind === 'figure' ? REVEAL_FIGURE_MS : REVEAL_MS);
  }

  function nextStep() {
    if (!revealing) return;
    revealing = null;
    itemIdx += 1;
    if (itemIdx < ITEMS_PER_ROUND) {
      makeItem(itemIdx);
      draw();
      return;
    }
    finishRound();
  }

  function finishRound() {
    playing = false;
    item = null;
    updateUndo();
    draw();
    /* reported in scoreItem when the 6th item landed; just show it */
    var res = roundResult || ArtDaily.report(roundScore(itemScores));
    roundResult = null;
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — press "new round" to go again.';
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () {
    fitCanvas();
    /* re-place the current item so it always fits the new canvas;
       placed ticks reset with it (their fractions belonged to the
       old geometry) — makeItem also clears any pending grace timer */
    if (playing && !revealing && !drawing && item) makeItem(itemIdx);
    draw();
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
