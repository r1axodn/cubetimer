/* stats.js — WCA-consistent averages.
 * AoN: drop the best and worst N/20 of the window (at least one on each side;
 * 5% rounded up for 50/100). A window with more DNFs than the dropped slots is
 * itself a DNF. Single times apply their penalty (+2 = +2000 ms).
 */
(function (global) {
  'use strict';

  var PLUS_TWO = 2000;

  function effective(solve) {
    if (!solve) return null;
    if (solve.penalty === 'DNF') return null;
    return solve.ms + (solve.penalty === '+2' ? PLUS_TWO : 0);
  }

  function cutCount(n) {
    return n <= 12 ? 1 : Math.ceil(n * 0.05);
  }

  /** Average of the last `n` solves, or undefined when the window is incomplete. */
  function averageOf(solves, n) {
    if (!solves || solves.length < n) return undefined;
    return windowAverage(solves.slice(solves.length - n), n);
  }

  function windowAverage(win, n) {
    var remove = cutCount(n);
    var times = [];
    var dnf = 0;
    for (var i = 0; i < win.length; i++) {
      var v = effective(win[i]);
      if (v === null) dnf++;
      else times.push(v);
    }
    if (dnf > remove) return { dnf: true, value: null };
    times.sort(function (a, b) { return a - b; });
    var topCut = remove - dnf;
    var kept = times.slice(remove, times.length - topCut);
    if (!kept.length) return { dnf: true, value: null };
    var sum = 0;
    for (var j = 0; j < kept.length; j++) sum += kept[j];
    return { dnf: false, value: sum / kept.length };
  }

  /** Best window average of size n anywhere in the session. */
  function bestAverage(solves, n) {
    if (!solves || solves.length < n) return undefined;
    var best = undefined;
    for (var end = n; end <= solves.length; end++) {
      var avg = windowAverage(solves.slice(end - n, end), n);
      if (avg.dnf) continue;
      if (!best || avg.value < best.value) best = avg;
    }
    return best;
  }

  function mean(solves) {
    if (!solves || !solves.length) return undefined;
    var sum = 0;
    for (var i = 0; i < solves.length; i++) {
      var v = effective(solves[i]);
      if (v === null) return { dnf: true, value: null };
      sum += v;
    }
    return { dnf: false, value: sum / solves.length };
  }

  function bestSingle(solves) {
    var best = null;
    for (var i = 0; i < (solves || []).length; i++) {
      var v = effective(solves[i]);
      if (v === null) continue;
      if (best === null || v < best) best = v;
    }
    return best;
  }

  function compute(solves) {
    solves = solves || [];
    var dnfCount = 0;
    for (var i = 0; i < solves.length; i++) {
      if (solves[i].penalty === 'DNF') dnfCount++;
    }
    return {
      total: solves.length,
      completed: solves.length - dnfCount,
      dnfCount: dnfCount,
      last: solves.length ? effective(solves[solves.length - 1]) : null,
      lastSolve: solves.length ? solves[solves.length - 1] : null,
      best: bestSingle(solves),
      mean: mean(solves),
      ao5: averageOf(solves, 5),
      ao5best: bestAverage(solves, 5),
      ao12: averageOf(solves, 12),
      ao12best: bestAverage(solves, 12),
      ao50: averageOf(solves, 50),
      ao100: averageOf(solves, 100)
    };
  }

  global.Stats = {
    effective: effective,
    averageOf: averageOf,
    bestAverage: bestAverage,
    compute: compute,
    cutCount: cutCount
  };
})(window);
