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

console.log(failures === 0 ? '\nperft: all checks passed' : '\nperft: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
