/* cube.js — facelet model for 2x2x2 / 3x3x3 / 4x4x4.
 * Every sticker keeps a 3D position and an outward normal, so any layer turn
 * (including wide turns) is a plain vector rotation. Rendering the 2D net is a
 * projection of those stickers onto the six view planes.
 */
(function (global) {
  'use strict';

  var COLORS = {
    U: '#f2f4f7',
    R: '#e0402f',
    F: '#18a558',
    D: '#f4c30b',
    L: '#f2802a',
    B: '#2b6cf0'
  };

  var NORMALS = {
    U: [0, 1, 0],
    D: [0, -1, 0],
    R: [1, 0, 0],
    L: [-1, 0, 0],
    F: [0, 0, 1],
    B: [0, 0, -1]
  };

  /* A clockwise turn of a face, seen from outside that face, is a -90° rotation
   * about the outward axis for U/R/F and +90° for D/L/B (right-handed axes). */
  var TURN = {
    R: { axis: 'x', sign: 1, angle: -90 },
    L: { axis: 'x', sign: -1, angle: 90 },
    U: { axis: 'y', sign: 1, angle: -90 },
    D: { axis: 'y', sign: -1, angle: 90 },
    F: { axis: 'z', sign: 1, angle: -90 },
    B: { axis: 'z', sign: -1, angle: 90 }
  };

  // Coordinates are stored scaled by 2 (…, -2, 0, 2, …) so all maths stays integer.
  function rotate(x, y, z, axis, angle) {
    if (axis === 'x') {
      return angle < 0 ? [x, z, -y] : [x, -z, y];
    }
    if (axis === 'y') {
      return angle < 0 ? [-z, y, x] : [z, y, -x];
    }
    return angle < 0 ? [y, -x, z] : [-y, x, z];
  }

  function Cube(n) {
    this.n = n;
    this.max = n - 1; // half-extent in scaled (x2) units: -max, -max+2, …, max
    this.stickers = this._solved();
  }

  Cube.prototype._solved = function () {
    var n = this.n;
    var max = this.max;
    var out = [];
    function add(x, y, z, face) {
      var nv = NORMALS[face];
      out.push({
        x: x, y: y, z: z,
        nx: nv[0], ny: nv[1], nz: nv[2],
        face: face
      });
    }
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        var xc = 2 * c - max;
        var xr = max - 2 * c;
        var yr = max - 2 * r;
        add(xc, max, 2 * r - max, 'U');   // r grows towards the front
        add(xc, -max, max - 2 * r, 'D');  // r grows towards the back
        add(xc, yr, max, 'F');
        add(xr, yr, -max, 'B');
        add(-max, yr, 2 * c - max, 'L');
        add(max, yr, max - 2 * c, 'R');
      }
    }
    return out;
  };

  /** A move is {face, amount: 1 | 2 | -1, depth: 1 | 2}. */
  Cube.prototype.turn = function (move) {
    var def = TURN[move.face];
    if (!def) return;
    var depth = move.depth || 1;
    var amount = move.amount === 2 ? 2 : (move.amount === -1 ? -1 : 1);
    var times = amount === 2 ? 2 : 1;
    var angle = amount === -1 ? -def.angle : def.angle;
    var max = this.max;
    var outer = def.sign * max;
    var floor = outer - 2 * (depth - 1); // include every layer up to depth

    for (var t = 0; t < times; t++) {
      for (var i = 0; i < this.stickers.length; i++) {
        var s = this.stickers[i];
        var v = s[def.axis];
        var inLayer = def.sign > 0 ? v >= floor : v <= floor;
        if (!inLayer) continue;
        var p = rotate(s.x, s.y, s.z, def.axis, angle);
        var q = rotate(s.nx, s.ny, s.nz, def.axis, angle);
        s.x = p[0]; s.y = p[1]; s.z = p[2];
        s.nx = q[0]; s.ny = q[1]; s.nz = q[2];
      }
    }
    return this;
  };

  Cube.prototype.apply = function (moves) {
    for (var i = 0; i < moves.length; i++) this.turn(moves[i]);
    return this;
  };

  /** face + net row/column of every sticker. */
  Cube.prototype.facelets = function () {
    var n = this.n;
    var max = this.max;
    var faces = { U: [], R: [], F: [], D: [], L: [], B: [] };
    var i, s;
    for (i = 0; i < 6; i++) {
      var key = 'URFDLB'.charAt(i);
      faces[key] = new Array(n * n);
    }
    for (i = 0; i < this.stickers.length; i++) {
      s = this.stickers[i];
      var face, r, c;
      if (s.ny > 0) {
        face = 'U'; r = (s.z + max) / 2; c = (s.x + max) / 2;
      } else if (s.ny < 0) {
        face = 'D'; r = (max - s.z) / 2; c = (s.x + max) / 2;
      } else if (s.nz > 0) {
        face = 'F'; r = (max - s.y) / 2; c = (s.x + max) / 2;
      } else if (s.nz < 0) {
        face = 'B'; r = (max - s.y) / 2; c = (max - s.x) / 2;
      } else if (s.nx < 0) {
        face = 'L'; r = (max - s.y) / 2; c = (s.z + max) / 2;
      } else {
        face = 'R'; r = (max - s.y) / 2; c = (max - s.z) / 2;
      }
      faces[face][r * n + c] = s.face;
    }
    return faces;
  };

  /** True when every sticker sits on its own face (used by self-tests). */
  Cube.prototype.isSolved = function () {
    for (var i = 0; i < this.stickers.length; i++) {
      var s = this.stickers[i];
      var f = s.face;
      if (f === 'U' && (s.ny < 0 || s.nx !== 0 || s.nz !== 0)) return false;
      if (f === 'D' && (s.ny > 0 || s.nx !== 0 || s.nz !== 0)) return false;
      if (f === 'R' && (s.nx < 0 || s.ny !== 0 || s.nz !== 0)) return false;
      if (f === 'L' && (s.nx > 0 || s.ny !== 0 || s.nz !== 0)) return false;
      if (f === 'F' && (s.nz < 0 || s.nx !== 0 || s.ny !== 0)) return false;
      if (f === 'B' && (s.nz > 0 || s.nx !== 0 || s.ny !== 0)) return false;
    }
    return true;
  };

  global.CubeModel = {
    Cube: Cube,
    COLORS: COLORS,
    NORMALS: NORMALS
  };
})(window);
