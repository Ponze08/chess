/*
 * perft.js — move generation correctness.
 *
 * Perft counts leaf nodes of the move tree to a fixed depth. The expected
 * counts below are the published values for the standard test positions, so
 * any disagreement means the generator mishandles something — most often
 * en passant, castling rights, pins, or promotions.
 */
global.self = global;
require('../js/engine.js');
var C = global.Chess;

function perft(pos, depth) {
  if (depth === 0) return 1;
  var moves = C.legalMoves(pos);
  if (depth === 1) return moves.length;
  var nodes = 0;
  for (var i = 0; i < moves.length; i++) {
    C.makeMove(pos, moves[i]);
    nodes += perft(pos, depth - 1);
    C.unmakeMove(pos);
  }
  return nodes;
}

var SUITES = [
  ['initial',  C.START_FEN, [20, 400, 8902, 197281, 4865609]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603]],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624]],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333]],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487]],
  ['position 6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890, 3894594]]
];

var failures = 0;

SUITES.forEach(function (suite) {
  var name = suite[0], fen = suite[1], expected = suite[2];
  var pos = C.parseFEN(fen);
  for (var d = 1; d <= expected.length; d++) {
    var started = Date.now();
    var got = perft(pos, d);
    var ok = got === expected[d - 1];
    if (!ok) failures++;
    console.log(
      (ok ? 'ok  ' : 'FAIL') + '  ' + name + ' depth ' + d +
      '  got ' + got + '  want ' + expected[d - 1] +
      '  (' + (Date.now() - started) + 'ms)'
    );
  }
});

// The incrementally maintained Zobrist hash must equal a hash computed from
// scratch, otherwise the transposition table would return bogus entries.
function hashesAgree(pos, depth) {
  if (depth === 0) return true;
  var moves = C.legalMoves(pos);
  for (var i = 0; i < moves.length; i++) {
    C.makeMove(pos, moves[i]);
    var fresh = C.parseFEN(C.toFEN(pos));
    var same = fresh.hashHi === pos.hashHi && fresh.hashLo === pos.hashLo;
    if (!same || !hashesAgree(pos, depth - 1)) { C.unmakeMove(pos); return false; }
    C.unmakeMove(pos);
  }
  return true;
}

var zobristOk = hashesAgree(
  C.parseFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'), 3);
console.log((zobristOk ? 'ok  ' : 'FAIL') + '  zobrist hash stays in sync with make/unmake');
if (!zobristOk) failures++;

function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}

// Plays UCI moves and returns the key of every position along the way.
function play(pos, ucis) {
  var keys = [pos.key()];
  ucis.forEach(function (u) {
    var m = C.fromUCI(pos, u);
    if (!m) throw new Error('illegal test move ' + u);
    C.makeMove(pos, m);
    keys.push(pos.key());
  });
  return keys;
}

// An en passant square only exists while a pawn can actually use it.
// Otherwise the same position would hash differently depending on whether
// the last move happened to be a double push, and repetitions would be lost.
(function () {
  var pos = C.parseFEN(C.START_FEN);
  play(pos, ['e2e4']);
  check('no en passant square when no pawn can capture', C.toFEN(pos).split(' ')[3] === '-',
    C.toFEN(pos));

  pos = C.parseFEN(C.START_FEN);
  play(pos, ['e2e4', 'a7a6', 'e4e5', 'd7d5']);
  check('en passant square kept when a capture is possible', C.toFEN(pos).split(' ')[3] === 'd6',
    C.toFEN(pos));

  var a = C.parseFEN('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2');
  var b = C.parseFEN('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  check('a FEN with an unusable en passant square hashes like one without', a.key() === b.key());

  // 1.e4 e5, then both knights out and back twice: the position after
  // 1...e5 occurs three times.
  var keys = play(C.parseFEN(C.START_FEN),
    'e2e4 e7e5 g1f3 b8c6 f3g1 c6b8 g1f3 b8c6 f3g1 c6b8'.split(' '));
  var last = keys[keys.length - 1];
  var seen = keys.filter(function (k) { return k === last; }).length;
  check('threefold repetition counted across a double pawn push', seen === 3, seen + ' occurrences');
})();

(function () {
  var pos = C.parseFEN('8/4P3/8/8/8/8/8/k1K5 w - - 0 1');
  var m = C.fromUCI(pos, 'e7e8n');
  check('UCI promotion parses to the right piece', m && m.promotion === 'N');
  check('UCI round-trips', m && C.toUCI(m) === 'e7e8n');
  check('UCI promotion without a piece is rejected', C.fromUCI(pos, 'e7e8') === null);
  check('UCI illegal move is rejected', C.fromUCI(pos, 'e7e6') === null);
  check('UCI garbage is rejected', C.fromUCI(pos, 'zz9') === null && C.fromUCI(pos, null) === null);
})();

console.log(failures === 0 ? '\nperft: all checks passed' : '\nperft: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
