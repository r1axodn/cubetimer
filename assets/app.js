/* app.js — timer, sessions, statistics, rendering. */
(function () {
  'use strict';

  var STORE_KEY = 'cubetimer:v1';
  var HOLD_MS = 300;
  var INSPECT_LIMIT = 15;
  var INSPECT_DNF = 17;
  var MAX_CHART = 50;

  var EVENT_LABEL = { 222: '2x2x2', 333: '3x3x3', 444: '4x4x4', pyra: 'Pyraminx' };
  var DEFAULT_SETTINGS = { inspection: false, beep: true, precision: 2, target: 30, theme: 'dark' };

  var state = {
    event: '333',
    settings: Object.assign({}, DEFAULT_SETTINGS),
    sessions: {}
  };

  var scrambleBook = {};
  var detailId = null;

  var timer = {
    phase: 'idle',      // idle | holding | ready | inspect | running
    startTime: 0,
    holdStart: 0,
    holdTimer: 0,
    raf: 0,
    inspecting: false,
    inspectStart: 0,
    inspectTimer: 0,
    beeped: {},
    pendingPenalty: null
  };

  var el = {};

  /* ---------------- storage ---------------- */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data && data.settings) state.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      if (data && data.event) state.event = data.event;
      if (data && data.sessions && typeof data.sessions === 'object') state.sessions = data.sessions;
    } catch (err) {
      /* Corrupt data — start fresh rather than break the timer. */
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        version: 1,
        event: state.event,
        settings: state.settings,
        sessions: state.sessions
      }));
    } catch (err) {
      /* Private mode or full quota: the timer keeps working in memory. */
    }
  }

  function ensureEvent(ev) {
    if (!state.sessions[ev] || typeof state.sessions[ev] !== 'object') {
      state.sessions[ev] = { active: null, list: [] };
    }
    var bucket = state.sessions[ev];
    if (!Array.isArray(bucket.list)) bucket.list = [];
    bucket.list = bucket.list.filter(function (s) { return s && s.id; });
    bucket.list.forEach(function (s) { if (!Array.isArray(s.solves)) s.solves = []; });
    if (!bucket.list.length) {
      bucket.list.push({ id: uid(), name: '세션 1', solves: [] });
    }
    var found = bucket.list.some(function (s) { return s.id === bucket.active; });
    if (!found) bucket.active = bucket.list[0].id;
    return bucket;
  }

  function session() {
    var bucket = ensureEvent(state.event);
    for (var i = 0; i < bucket.list.length; i++) {
      if (bucket.list[i].id === bucket.active) return bucket.list[i];
    }
    return bucket.list[0];
  }

  function solves() {
    return session().solves;
  }

  /* ---------------- formatting ---------------- */

  function precision() {
    return state.settings.precision === 3 ? 3 : 2;
  }

  function fmtTime(ms) {
    if (ms === null || ms === undefined) return 'DNF';
    var p = precision();
    var sec = ms / 1000;
    if (sec >= 60) {
      var m = Math.floor(sec / 60);
      var rest = sec - m * 60;
      return m + ':' + (rest < 10 ? '0' : '') + rest.toFixed(p);
    }
    return sec.toFixed(p);
  }

  function fmtAvg(avg) {
    if (avg === undefined) return { text: '—', cls: 'is-empty' };
    if (avg.dnf) return { text: 'DNF', cls: 'is-dnf' };
    return { text: fmtTime(avg.value), cls: '' };
  }

  function dateText(ts) {
    var d = new Date(ts);
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* ---------------- scrambles ---------------- */

  function book(ev) {
    if (!scrambleBook[ev]) scrambleBook[ev] = { list: [], idx: -1 };
    return scrambleBook[ev];
  }

  function currentScramble() {
    var b = book(state.event);
    if (b.idx < 0 || !b.list.length) makeScramble();
    return b.list[b.idx] || '';
  }

  function makeScramble() {
    var b = book(state.event);
    b.list = b.list.slice(0, b.idx + 1);
    b.list.push(Scramble.generate(state.event).text);
    if (b.list.length > 300) b.list = b.list.slice(-200);
    b.idx = b.list.length - 1;
    renderScramble();
    renderNet();
  }

  function stepScramble(delta) {
    var b = book(state.event);
    var next = b.idx + delta;
    if (next < 0) return;
    if (next >= b.list.length) {
      makeScramble();
      return;
    }
    b.idx = next;
    renderScramble();
    renderNet();
  }

  /* ---------------- rendering: scramble & net ---------------- */

  function renderScramble() {
    var b = book(state.event);
    el.scrambleText.textContent = currentScramble() || '—';
    el.scrambleCounter.textContent = b.list.length ? (b.idx + 1) + ' / ' + b.list.length : '';
    el.prevScramble.disabled = b.idx <= 0;
  }

  function renderNet() {
    var ev = state.event;
    var net = el.net;
    net.innerHTML = '';
    net.removeAttribute('style');
    net.className = 'net';
    if (ev === 'pyra') {
      net.style.display = 'block';
      var note = document.createElement('p');
      note.className = 'net-note';
      note.textContent = 'Pyraminx는 2D 전개도 없이 스크램블 표기만 제공합니다.';
      net.appendChild(note);
      return;
    }
    var n = ev === '222' ? 2 : ev === '444' ? 4 : 3;
    net.classList.add('n' + n);
    var text = currentScramble();
    var cube;
    try {
      cube = new CubeModel.Cube(n).apply(Scramble.parse(text));
    } catch (err) {
      return;
    }
    var faces = cube.facelets();
    ['U', 'L', 'F', 'R', 'B', 'D'].forEach(function (face) {
      var wrap = document.createElement('div');
      wrap.className = 'net-face f-' + face.toLowerCase();
      wrap.style.gridTemplateColumns = 'repeat(' + n + ', 1fr)';
      wrap.style.gridTemplateRows = 'repeat(' + n + ', 1fr)';
      var colors = faces[face];
      for (var i = 0; i < n * n; i++) {
        var cell = document.createElement('div');
        cell.className = 'st';
        cell.style.background = CubeModel.COLORS[colors[i]] || '#666';
        wrap.appendChild(cell);
      }
      net.appendChild(wrap);
    });
  }

  /* ---------------- rendering: statistics ---------------- */

  function statTile(key, value, opts) {
    opts = opts || {};
    var d = document.createElement('div');
    d.className = 'stat' + (opts.primary ? ' primary' : '');
    if (opts.title) d.title = opts.title;
    var k = document.createElement('span');
    k.className = 'stat-k';
    k.textContent = key;
    var v = document.createElement('span');
    v.className = 'stat-v' + (value.cls ? ' ' + value.cls : '');
    v.textContent = value.text;
    d.appendChild(k);
    d.appendChild(v);
    return d;
  }

  function renderStats() {
    var list = solves();
    var st = Stats.compute(list);
    var grid = el.statsGrid;
    grid.innerHTML = '';

    var last = st.lastSolve ? (Stats.effective(st.lastSolve) == null
      ? { text: 'DNF', cls: 'is-dnf' }
      : { text: fmtTime(Stats.effective(st.lastSolve)), cls: '' })
      : { text: '—', cls: 'is-empty' };

    grid.appendChild(statTile('최근', last));
    grid.appendChild(statTile('최고 기록', st.best == null
      ? { text: '—', cls: 'is-empty' }
      : { text: fmtTime(st.best), cls: '' }, { primary: true }));

    grid.appendChild(statTile('평균 5', fmtAvg(st.ao5), { title: '최근 5개에서 최고·최저 1개씩 제외' }));
    grid.appendChild(statTile('평균 5 최고', fmtAvg(st.ao5best), { title: '세션 내 가장 좋은 평균 5' }));
    grid.appendChild(statTile('평균 12', fmtAvg(st.ao12), { title: '최근 12개에서 최고·최저 1개씩 제외' }));
    grid.appendChild(statTile('평균 12 최고', fmtAvg(st.ao12best), { title: '세션 내 가장 좋은 평균 12' }));
    grid.appendChild(statTile('평균 50', fmtAvg(st.ao50), { title: '최근 50개에서 상·하위 5%(3개)씩 제외' }));
    grid.appendChild(statTile('평균 100', fmtAvg(st.ao100), { title: '최근 100개에서 상·하위 5%(5개)씩 제외' }));
    grid.appendChild(statTile('세션 평균', fmtAvg(st.mean), { title: 'DNF가 하나라도 있으면 DNF' }));
    grid.appendChild(statTile('솔브', { text: st.completed + ' / ' + st.total, cls: st.total ? '' : 'is-empty' },
      { title: '완료 / 전체' }));

    el.statSession.textContent = session().name;
  }

  /* ---------------- rendering: chart ---------------- */

  function renderChart() {
    var list = solves();
    var data = list.slice(-MAX_CHART);
    el.chartCounter.textContent = data.length ? '최근 ' + data.length + '개' : '';
    el.targetPill.textContent = '목표 ' + state.settings.target + '초';
    var wrap = el.chartWrap;
    wrap.innerHTML = '';
    if (!data.length) {
      var p = document.createElement('p');
      p.className = 'chart-empty';
      p.textContent = '기록이 쌓이면 추이가 표시됩니다.';
      wrap.appendChild(p);
      return;
    }

    var W = 620, H = 200, padL = 40, padR = 12, padT = 14, padB = 24;
    var values = data.map(function (s) { return Stats.effective(s); });
    var valid = values.filter(function (v) { return v !== null; });
    var targetMs = Math.max(1, Number(state.settings.target) || 0) * 1000;
    var pool = valid.concat([targetMs]);
    var maxV = Math.max.apply(null, pool);
    var minV = Math.min.apply(null, pool);
    maxV *= 1.08;
    minV = Math.max(0, minV * 0.88);
    if (maxV - minV < 2000) { minV = Math.max(0, minV - 500); maxV = minV + 2500; }

    var n = data.length;
    var plotW = W - padL - padR;
    var plotH = H - padT - padB;
    var xAt = function (i) { return padL + (n === 1 ? plotW / 2 : (plotW * i) / (n - 1)); };
    var yAt = function (v) { return padT + plotH - ((v - minV) / (maxV - minV)) * plotH; };

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="기록 추이 그래프">');

    // grid
    for (var g = 0; g <= 2; g++) {
      var gv = minV + ((maxV - minV) * g) / 2;
      var gy = yAt(gv);
      svg.push('<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) +
        '" stroke="var(--chart-grid)" stroke-width="1"/>');
      svg.push('<text x="' + (padL - 7) + '" y="' + (gy + 3.5).toFixed(1) +
        '" text-anchor="end" font-size="9.5" fill="var(--dim)" font-family="ui-monospace,monospace">' +
        (gv / 1000).toFixed(1) + 's</text>');
    }

    // target line
    if (targetMs >= minV && targetMs <= maxV) {
      var ty = yAt(targetMs);
      svg.push('<line x1="' + padL + '" y1="' + ty.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + ty.toFixed(1) +
        '" stroke="var(--accent)" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>');
    }

    // line segments (breaks at DNF)
    var seg = [];
    var paths = [];
    for (var i = 0; i < n; i++) {
      var v = values[i];
      if (v === null) {
        if (seg.length > 1) paths.push(seg);
        seg = [];
        continue;
      }
      seg.push([xAt(i), yAt(v)]);
    }
    if (seg.length > 1) paths.push(seg);

    paths.forEach(function (pts) {
      var d = pts.map(function (pt, idx) {
        return (idx ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1);
      }).join(' ');
      svg.push('<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>');
    });

    // dots, DNF crosses
    for (var j = 0; j < n; j++) {
      var val = values[j];
      if (val === null) {
        var cx = xAt(j), cy = padT + 5;
        svg.push('<path d="M' + (cx - 3).toFixed(1) + ' ' + (cy - 3) + 'L' + (cx + 3).toFixed(1) + ' ' + (cy + 3) +
          'M' + (cx + 3).toFixed(1) + ' ' + (cy - 3) + 'L' + (cx - 3).toFixed(1) + ' ' + (cy + 3) +
          '" stroke="var(--red)" stroke-width="1.6" stroke-linecap="round"/>');
      } else if (n <= 30 || j === n - 1) {
        svg.push('<circle cx="' + xAt(j).toFixed(1) + '" cy="' + yAt(val).toFixed(1) + '" r="' + (j === n - 1 ? 3.2 : 2) +
          '" fill="var(--accent)"/>');
      }
    }

    // axis labels
    svg.push('<text x="' + padL + '" y="' + (H - 7) + '" font-size="9.5" fill="var(--dim)" font-family="ui-monospace,monospace">1</text>');
    if (n > 1) {
      svg.push('<text x="' + (W - padR) + '" y="' + (H - 7) + '" text-anchor="end" font-size="9.5" fill="var(--dim)" font-family="ui-monospace,monospace">' + n + '</text>');
    }
    if (valid.length) {
      var avg = valid.reduce(function (a, b) { return a + b; }, 0) / valid.length;
      svg.push('<text x="' + (W - padR) + '" y="' + (padT + 9) + '" text-anchor="end" font-size="9.5" fill="var(--muted)" font-family="ui-monospace,monospace">평균 ' + fmtTime(avg) + '</text>');
    }
    svg.push('</svg>');
    wrap.innerHTML = svg.join('');
  }

  /* ---------------- rendering: records ---------------- */

  function renderLast() {
    var list = solves();
    var last = list.length ? list[list.length - 1] : null;
    el.lastCard.hidden = false;
    if (!last) {
      el.lastTime.textContent = '—';
      el.lastBadge.hidden = true;
      el.lastActions.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      return;
    }
    el.lastActions.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
    var eff = Stats.effective(last);
    el.lastTime.textContent = eff == null ? 'DNF' : fmtTime(eff);
    if (last.penalty) {
      el.lastBadge.hidden = false;
      el.lastBadge.textContent = last.penalty;
      el.lastBadge.className = 'badge ' + (last.penalty === 'DNF' ? 'dnf' : 'plus2');
    } else {
      el.lastBadge.hidden = true;
    }
  }

  function renderList() {
    var list = solves();
    el.recordCount.textContent = list.length ? list.length + '개 · ' + EVENT_LABEL[state.event] : '';
    var ol = el.solveList;
    ol.innerHTML = '';
    if (!list.length) {
      var li = document.createElement('li');
      li.className = 'list-empty';
      li.textContent = '아직 기록이 없습니다. 스페이스바를 0.3초 이상 눌렀다 떼어 보세요.';
      ol.appendChild(li);
      return;
    }
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      var eff = Stats.effective(s);
      var row = document.createElement('li');
      row.className = 'solve-row';
      row.dataset.id = s.id;
      row.tabIndex = 0;

      var idx = document.createElement('span');
      idx.className = 'solve-idx';
      idx.textContent = '#' + (i + 1);

      var time = document.createElement('span');
      time.className = 'solve-time' + (eff == null ? ' dnf' : '');
      time.textContent = eff == null ? 'DNF' : fmtTime(eff);

      var badge = document.createElement('span');
      if (s.penalty) {
        badge.className = 'badge ' + (s.penalty === 'DNF' ? 'dnf' : 'plus2');
        badge.textContent = s.penalty;
      } else {
        badge.className = 'badge';
        badge.hidden = true;
      }

      var scr = document.createElement('span');
      scr.className = 'solve-scr';
      scr.textContent = s.scramble || '';

      var actions = document.createElement('span');
      actions.className = 'row-actions';
      [['plus2', '+2'], ['dnf', 'DNF'], ['del', '✕']].forEach(function (pair) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mini-btn' + (pair[0] === 'del' ? ' danger' : '');
        btn.dataset.act = pair[0];
        btn.textContent = pair[1];
        if ((pair[0] === 'plus2' && s.penalty === '+2') || (pair[0] === 'dnf' && s.penalty === 'DNF')) {
          btn.style.color = 'var(--accent)';
          btn.style.borderColor = 'var(--accent)';
        }
        actions.appendChild(btn);
      });

      row.appendChild(idx);
      row.appendChild(time);
      row.appendChild(badge);
      row.appendChild(scr);
      row.appendChild(actions);
      ol.appendChild(row);
    }
  }

  function renderSessions() {
    var bucket = ensureEvent(state.event);
    var sel = el.sessionSelect;
    sel.innerHTML = '';
    bucket.list.forEach(function (s) {
      var opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name + ' (' + s.solves.length + ')';
      sel.appendChild(opt);
    });
    sel.value = bucket.active;
    el.deleteSession.disabled = bucket.list.length <= 1;
  }

  function renderAll() {
    renderSessions();
    renderScramble();
    renderNet();
    renderStats();
    renderChart();
    renderList();
    renderLast();
    paint();
  }

  /* ---------------- timer paint ---------------- */

  function paint() {
    var zone = el.timerZone;
    zone.classList.remove('holding', 'ready', 'running', 'inspect', 'warn', 'danger');
    el.penaltyFlag.hidden = true;
    el.inspectFlag.hidden = true;

    if (timer.phase === 'idle') {
      var last = solves().length ? solves()[solves().length - 1] : null;
      var eff = last ? Stats.effective(last) : null;
      el.timer.textContent = last ? (eff == null ? 'DNF' : fmtTime(eff)) : fmtTime(0);
    } else if (timer.phase === 'holding') {
      zone.classList.add('holding');
      el.timer.textContent = fmtTime(0);
    } else if (timer.phase === 'ready') {
      zone.classList.add('ready');
      el.timer.textContent = fmtTime(0);
    } else if (timer.phase === 'inspect') {
      zone.classList.add('inspect');
      var elapsed = (performance.now() - timer.inspectStart) / 1000;
      var remain = Math.ceil(INSPECT_LIMIT - elapsed);
      el.timer.textContent = String(Math.max(0, remain));
      el.inspectFlag.hidden = false;
      el.inspectFlag.textContent = '인스펙션';
      if (elapsed >= 12) zone.classList.add('danger');
      else if (elapsed >= 8) zone.classList.add('warn');
      if (elapsed >= INSPECT_LIMIT) {
        el.penaltyFlag.hidden = false;
        el.penaltyFlag.textContent = elapsed >= INSPECT_DNF ? 'DNF' : '+2';
      }
    }
  }

  /* ---------------- audio ---------------- */

  var audioCtx = null;

  function beep(freq, dur) {
    if (!state.settings.beep) return;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var osc = audioCtx.createOscillator();
      var gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.07, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur / 1000);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + dur / 1000 + 0.02);
    } catch (err) {
      /* Audio is a nicety; the countdown still works without it. */
    }
  }

  /* ---------------- timer engine ---------------- */

  function clearHold() {
    if (timer.holdTimer) {
      clearTimeout(timer.holdTimer);
      timer.holdTimer = 0;
    }
  }

  function beginHold() {
    timer.phase = 'holding';
    timer.holdStart = performance.now();
    clearHold();
    timer.holdTimer = setTimeout(function () {
      if (timer.phase !== 'holding') return;
      timer.phase = 'ready';
      paint();
    }, HOLD_MS);
    paint();
  }

  function pressStart() {
    if (timer.phase === 'running') {
      stopSolve();
      return;
    }
    if (timer.phase === 'holding' || timer.phase === 'ready') return;
    if (timer.phase === 'idle') {
      if (state.settings.inspection) {
        startInspection();
        return;
      }
      beginHold();
      return;
    }
    if (timer.phase === 'inspect') {
      beginHold();
    }
  }

  function pressEnd() {
    if (timer.phase === 'holding') {
      clearHold();
      timer.phase = timer.inspecting ? 'inspect' : 'idle';
      paint();
      return;
    }
    if (timer.phase === 'ready') {
      startSolve();
    }
  }

  function cancelEverything() {
    clearHold();
    stopInspection();
    if (timer.raf) cancelAnimationFrame(timer.raf);
    timer.raf = 0;
    timer.phase = 'idle';
    timer.pendingPenalty = null;
    document.body.classList.remove('solving');
    paint();
  }

  function startInspection() {
    timer.inspecting = true;
    timer.inspectStart = performance.now();
    timer.phase = 'inspect';
    timer.beeped = {};
    clearInterval(timer.inspectTimer);
    timer.inspectTimer = setInterval(tickInspection, 60);
    paint();
  }

  function stopInspection() {
    timer.inspecting = false;
    if (timer.inspectTimer) {
      clearInterval(timer.inspectTimer);
      timer.inspectTimer = 0;
    }
  }

  function tickInspection() {
    if (timer.phase !== 'inspect' && timer.phase !== 'holding' && timer.phase !== 'ready') {
      stopInspection();
      return;
    }
    var elapsed = (performance.now() - timer.inspectStart) / 1000;
    if (elapsed >= 8 && !timer.beeped[8]) { timer.beeped[8] = true; beep(880, 90); }
    if (elapsed >= 12 && !timer.beeped[12]) { timer.beeped[12] = true; beep(1180, 140); }
    if (elapsed >= INSPECT_DNF && timer.phase !== 'running') {
      // 17 seconds: the solve starts on its own and counts as a DNF.
      timer.phase = 'ready';
      startSolve();
      return;
    }
    paint();
  }

  function startSolve() {
    clearHold();
    var penalty = null;
    if (timer.inspecting) {
      var elapsed = performance.now() - timer.inspectStart;
      if (elapsed >= INSPECT_DNF * 1000) penalty = 'DNF';
      else if (elapsed >= INSPECT_LIMIT * 1000) penalty = '+2';
      stopInspection();
    }
    timer.pendingPenalty = penalty;
    timer.phase = 'running';
    timer.startTime = performance.now();
    document.body.classList.add('solving');
    el.timerZone.classList.add('running');
    el.timerZone.classList.remove('holding', 'ready', 'inspect');
    el.penaltyFlag.hidden = true;
    el.inspectFlag.hidden = true;
    el.timer.textContent = fmtTime(0);
    cancelAnimationFrame(timer.raf);
    timer.raf = requestAnimationFrame(tickRun);
  }

  function tickRun() {
    if (timer.phase !== 'running') return;
    el.timer.textContent = fmtTime(performance.now() - timer.startTime);
    timer.raf = requestAnimationFrame(tickRun);
  }

  function stopSolve() {
    if (timer.phase !== 'running') return;
    var ms = performance.now() - timer.startTime;
    cancelAnimationFrame(timer.raf);
    timer.raf = 0;
    var penalty = timer.pendingPenalty || null;
    timer.pendingPenalty = null;
    timer.phase = 'idle';
    document.body.classList.remove('solving');

    // Best valid single before this solve, so a personal record can be spotted.
    var previousBest = Stats.compute(solves()).best;

    var solve = {
      id: uid(),
      ms: Math.round(ms),
      penalty: penalty,
      scramble: currentScramble(),
      ts: Date.now()
    };
    session().solves.push(solve);
    save();

    makeScramble();
    renderStats();
    renderChart();
    renderList();
    renderLast();
    renderSessions();
    paint();
    el.timer.textContent = penalty === 'DNF' ? 'DNF' : fmtTime(solve.ms + (penalty === '+2' ? 2000 : 0));

    var finalMs = Stats.effective(solve);
    if (previousBest != null && finalMs != null && finalMs < previousBest) {
      celebrateRecord(finalMs, previousBest);
    }
  }

  /* ---------------- personal record celebration ---------------- */

  var CELEBRATION_MS = 2800;
  var CONFETTI_COLORS = ['#ffd76a', '#ff9f43', '#4ade80', '#38bdf8', '#f472b6', '#f2f4f7'];
  var celebrateTimer = 0;

  function celebrateRecord(ms, previousBest) {
    var gain = previousBest - ms;
    var delta = '-' + (gain / 1000).toFixed(precision()) + 's';
    el.prDelta.textContent = delta;

    el.prBanner.classList.add('show');
    spawnConfetti();
    playCelebrationTone();

    clearTimeout(celebrateTimer);
    celebrateTimer = setTimeout(function () {
      el.prBanner.classList.remove('show');
      el.prConfetti.innerHTML = '';
    }, CELEBRATION_MS);
  }

  function spawnConfetti() {
    var host = el.prConfetti;
    host.innerHTML = '';
    var count = window.innerWidth < 520 ? 34 : 54;
    for (var i = 0; i < count; i++) {
      var piece = document.createElement('i');
      var left = Math.random() * 100;
      var w = 5 + Math.random() * 6;
      var h = 8 + Math.random() * 11;
      var dur = 1.6 + Math.random() * 1.3;
      var delay = Math.random() * 0.35;
      var dx = (Math.random() - 0.5) * 160;
      var rot = 360 + Math.random() * 1080;
      piece.style.left = left.toFixed(2) + '%';
      piece.style.width = w.toFixed(1) + 'px';
      piece.style.height = h.toFixed(1) + 'px';
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.animationDuration = dur.toFixed(2) + 's';
      piece.style.animationDelay = delay.toFixed(2) + 's';
      piece.style.setProperty('--dx', dx.toFixed(0) + 'px');
      piece.style.setProperty('--rot', rot.toFixed(0) + 'deg');
      if (i % 5 === 0) piece.style.borderRadius = '50%';
      host.appendChild(piece);
    }
  }

  function playCelebrationTone() {
    if (!state.settings.beep) return;
    var notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach(function (freq, i) {
      setTimeout(function () { beep(freq, 130); }, i * 110);
    });
  }

  /* ---------------- solve actions ---------------- */

  function findSolve(id) {
    var list = solves();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function togglePenalty(id, penalty) {
    var s = findSolve(id);
    if (!s) return;
    s.penalty = s.penalty === penalty ? null : penalty;
    save();
    renderAll();
  }

  function deleteSolve(id) {
    var list = solves();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        list.splice(i, 1);
        break;
      }
    }
    save();
    renderAll();
  }

  function openDetail(id) {
    var s = findSolve(id);
    if (!s) return;
    detailId = id;
    el.dlgTime.textContent = Stats.effective(s) == null ? 'DNF' : fmtTime(Stats.effective(s));
    el.dlgRaw.textContent = fmtTime(s.ms);
    el.dlgPenalty.textContent = s.penalty === '+2' ? '+2 (2초 추가)' : (s.penalty === 'DNF' ? 'DNF (기록 무효)' : '없음');
    el.dlgDate.textContent = dateText(s.ts);
    el.dlgScramble.textContent = s.scramble || '—';
    if (el.detailDialog.showModal) el.detailDialog.showModal();
    else el.detailDialog.setAttribute('open', '');
  }

  /* ---------------- small dialogs ---------------- */

  function openPrompt(opts) {
    return new Promise(function (resolve) {
      var dlg = document.createElement('dialog');
      dlg.className = 'dlg';
      var form = document.createElement('form');
      form.method = 'dialog';
      form.className = 'dlg-inner';

      var head = document.createElement('div');
      head.className = 'dlg-head';
      var h = document.createElement('h2');
      h.textContent = opts.title;
      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'icon-btn';
      x.textContent = '✕';
      x.setAttribute('aria-label', '닫기');
      head.appendChild(h);
      head.appendChild(x);

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'num-input';
      input.style.width = '100%';
      input.style.textAlign = 'left';
      input.value = opts.value || '';
      input.maxLength = 40;

      var actions = document.createElement('div');
      actions.className = 'dlg-actions';
      actions.style.marginTop = '14px';
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'ghost-btn';
      ok.textContent = '확인';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ghost-btn';
      cancel.textContent = '취소';
      actions.appendChild(ok);
      actions.appendChild(cancel);

      form.appendChild(head);
      form.appendChild(input);
      form.appendChild(actions);
      dlg.appendChild(form);
      document.body.appendChild(dlg);

      var done = function (value) {
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(value);
      };
      ok.addEventListener('click', function () { done(input.value.trim() || null); });
      cancel.addEventListener('click', function () { done(null); });
      x.addEventListener('click', function () { done(null); });
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim() || null); }
      });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); done(null); });

      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      setTimeout(function () { input.focus(); input.select(); }, 40);
    });
  }

  function openConfirm(opts) {
    return new Promise(function (resolve) {
      var dlg = document.createElement('dialog');
      dlg.className = 'dlg';
      var form = document.createElement('form');
      form.method = 'dialog';
      form.className = 'dlg-inner';

      var head = document.createElement('div');
      head.className = 'dlg-head';
      var h = document.createElement('h2');
      h.textContent = opts.title;
      head.appendChild(h);

      var msg = document.createElement('p');
      msg.style.margin = '0 0 16px';
      msg.style.fontSize = '13px';
      msg.style.color = 'var(--muted)';
      msg.style.lineHeight = '1.6';
      msg.textContent = opts.message;

      var actions = document.createElement('div');
      actions.className = 'dlg-actions';
      var ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'chip' + (opts.danger ? ' chip-danger' : '');
      if (opts.danger) { ok.style.color = 'var(--red)'; ok.style.borderColor = 'var(--red)'; }
      ok.textContent = opts.confirmText || '확인';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'chip';
      cancel.textContent = '취소';
      actions.appendChild(ok);
      actions.appendChild(cancel);

      form.appendChild(head);
      form.appendChild(msg);
      form.appendChild(actions);
      dlg.appendChild(form);
      document.body.appendChild(dlg);

      var done = function (value) {
        if (dlg.open) dlg.close();
        dlg.remove();
        resolve(value);
      };
      ok.addEventListener('click', function () { done(true); });
      cancel.addEventListener('click', function () { done(false); });
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); done(false); });
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    });
  }

  function toast(text) {
    var t = el.toast;
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove('show'); }, 1600);
  }

  /* ---------------- export ---------------- */

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 400);
  }

  function stamp() {
    var d = new Date();
    var pad = function (v) { return v < 10 ? '0' + v : String(v); };
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes());
  }

  function exportCsv() {
    var list = solves();
    if (!list.length) { toast('내보낼 기록이 없습니다'); return; }
    var rows = [['no', 'time_ms', 'penalty', 'final_ms', 'scramble', 'solved_at']];
    list.forEach(function (s, i) {
      var eff = Stats.effective(s);
      rows.push([
        i + 1,
        s.ms,
        s.penalty || '',
        eff == null ? 'DNF' : eff,
        '"' + String(s.scramble || '').replace(/"/g, '""') + '"',
        new Date(s.ts).toISOString()
      ]);
    });
    download('cubetimer-' + state.event + '-' + stamp() + '.csv', '\ufeff' + rows.map(function (r) { return r.join(','); }).join('\r\n'), 'text/csv');
    toast('CSV로 내보냈습니다');
  }

  function exportJson() {
    var payload = {
      app: 'cubetimer',
      version: 1,
      exportedAt: new Date().toISOString(),
      event: state.event,
      eventLabel: EVENT_LABEL[state.event],
      session: { name: session().name, solves: solves() }
    };
    if (!solves().length) { toast('내보낼 기록이 없습니다'); return; }
    download('cubetimer-' + state.event + '-' + stamp() + '.json', JSON.stringify(payload, null, 2), 'application/json');
    toast('JSON으로 내보냈습니다');
  }

  /* ---------------- settings ---------------- */

  function updateHint() {
    el.timerHint.textContent = state.settings.inspection
      ? '스페이스바로 인스펙션 시작 · 0.3초 이상 눌렀다 떼면 측정'
      : '스페이스바를 0.3초 이상 누르면 준비, 떼면 시작';
  }

  function syncSettingsUi() {
    updateHint();
    el.setInspection.checked = !!state.settings.inspection;
    el.setBeep.checked = state.settings.beep !== false;
    el.setPrecision.value = String(precision());
    el.setTarget.value = state.settings.target;
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.settings.theme === 'light' ? 'light' : 'dark');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', state.settings.theme === 'light' ? '#f4f6fa' : '#0b0e13');
  }

  function switchEvent(ev) {
    if (!EVENT_LABEL[ev]) return;
    cancelEverything();
    state.event = ev;
    save();
    book(ev);
    renderAll();
  }

  /* ---------------- wiring ---------------- */

  function cache() {
    el.timerZone = document.getElementById('timerZone');
    el.timer = document.getElementById('timer');
    el.timerHint = document.getElementById('timerHint');
    el.penaltyFlag = document.getElementById('penaltyFlag');
    el.inspectFlag = document.getElementById('inspectFlag');
    el.scrambleText = document.getElementById('scrambleText');
    el.scrambleCounter = document.getElementById('scrambleCounter');
    el.prevScramble = document.getElementById('prevScramble');
    el.nextScramble = document.getElementById('nextScramble');
    el.newScramble = document.getElementById('newScramble');
    el.net = document.getElementById('net');
    el.statsGrid = document.getElementById('statsGrid');
    el.statSession = document.getElementById('statSession');
    el.chartWrap = document.getElementById('chartWrap');
    el.chartCounter = document.getElementById('chartCounter');
    el.targetPill = document.getElementById('targetPill');
    el.solveList = document.getElementById('solveList');
    el.recordCount = document.getElementById('recordCount');
    el.lastCard = document.getElementById('lastCard');
    el.lastTime = document.getElementById('lastTime');
    el.lastBadge = document.getElementById('lastBadge');
    el.lastActions = document.getElementById('lastActions');
    el.eventSelect = document.getElementById('eventSelect');
    el.themeBtn = document.getElementById('themeBtn');
    el.settingsBtn = document.getElementById('settingsBtn');
    el.sessionSelect = document.getElementById('sessionSelect');
    el.newSession = document.getElementById('newSession');
    el.renameSession = document.getElementById('renameSession');
    el.resetSession = document.getElementById('resetSession');
    el.deleteSession = document.getElementById('deleteSession');
    el.exportCsv = document.getElementById('exportCsv');
    el.exportJson = document.getElementById('exportJson');
    el.detailDialog = document.getElementById('detailDialog');
    el.dlgTime = document.getElementById('dlgTime');
    el.dlgRaw = document.getElementById('dlgRaw');
    el.dlgPenalty = document.getElementById('dlgPenalty');
    el.dlgDate = document.getElementById('dlgDate');
    el.dlgScramble = document.getElementById('dlgScramble');
    el.dlgPlus2 = document.getElementById('dlgPlus2');
    el.dlgDnf = document.getElementById('dlgDnf');
    el.dlgDelete = document.getElementById('dlgDelete');
    el.settingsDialog = document.getElementById('settingsDialog');
    el.setInspection = document.getElementById('setInspection');
    el.setBeep = document.getElementById('setBeep');
    el.setPrecision = document.getElementById('setPrecision');
    el.setTarget = document.getElementById('setTarget');
    el.toast = document.getElementById('toast');
    el.prLayer = document.getElementById('prLayer');
    el.prBanner = document.getElementById('prBanner');
    el.prDelta = document.getElementById('prDelta');
    el.prConfetti = document.getElementById('prConfetti');
  }

  function bind() {
    // keyboard
    window.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (document.querySelector('dialog[open]')) return;
      if (e.code === 'Space') e.preventDefault();
      if (e.repeat) return;

      if (timer.phase === 'running') {
        stopSolve();
        return;
      }
      if (e.code === 'Escape') {
        cancelEverything();
        return;
      }
      if (e.code === 'Space') {
        pressStart();
        return;
      }
      if (timer.phase !== 'idle') return;
      if (e.code === 'ArrowLeft') { stepScramble(-1); return; }
      if (e.code === 'ArrowRight') { stepScramble(1); return; }
    });

    window.addEventListener('keyup', function (e) {
      if (e.code !== 'Space') return;
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (document.querySelector('dialog[open]')) return;
      pressEnd();
    });

    // pointer (touch + mouse) on the timer area
    el.timerZone.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      pressStart();
    });
    window.addEventListener('pointerup', function () { pressEnd(); });
    window.addEventListener('pointercancel', function () { pressEnd(); });
    el.timerZone.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    // scramble
    el.scrambleText.addEventListener('click', function () {
      var text = currentScramble();
      if (!text) return;
      var done = function () { toast('스크램블을 복사했습니다'); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { selectNode(el.scrambleText); });
      } else {
        selectNode(el.scrambleText);
      }
    });
    el.scrambleText.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); el.scrambleText.click(); }
    });
    el.newScramble.addEventListener('click', makeScramble);
    el.nextScramble.addEventListener('click', function () { stepScramble(1); });
    el.prevScramble.addEventListener('click', function () { stepScramble(-1); });

    // last solve actions
    el.lastActions.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var list = solves();
      if (!list.length) return;
      var id = list[list.length - 1].id;
      if (btn.dataset.act === 'plus2') togglePenalty(id, '+2');
      else if (btn.dataset.act === 'dnf') togglePenalty(id, 'DNF');
      else if (btn.dataset.act === 'del') deleteSolve(id);
    });

    // list
    el.solveList.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      var row = e.target.closest('.solve-row');
      if (!row) return;
      var id = row.dataset.id;
      if (btn) {
        if (btn.dataset.act === 'plus2') togglePenalty(id, '+2');
        else if (btn.dataset.act === 'dnf') togglePenalty(id, 'DNF');
        else if (btn.dataset.act === 'del') deleteSolve(id);
        return;
      }
      openDetail(id);
    });
    el.solveList.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var row = e.target.closest('.solve-row');
      if (row) { e.preventDefault(); openDetail(row.dataset.id); }
    });

    // detail dialog
    el.dlgPlus2.addEventListener('click', function () {
      if (!detailId) return;
      togglePenalty(detailId, '+2');
      el.detailDialog.close();
    });
    el.dlgDnf.addEventListener('click', function () {
      if (!detailId) return;
      togglePenalty(detailId, 'DNF');
      el.detailDialog.close();
    });
    el.dlgDelete.addEventListener('click', function () {
      if (!detailId) return;
      deleteSolve(detailId);
      el.detailDialog.close();
      toast('기록을 삭제했습니다');
    });

    // sessions
    el.sessionSelect.addEventListener('change', function () {
      ensureEvent(state.event).active = el.sessionSelect.value;
      save();
      renderAll();
    });

    el.newSession.addEventListener('click', function () {
      var bucket = ensureEvent(state.event);
      openPrompt({ title: '새 세션', value: '세션 ' + (bucket.list.length + 1) }).then(function (name) {
        if (!name) return;
        var s = { id: uid(), name: name, solves: [] };
        bucket.list.push(s);
        bucket.active = s.id;
        save();
        renderAll();
        toast('세션을 추가했습니다');
      });
    });

    el.renameSession.addEventListener('click', function () {
      var bucket = ensureEvent(state.event);
      var current = bucket.list.filter(function (s) { return s.id === bucket.active; })[0];
      if (!current) return;
      openPrompt({ title: '세션 이름 변경', value: current.name }).then(function (name) {
        if (!name) return;
        current.name = name;
        save();
        renderAll();
      });
    });

    el.resetSession.addEventListener('click', function () {
      openConfirm({
        title: '세션 초기화',
        message: '이 세션의 기록을 모두 지웁니다. 되돌릴 수 없습니다.',
        confirmText: '초기화',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        session().solves = [];
        save();
        renderAll();
        toast('세션을 초기화했습니다');
      });
    });

    el.deleteSession.addEventListener('click', function () {
      var bucket = ensureEvent(state.event);
      if (bucket.list.length <= 1) return;
      openConfirm({
        title: '세션 삭제',
        message: '이 세션과 기록 ' + session().solves.length + '개를 삭제합니다.',
        confirmText: '삭제',
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        bucket.list = bucket.list.filter(function (s) { return s.id !== bucket.active; });
        bucket.active = bucket.list[0].id;
        save();
        renderAll();
        toast('세션을 삭제했습니다');
      });
    });

    el.exportCsv.addEventListener('click', exportCsv);
    el.exportJson.addEventListener('click', exportJson);

    // header
    el.eventSelect.addEventListener('change', function () { switchEvent(el.eventSelect.value); });

    el.themeBtn.addEventListener('click', function () {
      state.settings.theme = state.settings.theme === 'light' ? 'dark' : 'light';
      applyTheme();
      save();
      renderChart();
    });

    el.settingsBtn.addEventListener('click', function () {
      syncSettingsUi();
      if (el.settingsDialog.showModal) el.settingsDialog.showModal();
      else el.settingsDialog.setAttribute('open', '');
    });

    el.setInspection.addEventListener('change', function () {
      state.settings.inspection = el.setInspection.checked;
      save();
      cancelEverything();
      updateHint();
    });
    el.setBeep.addEventListener('change', function () {
      state.settings.beep = el.setBeep.checked;
      save();
    });
    el.setPrecision.addEventListener('change', function () {
      state.settings.precision = Number(el.setPrecision.value) === 3 ? 3 : 2;
      save();
      renderAll();
    });
    el.setTarget.addEventListener('change', function () {
      var v = Number(el.setTarget.value);
      state.settings.target = isFinite(v) && v > 0 ? Math.min(600, v) : 30;
      el.setTarget.value = state.settings.target;
      save();
      renderChart();
    });

    // keep the display honest when the tab regains focus
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && timer.phase === 'running') {
        el.timer.textContent = fmtTime(performance.now() - timer.startTime);
      }
    });
  }

  function selectNode(node) {
    try {
      var range = document.createRange();
      range.selectNodeContents(node);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (err) { /* ignore */ }
  }

  function init() {
    cache();
    load();
    ensureEvent(state.event);
    applyTheme();
    syncSettingsUi();
    el.eventSelect.value = state.event;
    book(state.event).list = book(state.event).list || [];
    bind();
    if (book(state.event).idx < 0) makeScramble();
    renderAll();
  }

  // Self-test hooks (used by the deploy check; harmless to leave in).
  window.CubeTimer = {
    cube: function (n, moves) {
      return new CubeModel.Cube(n).apply(moves || []).facelets();
    },
    stats: Stats,
    generate: function (ev) { return Scramble.generate(ev || '333'); },
    get state() { return state; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
