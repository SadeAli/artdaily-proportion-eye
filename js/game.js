/* ============================================================
   game.js — Proportion Eye: divide lengths by eye, answer with
   the hand. Six items per round, every answer is a short drawn
   tick across the thing being measured: midpoint of a bare
   segment, both thirds, both thirds of a steep one, a stated ratio
   like 5/8 from the left end, half a standing figure's height, and
   a midpoint again — the round ends on a win, not on arithmetic.
   A tick near the line is snapped onto it rather than refused, and
   ticks stay undoable for 1.8s before the item scores itself.
   All scoring is pure fraction geometry with an absolute pixel
   floor under both windows (ArtDaily.ease) — the functions at the
   top take numbers in and return 0–100, no canvas, no DOM.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'proportion-eye';
  var ITEMS_PER_ROUND = 6;
  var MIN_SAMPLES = 2;      /* fewer sampled points = accidental tap  */
  var MIN_TICK_LEN = 6;     /* px of drawn path below this = a tap    */
  /* A hand slips. Scoring the item 0.4s later, while the hint was still
     saying "undo still works", meant nobody ever could. */
  var GRACE_MS = 1800;
  var REVEAL_MS = 3200;
  var REVEAL_FIGURE_MS = 4800; /* the head-unit ruler needs a beat    */
  var PERFECT_ZONE = 0.01;  /* err within 1% of the length is perfect */
  var ZERO_AT = 0.10;       /* beyond perfect zone, 10% more = zero   */
  /* …but never a window tighter than the input device's own noise:
     1% of a 215px phone segment is 2.15px, and a fingertip's reported
     centroid wanders ±3–5px. Both floors are eased per input mode. */
  var PERFECT_FLOOR_PX = 3;
  var ZERO_FLOOR_PX = 20;
  var HIT_SLOP_PX = 48;     /* how far off the line a tick may be drawn */
  var SNAP_FACTOR = 3;      /* …and 3× that is snapped on, not refused  */

  /* The round ends on a midpoint, not on arithmetic: a beginner should
     finish on the item they are best at. */
  var ITEM_KINDS = ['mid-flat', 'thirds-flat', 'thirds-steep', 'ratio', 'figure', 'mid-angled'];

  /* ============================================================
     Pure scoring — fractions in, 0–100 out. Unit-testable.
     ============================================================ */
  /* NaN-safe, the way vp-hunt's and anatomy-spot's twins already are.
     Math.max/Math.min PROPAGATE NaN, so the old pair let one through
     untouched — and projFraction ends in a clamp01, which meant a
     non-finite point came back out as a non-finite FRACTION rather than
     as a refusal. That fraction is the tick's mark: pairMarks reads a
     non-finite mark as a missing one and scores a tick the player really
     drew a flat 0, with the reveal drawing its label nowhere.
     The sample pipeline no longer lets a non-finite point get this far
     (pushSamples drops them), so this is the second of two layers, and it
     is the identity on every value the drill actually produces: markScore
     has already checked errPx is finite and span > 0 before it calls
     this, and projFraction's argument is finite whenever its point is. */
  function clamp01(v) { return v > 0 ? (v < 1 ? v : 1) : 0; }

  /* The perfect zone and the ramp, in pixels of the measured length:
     the relative rule, floored so the drill is not stricter on a small
     screen than on a big one for exactly the same question. floorPx
     arrives already eased for the player's hardware. */
  function perfectPx(lenPx, floorPx) {
    return Math.max(PERFECT_ZONE * lenPx, floorPx > 0 ? floorPx : 0);
  }

  function spanPx(lenPx, floorPx) {
    return Math.max(ZERO_AT * lenPx, floorPx > 0 ? floorPx : 0);
  }

  /* errPx = |actual − ideal| in px along the measured length.
     Non-finite err (missing/garbage mark) scores 0, never NaN. */
  function markScore(errPx, perfect, span) {
    if (typeof errPx !== 'number' || !isFinite(errPx) || !(span > 0)) return 0;
    var e = Math.max(0, errPx - (perfect > 0 ? perfect : 0));
    return 100 * clamp01(1 - e / span);
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

  /* Item = mean of its marks' scores. lenPx is the measured length, so
     the fraction errors become pixels and can meet their floors. */
  function itemScore(actuals, ideals, lenPx, perfect, span) {
    var pairs = pairMarks(actuals, ideals);
    var sum = 0, i;
    for (i = 0; i < pairs.length; i++) sum += markScore(pairs[i].err * lenPx, perfect, span);
    return pairs.length ? sum / pairs.length : 0;
  }

  /* Round = mean of its items' scores. itemScore can only hand this finite
     0–100 values, but this mean is what reaches ArtDaily.report — and from
     there the permanent personal best — as well as the HUD after every
     single item, and it had no sanitizing layer at all: one bad item would
     print the literal text "NaN" and store it as a best no round could ever
     beat. Clamped as well as finiteness-checked, the way vp-hunt's,
     horizon-read's and anatomy-spot's twins already are, because a finite
     "3e+307 / 100" is no better on the HUD than a NaN. The identity on
     every value this drill has ever produced. */
  function roundScore(scores) {
    if (!scores.length) return 0;
    var sum = 0, i, v;
    for (i = 0; i < scores.length; i++) {
      v = scores[i];
      sum += (typeof v === 'number' && isFinite(v)) ? Math.max(0, Math.min(100, v)) : 0;
    }
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

  /* WHICH WAY the tick missed — the reveal's one sentence used to be the
     bare score ("item 1 of 6 — 87."), which is a grade, not a lesson, and
     87 of what was not even stated. The % and the px are already painted
     on the sheet under their own labels; the direction is the thing a
     player can DO differently on item 2. Compares the two marks where
     they actually sit, so it stays honest on a steep segment (above /
     below) as well as a flat one (left / right). Pure: two points in,
     English out, non-finite-safe. */
  function tickDirection(mark, truth) {
    if (!mark || !truth) return '';
    var dx = mark.x - truth.x, dy = mark.y - truth.y;
    if (!isFinite(dx) || !isFinite(dy)) return '';
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return 'right on it';
    return Math.abs(dx) >= Math.abs(dy)
      ? (dx < 0 ? 'left of it' : 'right of it')
      : (dy < 0 ? 'above it' : 'below it');
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

  /* getComputedStyle() on the root forces a style resolve, and this ran at
     the top of every repaint — once per pointer sample while a tick is
     under the hand — plus two hex parses and a mix for the accent. The
     tokens only move when the sheet flips theme, so cache them against
     data-theme; the cache invalidates itself the moment that attribute
     changes, so onTheme still repaints in the new colours. */
  var inkCache = null, inkKey = null;
  function inks() {
    var key = document.documentElement.dataset.theme || '';
    if (inkCache && inkKey === key) return inkCache;
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--mint').trim();
    inkKey = key;
    inkCache = {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: ArtDaily.theme() === 'light' ? mixHex(accent, ink, 0.55) : accent,
    };
    return inkCache;
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ----
     Returns true only when the sheet really changed size: assigning
     canvas.width reallocates and clears the backing store, and `resize`
     fires on every address-bar nudge on a phone. */
  var W = 0, H = 0, fitDpr = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var dpr = window.devicePixelRatio || 1;
    if (w === W && dpr === fitDpr) return false;
    W = w;
    H = Math.round(W * 0.62);
    fitDpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /* ---- one repaint per frame ----
     A pointermove can arrive two or three times inside one displayed
     frame, and this drill takes COALESCED samples — so a single move can
     carry four more points and used to trigger a full redraw of the
     figure (head, torso, four limbs, the head-unit ruler) for each one.
     Only the last is ever shown. One rAF paints on the same vsync and
     keeps a 6px flick tick feeling instant. */
  var drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; draw(); });
  }

  /* ---- round state ---- */
  var round = 0, itemIdx = 0, itemScores = [], item = null, playing = false;
  var drawing = false, strokePts = [], activeId = null, activeType = '', revealing = null;
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
  /* On a narrow sheet the ruler gets longer and the margins thinner
     rather than the tolerance getting tighter: the same question should
     be the same question on a phone. */
  function segGeom(angDeg, fracLo, fracHi) {
    var small = W < 520;
    var margin = small ? 18 : 36;
    var len = W * rand(fracLo, fracHi) * (small ? 1.18 : 1);
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

  /* Difficulty ramps within the round and then comes back down: an easy
     long midpoint → thirds → steep thirds → a stated ratio → the figure
     → a midpoint again, so the round ends on the item beginners are
     best at instead of on arithmetic. */
  function makeItem(idx) {
    clearTimeout(graceTimer);
    graceTimer = null;
    var kindName = ITEM_KINDS[idx] || 'mid-flat';
    var g, n, r;
    if (kindName === 'figure') {
      var h = H * 0.8;
      var u = h / 7.5;
      var top = H * 0.085;
      var cx = W * rand(0.34, 0.66);
      item = {
        kind: 'figure',
        a: { x: cx, y: top }, b: { x: cx, y: top + h },
        nx: 1, ny: 0,
        ideals: [0.5], labels: ['1/2'], required: 1,
        maxDist: Math.max(ArtDaily.startRadius(70), u * 2),
        ticks: [],
        fig: { cx: cx, top: top, h: h, u: u },
      };
    } else {
      var kind = 'seg', ideals = [0.5], labels = ['1/2'];
      if (kindName === 'mid-flat') g = segGeom(rand(-8, 8), 0.62, 0.78);
      else if (kindName === 'mid-angled') g = segGeom(Math.random() < 0.5 ? rand(25, 65) : rand(115, 155), 0.42, 0.58);
      else if (kindName === 'thirds-flat') { g = segGeom(rand(-10, 10), 0.58, 0.75); ideals = [1 / 3, 2 / 3]; labels = ['1/3', '2/3']; }
      else if (kindName === 'thirds-steep') { g = segGeom(rand(58, 122), 0.5, 0.68); ideals = [1 / 3, 2 / 3]; labels = ['1/3', '2/3']; }
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
        /* a screenless tablet cannot see its own hand: the zone a tick
           may land in is widened for exactly that instrument, and a
           press up to 3× out is snapped onto the line rather than
           refused (see endTick) */
        maxDist: ArtDaily.startRadius(HIT_SLOP_PX),
        ticks: [],
      };
    }
    item.len = Math.hypot(item.b.x - item.a.x, item.b.y - item.a.y);
    hint.textContent = itemHint();
    updateUndo();
  }

  function itemHint() {
    var lbl = 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND + ' — ';
    if (!item) return '';
    if (item.kind === 'figure') {
      return lbl + 'tick across the figure at half its whole height, crown to soles. ' +
        'the marks beside it are one head tall each — count them.';
    }
    if (item.kind === 'ratio') return lbl + 'tick ' + item.labels[0] + ' of the way from the left end.';
    /* "TICK BOTH THIRDS" IS TWO CUTS, NOT THREE PIECES — and item 2 is the
       first time the drill has asked for anything but a midpoint, roughly
       thirty seconds in. Read as "the thirds" it sounds like the parts, so
       the natural wrong move is one tick in the middle of a third. Gloss it
       the same way item 1 glosses "midpoint (halfway along)", and only on
       the item where the phrase is new — items 3 and 6 ask again and by
       then the reveal has already drawn both answers. */
    if (item.required === 2) {
      return lbl + 'tick both thirds of the line' +
        (itemIdx === 1 ? ' — the two cuts that split it into three equal parts' : '') +
        ' (' + item.ticks.length + ' of 2 placed).';
    }
    return lbl + 'draw a tick across the line at its midpoint (halfway along).';
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
    /* The measuring tool, unlabeled, while the guess is still open: the
       height is some number of these marks. Naming that number — and
       where half of it lands — stays the reveal's job. */
    if (!revealing) {
      ctx.save();
      /* same 0.5 the dashed extent guides use — muted at full alpha is
         5.2:1 on the paper card, so this stays clear of the 3:1 bar for
         a mark the player is meant to count */
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      var rx = cx - u * 1.5, q;
      ctx.beginPath();
      ctx.moveTo(rx, f.top);
      ctx.lineTo(rx, f.top + f.h);
      ctx.stroke();
      for (q = 1; q <= 7; q++) {
        ctx.beginPath();
        ctx.moveTo(rx - 3, f.top + q * u);
        ctx.lineTo(rx + 3, f.top + q * u);
        ctx.stroke();
      }
      ctx.restore();
    }
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

  /* "3.2% off" on a short phone segment is ~7px — a distance the player
     could not have controlled. Say both, so the feedback is honest about
     what was actually achievable on this screen. */
  function offLabel(err) {
    if (!isFinite(err)) return 'no mark';
    return (err * 100).toFixed(1) + '% off · ' + Math.round(err * item.len) + 'px';
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
      off = offLabel(revealing.pairs[0].err);
      putText(off, Math.min(W - 62, cx + u * 1.25), M.y + 4, c.ink, 11, 'left');
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
      off = offLabel(revealing.pairs[i].err);
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
  /* getBoundingClientRect() is a layout read, and this used to run once
     per SAMPLE — with coalesced events that is four or five layout reads
     inside a single pointermove. The sheet cannot move under a live tick
     without a scroll or a resize, and the hint line above it only
     re-wraps between items, so measure once per gesture and drop the
     measurement on scroll or resize. */
  var canvasRect = null;
  function dropRect() { canvasRect = null; }
  window.addEventListener('scroll', dropRect, true);

  function pointerPos(ev) {
    var r = canvasRect || (canvasRect = canvas.getBoundingClientRect());
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /* A 6px tick can be one flick: without coalesced samples it lands
     under the sample floor and is thrown away as "just a tap".
     (ArtDaily.samples is the SDK's version of exactly this: every position
     the move really carried, oldest first, and [ev] where the browser
     cannot coalesce. Same behaviour, one implementation.)

     NON-FINITE SAMPLES ARE DROPPED, not stored. Nothing downstream can
     survive one: segCrossFraction divides by a NaN determinant, and NaN
     fails `denom === 0` and then fails all four of the t/u range tests, so
     it does not return null the way a real miss does — it returns NaN as a
     crossing. strokeFraction hands that straight back as the tick's
     fraction, pairMarks reads a non-finite mark as a MISSING one, and a
     tick the player really drew across the line scores a flat 0 with the
     reveal drawing nothing where it landed. Sweeping one bad sample across
     a 72-sample tick, 36 of the 72 positions do this — every position
     ahead of the crossing. The next sample is 4ms away; skip the bad one.

     They are deliberately NOT thinned to a minimum spacing the way
     vp-hunt's and perspective's are. Those two fit a LINE to their
     samples, where even spacing is what stops a slow patch outvoting the
     stroke; this drill measures pathLength against a 6px floor to tell a
     tick from a tap, and thinning replaces the drawn wiggle with its
     chord. Measured at 2px spacing: 210 of 4000 genuinely short ticks
     dropped under the floor and came back as "just a tap; draw a short
     stroke across it" — a refusal aimed at a player who did exactly what
     was asked. */
  function pushSamples(ev, arr) {
    var list = ArtDaily.samples(ev), i, p;
    for (i = 0; i < list.length; i++) {
      p = pointerPos(list[i]);
      if (isFinite(p.x) && isFinite(p.y)) arr.push(p);
    }
  }

  /* Palm rejection: the old guard let whichever pointer arrived first
     own the tick, which on a tablet is the palm. */
  var penAt = -Infinity, PEN_GUARD_MS = 900;
  function claimAllowed(ev) {
    if (ev.pointerType === 'pen') { penAt = performance.now(); return true; }
    if (ev.pointerType === 'touch' && performance.now() - penAt < PEN_GUARD_MS) return false;
    return true;
  }

  function updateUndo() {
    btnUndo.disabled = !(playing && !revealing && item && item.ticks.length > 0);
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (!playing || !item) return;
    dropRect();                  /* a fresh gesture re-measures the sheet */
    if (revealing) {
      /* tap to move on — the reveal is the lesson, so it is read at the
         player's pace, not the timer's (350ms swallow so the release
         that just placed a tick cannot skip its own feedback) */
      if (performance.now() - revealing.at > 350) nextStep();
      return;
    }
    if (!claimAllowed(ev)) return;
    if (drawing) {
      if (ev.pointerType !== 'pen' || activeType === 'pen') return;
      strokePts = []; /* a pen outranks the palm that got here first */
    }
    if (item.ticks.length >= item.required) return; /* grace: undo or wait */
    ev.preventDefault();
    activeId = ev.pointerId;
    activeType = ev.pointerType || '';
    drawing = true;
    /* the opening sample gets the same finiteness check the rest of the
       stroke does — a broken first press must not seed the tick with a
       NaN the whole path then inherits. An empty start is harmless: the
       moves fill it, and a stroke that never lands a finite sample reads
       as the tap it was. */
    var p0 = pointerPos(ev);
    strokePts = (isFinite(p0.x) && isFinite(p0.y)) ? [p0] : [];
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (!drawing || ev.pointerId !== activeId) return;
    ev.preventDefault();
    pushSamples(ev, strokePts);
    requestDraw();
  });

  function endTick(ev) {
    if (!drawing || ev.pointerId !== activeId) return;
    ev.preventDefault();
    drawing = false;
    activeType = '';
    var pts = strokePts;
    strokePts = [];
    /* accidental tap — ignore, never penalize */
    if (pts.length < MIN_SAMPLES || pathLength(pts) < MIN_TICK_LEN) {
      hint.textContent = itemHint().replace(/ —.*$/, '') + ' — just a tap; draw a short stroke across it.';
      draw();
      return;
    }
    var m = strokeFraction(pts, item.a, item.b);
    /* Snap rather than refuse. Inside the zone the tick is taken as
       drawn; out to 3× it is still taken — projected onto the line,
       which is what the eye meant — and only beyond that is it read as
       a stroke aimed at something else. A screenless tablet cannot see
       its own hand, and a refusal it cannot explain reads as "broken". */
    if (m.dist > item.maxDist * SNAP_FACTOR) {
      hint.textContent = itemHint().replace(/ —.*$/, '') +
        ' — that one landed away from the ' + (item.kind === 'figure' ? 'figure' : 'line') +
        ', so it was not counted. tick across it and it counts wherever it crosses.';
      draw();
      return;
    }
    item.ticks.push({ points: pts, frac: m.frac });
    updateUndo();
    if (item.ticks.length >= item.required) {
      hint.textContent = 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND + ' — ' +
        (m.dist > item.maxDist ? 'pulled onto the line for you; ' : '') +
        'scoring in a moment, "undo" still works.';
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

  function cancelTick(ev) {
    /* interrupted stroke (system gesture etc.) — reset, no penalty */
    if (!drawing) return;
    if (ev && ev.pointerId !== undefined && ev.pointerId !== activeId) return;
    drawing = false;
    activeType = '';
    strokePts = [];
    if (playing && !revealing) hint.textContent = itemHint();
    draw();
  }
  canvas.addEventListener('pointercancel', cancelTick);
  window.addEventListener('pointercancel', cancelTick);
  /* A CAPTURE THE CANVAS LOSES WITHOUT EVER SEEING A RELEASE. iOS drops
     pointer capture to a system gesture and fires lostpointercapture with
     no pointerup and no pointercancel behind it — and `drawing` stays true
     for good. pointerdown then reads that as "a stroke is already in
     flight" and returns on every later press (only a pen outranks it), so
     the sheet goes permanently dead: no tick can be drawn, the item can
     never reach its required count, and the round stalls with no way out
     but "new round". Replayed as a state machine, all four presses after
     the steal were refused and no tick landed; with this line all of them
     are taken. The five sibling drills each carry this guard; this one was
     the only drag drill without it.
     It abandons rather than scores, exactly as perspective does: a lost
     capture has no honest release position. Behind a real pointerup it is
     a no-op — `drawing` is already false — and cancelTick ignores any
     pointer that is not the one holding the tick, so a stray second finger
     losing capture cannot wipe a live stroke. */
  canvas.addEventListener('lostpointercapture', cancelTick);

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
    var sc = itemScore(fracs, item.ideals, item.len,
      perfectPx(item.len, ArtDaily.ease(PERFECT_FLOOR_PX)),
      spanPx(item.len, ArtDaily.ease(ZERO_FLOOR_PX)));
    itemScores.push(sc);
    /* The round is complete right here, not after the last reveal —
       report now so an interrupting "new round" can't swallow it. */
    if (itemScores.length === ITEMS_PER_ROUND) {
      roundResult = ArtDaily.report(roundScore(itemScores));
      hudBest.textContent = roundResult.best === null ? '–' : String(roundResult.best);
    }
    /* a running mean, so the round is never six items of silence */
    hudScore.textContent = String(Math.round(roundScore(itemScores)));
    revealing = { score: Math.round(sc), pairs: pairMarks(fracs, item.ideals), at: performance.now() };
    updateUndo();
    var dir = item.required === 1
      ? tickDirection(lerp(item.a, item.b, revealing.pairs[0].actual),
        lerp(item.a, item.b, item.ideals[0]))
      : '';
    hint.textContent = 'item ' + (itemIdx + 1) + ' of ' + ITEMS_PER_ROUND + ' — ' +
      revealing.score + '/100' + (dir ? ', your tick landed ' + dir : '') +
      (item.kind === 'figure'
        ? '. half a figure = 3.75 of its 7.5 heads. tap to continue.'
        : item.required === 1
          ? '. the coloured line is the true ' + item.labels[0] + '. tap to continue.'
          : '. the coloured lines are the true divisions. tap to continue.');
    draw();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(nextStep, item.kind === 'figure' ? REVEAL_FIGURE_MS : REVEAL_MS);
  }

  function nextStep() {
    if (!revealing) return;
    clearTimeout(revealTimer);
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
  /* An unfinished round is never reported, so a stray press here binned
     every item already ticked without a word — and "new round" sits
     directly under a canvas the player has been tapping to advance
     reveals, which is exactly where a mis-tap lands. First press arms,
     second confirms. Once the sixth item has scored the round is already
     in the books (scoreItem reported it), so no question then. */
  var btnRound = document.getElementById('btnRound');
  var btnRoundHTML = btnRound.innerHTML;
  var roundArmed = false, roundArmTimer = null;

  function disarmRoundBtn() {
    roundArmed = false;
    clearTimeout(roundArmTimer);
    btnRound.innerHTML = btnRoundHTML;
  }

  btnRound.addEventListener('click', function () {
    if (playing && itemScores.length > 0 && itemScores.length < ITEMS_PER_ROUND && !roundArmed) {
      roundArmed = true;
      btnRound.textContent = 'discard round?';
      clearTimeout(roundArmTimer);
      roundArmTimer = setTimeout(disarmRoundBtn, 2600);
      return;
    }
    disarmRoundBtn();
    newRound();
  });

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  ArtDaily.onInput(function () { draw(); });

  /* The sheet scales uniformly (H tracks W), so a resize is a rescale of
     what is already there — never a regeneration. Regenerating meant an
     iOS address bar collapsing during an ordinary scroll silently
     deleted a placed tick AND swapped the question. */
  function scaleItem(f) {
    var i, j, t;
    item.a.x *= f; item.a.y *= f;
    item.b.x *= f; item.b.y *= f;
    item.len *= f;
    item.maxDist *= f;
    if (item.fig) {
      item.fig.cx *= f; item.fig.top *= f; item.fig.h *= f; item.fig.u *= f;
    }
    for (i = 0; i < item.ticks.length; i++) {
      t = item.ticks[i];
      for (j = 0; j < t.points.length; j++) { t.points[j].x *= f; t.points[j].y *= f; }
      /* t.frac is a fraction of the length — scale-invariant, kept */
    }
    for (j = 0; j < strokePts.length; j++) { strokePts[j].x *= f; strokePts[j].y *= f; }
  }

  window.addEventListener('resize', function () {
    dropRect();
    var oldW = W;
    /* fitCanvas is a no-op when the sheet did not really change, so an
       address-bar nudge no longer reallocates the backing store under a
       tick in progress. */
    if (!fitCanvas()) { draw(); return; }
    if (Math.abs(W - oldW) < 4) { draw(); return; } /* mobile URL-bar jitter */
    if (item && oldW > 0 && W !== oldW) scaleItem(W / oldW);
    draw();
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
