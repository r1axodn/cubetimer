/* scramble.js — WCA-style random-move scrambles.
 * Rule (3x3/4x4): never the same face twice in a row, and never the same face
 * again with one opposite-face move in between (R L R is rejected).
 * 2x2 uses the U/R/F move set, Pyraminx the U/L/R/B set plus random tips.
 */
(function (global) {
  'use strict';

  var AXIS = { U: 'y', D: 'y', L: 'x', R: 'x', F: 'z', B: 'z' };
  var AMOUNTS = [1, 2, -1];
  var CUBE_FACES = ['U', 'D', 'L', 'R', 'F', 'B'];

  var EVENTS = {
    222: { label: '2x2x2', faces: ['U', 'R', 'F'], min: 9, max: 11, wide: false },
    333: { label: '3x3x3', faces: CUBE_FACES, min: 20, max: 20, wide: false },
    444: { label: '4x4x4', faces: CUBE_FACES, min: 40, max: 40, wide: true },
    pyra: { label: 'Pyraminx', faces: ['U', 'L', 'R', 'B'], min: 11, max: 11, pyraminx: true }
  };

  function rand(n) {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      var buf = new Uint32Array(1);
      // Rejection sampling keeps the distribution flat.
      var limit = Math.floor(4294967296 / n) * n;
      for (var i = 0; i < 32; i++) {
        crypto.getRandomValues(buf);
        if (buf[0] < limit) return buf[0] % n;
      }
      return buf[0] % n;
    }
    return Math.floor(Math.random() * n);
  }

  function pick(list) {
    return list[rand(list.length)];
  }

  function moveText(m) {
    if (m.tip) {
      return m.face.toLowerCase() + (m.amount === -1 ? "'" : '');
    }
    var s = m.face;
    if (m.depth > 1) s += new Array(m.depth).join('w');
    if (m.amount === 2) s += '2';
    else if (m.amount === -1) s += "'";
    return s;
  }

  /** Returns { moves: [...], text: 'R U2 ...' } */
  function generate(eventId) {
    var ev = EVENTS[eventId] || EVENTS['333'];
    var length = ev.min + Math.floor(rand(ev.max - ev.min + 1));
    var moves = [];
    var last = null;
    var beforeLast = null;

    for (var i = 0; i < length; i++) {
      var face = null;
      for (var attempt = 0; attempt < 40; attempt++) {
        var candidate = pick(ev.faces);
        if (candidate === last) continue;
        // Block "R L R": same face as two moves ago across an opposite face.
        if (candidate === beforeLast && AXIS[candidate] === AXIS[last]) continue;
        face = candidate;
        break;
      }
      if (!face) face = pick(ev.faces);

      var depth = 1;
      // Wide turns (Rw, Uw, ...) are part of 4x4 scrambling. Keep them off the
      // very first moves so a scramble never opens ambiguously.
      if (ev.wide && i > 0 && rand(100) < 42) depth = 2;

      moves.push({ face: face, amount: pick(AMOUNTS), depth: depth });
      beforeLast = last;
      last = face;
    }

    if (ev.pyraminx) {
      // Tip turns: each one is turned or left alone at random.
      var tips = ['u', 'l', 'r', 'b'];
      for (var t = 0; t < tips.length; t++) {
        if (rand(2) === 0) continue;
        moves.push({ face: tips[t].toUpperCase(), amount: rand(2) === 0 ? 1 : -1, tip: true });
      }
    }

    return {
      moves: moves,
      text: moves.map(moveText).join(' ')
    };
  }

  /** Rebuilds move objects from a scramble string such as "R Uw2 F' L". */
  function parse(text) {
    if (!text) return [];
    return text.trim().split(/\s+/).map(function (tok) {
      var m = /^([URFDLBurfdlb])(w*)(2?'?)$/.exec(tok);
      if (!m) return null;
      var faceRaw = m[1];
      var tip = faceRaw === faceRaw.toLowerCase();
      var amount = 1;
      if (m[3].indexOf('2') === 0) amount = 2;
      else if (m[3].indexOf("'") >= 0) amount = -1;
      return {
        face: faceRaw.toUpperCase(),
        amount: amount,
        depth: 1 + m[2].length,
        tip: tip
      };
    }).filter(Boolean);
  }

  global.Scramble = {
    EVENTS: EVENTS,
    generate: generate,
    parse: parse,
    moveText: moveText
  };
})(window);
