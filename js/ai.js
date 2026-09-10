/*
 * ai.js — the computer opponent.
 *
 * Negamax with alpha-beta pruning, iterative deepening, a transposition
 * table, quiescence search, and killer/history move ordering. Evaluation is
 * material plus tapered piece-square tables plus a few positional terms.
 */
(function (global) {
  'use strict';

  var C = global.Chess;
  var WHITE = C.WHITE, BLACK = C.BLACK;

  var MATE = 100000;
  var INF = 1000000;

  var VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

  // Piece-square tables, written from white's point of view with index 0 at
  // a8 — the same orientation as the board array. Black reads them mirrored
  // vertically via `i ^ 56`.
  var PST = {
    p: [
        0,  0,  0,  0,  0,  0,  0,  0,
       50, 50, 50, 50, 50, 50, 50, 50,
       10, 10, 20, 30, 30, 20, 10, 10,
        5,  5, 10, 25, 25, 10,  5,  5,
        0,  0,  0, 20, 20,  0,  0,  0,
        5, -5,-10,  0,  0,-10, -5,  5,
        5, 10, 10,-20,-20, 10, 10,  5,
        0,  0,  0,  0,  0,  0,  0,  0
    ],
    n: [
      -50,-40,-30,-30,-30,-30,-40,-50,
      -40,-20,  0,  0,  0,  0,-20,-40,
      -30,  0, 10, 15, 15, 10,  0,-30,
      -30,  5, 15, 20, 20, 15,  5,-30,
      -30,  0, 15, 20, 20, 15,  0,-30,
      -30,  5, 10, 15, 15, 10,  5,-30,
      -40,-20,  0,  5,  5,  0,-20,-40,
      -50,-40,-30,-30,-30,-30,-40,-50
    ],
    b: [
      -20,-10,-10,-10,-10,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5, 10, 10,  5,  0,-10,
      -10,  5,  5, 10, 10,  5,  5,-10,
      -10,  0, 10, 10, 10, 10,  0,-10,
      -10, 10, 10, 10, 10, 10, 10,-10,
      -10,  5,  0,  0,  0,  0,  5,-10,
      -20,-10,-10,-10,-10,-10,-10,-20
    ],
    r: [
        0,  0,  0,  0,  0,  0,  0,  0,
        5, 10, 10, 10, 10, 10, 10,  5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
       -5,  0,  0,  0,  0,  0,  0, -5,
        0,  0,  0,  5,  5,  0,  0,  0
    ],
    q: [
      -20,-10,-10, -5, -5,-10,-10,-20,
      -10,  0,  0,  0,  0,  0,  0,-10,
      -10,  0,  5,  5,  5,  5,  0,-10,
       -5,  0,  5,  5,  5,  5,  0, -5,
        0,  0,  5,  5,  5,  5,  0, -5,
      -10,  5,  5,  5,  5,  5,  0,-10,
      -10,  0,  5,  0,  0,  0,  0,-10,
      -20,-10,-10, -5, -5,-10,-10,-20
    ],
    kMid: [
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -30,-40,-40,-50,-50,-40,-40,-30,
      -20,-30,-30,-40,-40,-30,-30,-20,
      -10,-20,-20,-20,-20,-20,-20,-10,
       20, 20,  0,  0,  0,  0, 20, 20,
       20, 30, 10,  0,  0, 10, 30, 20
    ],
    kEnd: [
      -50,-40,-30,-20,-20,-30,-40,-50,
      -30,-20,-10,  0,  0,-10,-20,-30,
      -30,-10, 20, 30, 30, 20,-10,-30,
      -30,-10, 30, 40, 40, 30,-10,-30,
      -30,-10, 30, 40, 40, 30,-10,-30,
      -30,-10, 20, 30, 30, 20,-10,-30,
      -30,-30,  0,  0,  0,  0,-30,-30,
      -50,-30,-30,-30,-30,-30,-30,-50
    ]
  };

  // Difficulty presets. `noise` adds a random score wobble so the easier
  // levels are beatable and do not repeat the same game every time.
  var LEVELS = {
    easy:   { depth: 2, timeMs: 400,  noise: 55, quiesce: false },
    medium: { depth: 3, timeMs: 900,  noise: 22, quiesce: true  },
    hard:   { depth: 5, timeMs: 2000, noise: 0,  quiesce: true  },
    expert: { depth: 8, timeMs: 4500, noise: 0,  quiesce: true  }
  };

  // --- Evaluation -------------------------------------------------------

  // Game phase, 0 (bare endgame) to 24 (full opening material).
  var PHASE_WEIGHT = { p: 0, n: 1, b: 1, r: 2, q: 4, k: 0 };
  var MAX_PHASE = 24;

  function evaluate(pos) {
    var b = pos.board;
    var i, p, type, white, pstIndex;
    var score = 0;
    var phase = 0;

    // Pawn counts per file, used for doubled/isolated/passed detection.
    var wPawnFiles = [0,0,0,0,0,0,0,0];
    var bPawnFiles = [0,0,0,0,0,0,0,0];
    var wPawnRows = [[],[],[],[],[],[],[],[]];
    var bPawnRows = [[],[],[],[],[],[],[],[]];
    var bishops = { w: 0, b: 0 };

    for (i = 0; i < 64; i++) {
      p = b[i];
      if (p === null) continue;
      type = C.typeOf(p);
      phase += PHASE_WEIGHT[type];
      if (type === 'p') {
        if (p === 'P') { wPawnFiles[C.colOf(i)]++; wPawnRows[C.colOf(i)].push(C.rowOf(i)); }
        else { bPawnFiles[C.colOf(i)]++; bPawnRows[C.colOf(i)].push(C.rowOf(i)); }
      } else if (type === 'b') {
        bishops[C.colorOf(p)]++;
      }
    }
    if (phase > MAX_PHASE) phase = MAX_PHASE;
    var endgameWeight = (MAX_PHASE - phase) / MAX_PHASE;   // 0 opening, 1 endgame

    for (i = 0; i < 64; i++) {
      p = b[i];
      if (p === null) continue;
      type = C.typeOf(p);
      white = C.colorOf(p) === WHITE;
      pstIndex = white ? i : (i ^ 56);

      var value = VALUE[type];
      if (type === 'k') {
        // Blend the middlegame and endgame king tables by phase.
        value += Math.round(
          PST.kMid[pstIndex] * (1 - endgameWeight) + PST.kEnd[pstIndex] * endgameWeight
        );
      } else {
        value += PST[type][pstIndex];
      }
      score += white ? value : -value;
    }

    // Bishop pair.
    if (bishops.w >= 2) score += 30;
    if (bishops.b >= 2) score -= 30;

    // Pawn structure.
    for (i = 0; i < 8; i++) {
      if (wPawnFiles[i] > 1) score -= 12 * (wPawnFiles[i] - 1);
      if (bPawnFiles[i] > 1) score += 12 * (bPawnFiles[i] - 1);

      var wLeft = i > 0 ? wPawnFiles[i - 1] : 0;
      var wRight = i < 7 ? wPawnFiles[i + 1] : 0;
      if (wPawnFiles[i] > 0 && wLeft === 0 && wRight === 0) score -= 18;

      var bLeft = i > 0 ? bPawnFiles[i - 1] : 0;
      var bRight = i < 7 ? bPawnFiles[i + 1] : 0;
      if (bPawnFiles[i] > 0 && bLeft === 0 && bRight === 0) score += 18;

      // Passed pawns, worth more the closer they get to promoting.
      wPawnRows[i].forEach(function (row) {
        var blocked = false;
        for (var f = Math.max(0, i - 1); f <= Math.min(7, i + 1); f++) {
          if (bPawnRows[f].some(function (br) { return br < row; })) blocked = true;
        }
        if (!blocked) score += [0, 90, 60, 40, 25, 15, 10, 0][row];
      });
      bPawnRows[i].forEach(function (row) {
        var blocked = false;
        for (var f = Math.max(0, i - 1); f <= Math.min(7, i + 1); f++) {
          if (wPawnRows[f].some(function (wr) { return wr > row; })) blocked = true;
        }
        if (!blocked) score -= [0, 10, 15, 25, 40, 60, 90, 0][row];
      });
    }

    return pos.turn === WHITE ? score : -score;
  }

  // --- Search -----------------------------------------------------------

  var TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;

  function Searcher() {
    this.tt = new Map();
    this.killers = [];
    this.history = {};
    this.nodes = 0;
    this.deadline = 0;
    this.aborted = false;
  }

  Searcher.prototype.reset = function () {
    this.tt.clear();
    this.killers = [];
    this.history = {};
    this.nodes = 0;
    this.aborted = false;
  };

  Searcher.prototype.outOfTime = function () {
    // Checking the clock is not free, so only sample it periodically.
    if ((this.nodes & 1023) === 0 && Date.now() >= this.deadline) this.aborted = true;
    return this.aborted;
  };

  function moveKey(m) {
    return m.from * 64 + m.to + (m.promotion ? m.promotion.toLowerCase().charCodeAt(0) * 4096 : 0);
  }

  function sameMove(a, b) {
    return a && b && a.from === b.from && a.to === b.to && a.promotion === b.promotion;
  }

  // Most Valuable Victim / Least Valuable Attacker, plus killers and history.
  Searcher.prototype.scoreMove = function (m, ttMove, ply) {
    if (sameMove(m, ttMove)) return 1000000;
    if (m.captured !== null) {
      return 100000 + VALUE[C.typeOf(m.captured)] * 10 - VALUE[C.typeOf(m.piece)];
    }
    if (m.promotion) return 90000 + VALUE[C.typeOf(m.promotion)];
    var k = this.killers[ply];
    if (k) {
      if (sameMove(m, k[0])) return 80000;
      if (sameMove(m, k[1])) return 79000;
    }
    return this.history[moveKey(m)] || 0;
  };

  Searcher.prototype.orderMoves = function (moves, ttMove, ply) {
    var self = this;
    var scored = moves.map(function (m) {
      return { move: m, score: self.scoreMove(m, ttMove, ply) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.map(function (s) { return s.move; });
  };

  Searcher.prototype.recordKiller = function (m, ply) {
    if (m.captured !== null || m.promotion) return;
    if (!this.killers[ply]) this.killers[ply] = [null, null];
    var k = this.killers[ply];
    if (!sameMove(k[0], m)) { k[1] = k[0]; k[0] = m; }
  };

  // Search only forcing moves until the position is quiet, so the engine is
  // not fooled by a capture sequence that is cut off mid-exchange.
  Searcher.prototype.quiescence = function (pos, alpha, beta) {
    this.nodes++;
    if (this.outOfTime()) return 0;

    var standPat = evaluate(pos);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;

    var captures = C.generatePseudoMoves(pos, true);
    captures = this.orderMoves(captures, null, 0);
    var us = pos.turn;

    for (var i = 0; i < captures.length; i++) {
      var m = captures[i];
      // Delta pruning: skip captures that cannot plausibly raise alpha.
      if (m.captured !== null && standPat + VALUE[C.typeOf(m.captured)] + 200 < alpha) continue;

      C.makeMove(pos, m);
      if (C.inCheck(pos, us)) { C.unmakeMove(pos); continue; }
      var score = -this.quiescence(pos, -beta, -alpha);
      C.unmakeMove(pos);

      if (this.aborted) return 0;
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  };

  Searcher.prototype.negamax = function (pos, depth, alpha, beta, ply, useQuiescence) {
    this.nodes++;
    if (this.outOfTime()) return 0;

    // Draws by rule are worth exactly zero, whoever is to move.
    if (pos.halfmove >= 100 || C.hasInsufficientMaterial(pos)) return 0;

    var alphaOrig = alpha;
    var ttKey = pos.hashLo;
    var entry = this.tt.get(ttKey);
    var ttMove = null;

    if (entry && entry.hi === pos.hashHi) {
      ttMove = entry.move;
      if (entry.depth >= depth) {
        if (entry.flag === TT_EXACT) return entry.score;
        if (entry.flag === TT_LOWER && entry.score > alpha) alpha = entry.score;
        else if (entry.flag === TT_UPPER && entry.score < beta) beta = entry.score;
        if (alpha >= beta) return entry.score;
      }
    }

    if (depth <= 0) {
      return useQuiescence ? this.quiescence(pos, alpha, beta) : evaluate(pos);
    }

    var us = pos.turn;
    var moves = C.generatePseudoMoves(pos, false);
    moves = this.orderMoves(moves, ttMove, ply);

    var best = -INF;
    var bestMove = null;
    var legalCount = 0;

    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      C.makeMove(pos, m);
      if (C.inCheck(pos, us)) { C.unmakeMove(pos); continue; }
      legalCount++;

      var score;
      if (legalCount === 1) {
        score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, useQuiescence);
      } else {
        // Principal variation search: assume the first move is best and
        // verify the rest with a cheap null-window probe.
        score = -this.negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1, useQuiescence);
        if (score > alpha && score < beta) {
          score = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, useQuiescence);
        }
      }
      C.unmakeMove(pos);

      if (this.aborted) return 0;

      if (score > best) {
        best = score;
        bestMove = m;
      }
      if (score > alpha) {
        alpha = score;
        this.history[moveKey(m)] = (this.history[moveKey(m)] || 0) + depth * depth;
      }
      if (alpha >= beta) {
        this.recordKiller(m, ply);
        break;
      }
    }

    if (legalCount === 0) {
      // Mate scores count from the root so shorter mates score higher.
      return C.inCheck(pos, us) ? -MATE + ply : 0;
    }

    var flag = best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
    this.tt.set(ttKey, { hi: pos.hashHi, depth: depth, score: best, flag: flag, move: bestMove });

    return best;
  };

  // Picks a move for the side to move. Returns null if there are none.
  function chooseMove(pos, levelName) {
    var level = LEVELS[levelName] || LEVELS.medium;
    var searcher = new Searcher();
    searcher.reset();
    searcher.deadline = Date.now() + level.timeMs;

    var rootMoves = C.legalMoves(pos);
    if (rootMoves.length === 0) return null;
    if (rootMoves.length === 1) {
      return { move: rootMoves[0], score: 0, depth: 0, nodes: 0, timeMs: 0 };
    }

    var started = Date.now();
    var best = { move: rootMoves[0], score: 0 };
    var completedDepth = 0;
    var scored = rootMoves.map(function (m) { return { move: m, score: -INF }; });

    for (var depth = 1; depth <= level.depth; depth++) {
      var alpha = -INF;
      var iterationBest = null;
      var iterationScore = -INF;
      var aborted = false;

      // Search the previous iteration's best moves first.
      scored.sort(function (a, b) { return b.score - a.score; });

      for (var i = 0; i < scored.length; i++) {
        var m = scored[i].move;
        C.makeMove(pos, m);
        var score = -searcher.negamax(pos, depth - 1, -INF, -alpha, 1, level.quiesce);
        C.unmakeMove(pos);

        if (searcher.aborted) { aborted = true; break; }

        scored[i].score = score;
        if (score > iterationScore) {
          iterationScore = score;
          iterationBest = m;
          if (score > alpha) alpha = score;
        }
      }

      if (aborted) break;

      completedDepth = depth;
      best = { move: iterationBest, score: iterationScore };

      // A forced mate is found; no deeper search will improve on it.
      if (Math.abs(iterationScore) > MATE - 100) break;
      if (Date.now() >= searcher.deadline) break;
    }

    // On the easier levels, pick randomly among moves close to the best one.
    if (level.noise > 0) {
      var pool = scored.filter(function (s) {
        return s.score > -INF && s.score >= best.score - level.noise;
      });
      if (pool.length > 1) {
        var pick = pool[Math.floor(Math.random() * pool.length)];
        best = { move: pick.move, score: pick.score };
      }
    }

    return {
      move: best.move,
      score: best.score,
      depth: completedDepth,
      nodes: searcher.nodes,
      timeMs: Date.now() - started
    };
  }

  global.ChessAI = {
    LEVELS: LEVELS,
    MATE: MATE,
    evaluate: evaluate,
    chooseMove: chooseMove
  };
})(typeof self !== 'undefined' ? self : this);
