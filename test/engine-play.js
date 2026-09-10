/*
 * engine-play.js — the search plays sensible chess.
 *
 * Perft proves the rules are right; these checks prove the engine actually
 * uses them well: it finds forced mates, wins hanging material, respects its
 * time budget, and a stronger level beats a weaker one.
 */
global.self = global;
require('../js/engine.js');
require('../js/ai.js');
var C = global.Chess;
var AI = global.ChessAI;

var failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}

function san(pos, move) { return C.toSAN(pos, move, C.legalMoves(pos)); }

// Guards the test data itself: a position where the side that just moved is
// still in check could never arise in a real game.
function legalPosition(pos) { return !C.inCheck(pos, C.opponent(pos.turn)); }

var TACTICS = [
  ['back-rank mate in one', '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1', ['Ra8#']],
  ['wins the hanging queen', '4k3/8/8/3q4/4B3/8/8/4K3 w - - 0 1', ['Bxd5']],
  ['king-supported rook mate', '7k/8/6K1/8/8/8/8/R7 w - - 0 1', ['Ra8#']],
  ['queens the pawn', '8/4P3/8/8/8/8/8/k1K5 w - - 0 1', ['e8=Q']]
];

TACTICS.forEach(function (t) {
  var pos = C.parseFEN(t[1]);
  check(t[0] + ' — position is legal', legalPosition(pos), t[1]);
  var result = AI.chooseMove(pos, 'hard');
  var played = san(pos, result.move);
  check(t[0], t[2].indexOf(played) !== -1,
    'played ' + played + ', want ' + t[2].join('/') + ' (depth ' + result.depth + ')');
});

// Confirm by brute force that a mate really is forced here, then require the
// engine to report a mate score for it.
function forcedMateIn(pos, n) {
  var moves = C.legalMoves(pos);
  for (var i = 0; i < moves.length; i++) {
    C.makeMove(pos, moves[i]);
    var replies = C.legalMoves(pos);
    if (replies.length === 0) {
      var isMate = C.inCheck(pos, pos.turn);
      C.unmakeMove(pos);
      if (isMate) return 1;
      continue;
    }
    if (n > 1) {
      var allDefencesLose = true;
      for (var j = 0; j < replies.length; j++) {
        C.makeMove(pos, replies[j]);
        var d = forcedMateIn(pos, n - 1);
        C.unmakeMove(pos);
        if (d === 0 || d > n - 1) { allDefencesLose = false; break; }
      }
      if (allDefencesLose) { C.unmakeMove(pos); return n; }
    }
    C.unmakeMove(pos);
  }
  return 0;
}

(function () {
  var pos = C.parseFEN('7k/8/8/8/8/8/8/R5RK w - - 0 1');
  check('ladder mate — brute force confirms mate in 2', forcedMateIn(pos, 2) === 2);
  var result = AI.chooseMove(pos, 'hard');
  check('engine returns a mate score when mate is forced',
    Math.abs(result.score) > AI.MATE - 100,
    'played ' + san(pos, result.move) + ', score ' + result.score);
})();

['easy', 'medium', 'hard', 'expert'].forEach(function (level) {
  var pos = C.parseFEN(C.START_FEN);
  var started = Date.now();
  var result = AI.chooseMove(pos, level);
  var elapsed = Date.now() - started;
  var legal = C.legalMoves(pos).some(function (m) {
    return m.from === result.move.from && m.to === result.move.to;
  });
  var budget = AI.LEVELS[level].timeMs + 1500;
  check(level + ' returns a legal move within its time budget', legal && elapsed < budget,
    san(pos, result.move) + ', depth ' + result.depth + ', ' + elapsed + 'ms of ' + budget + 'ms');
});

function playGame(whiteLevel, blackLevel) {
  var pos = C.parseFEN(C.START_FEN);
  var seen = {};
  for (var ply = 0; ply < 260; ply++) {
    if (C.legalMoves(pos).length === 0) {
      return C.inCheck(pos, pos.turn) ? C.opponent(pos.turn) : 'draw';
    }
    if (pos.halfmove >= 100 || C.hasInsufficientMaterial(pos)) return 'draw';
    var key = pos.key();
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] >= 3) return 'draw';
    C.makeMove(pos, AI.chooseMove(pos, pos.turn === C.WHITE ? whiteLevel : blackLevel).move);
  }
  return 'draw';
}

(function () {
  var score = 0;
  var log = [];
  for (var g = 0; g < 4; g++) {
    // Alternate colours so neither level gets the first-move advantage twice.
    var hardIsWhite = g % 2 === 0;
    var winner = hardIsWhite ? playGame('hard', 'easy') : playGame('easy', 'hard');
    var hardColor = hardIsWhite ? C.WHITE : C.BLACK;
    if (winner === hardColor) score += 1;
    else if (winner === 'draw') score += 0.5;
    log.push((hardIsWhite ? 'hard=white' : 'hard=black') + ':' + winner);
  }
  check('hard outscores easy over four games', score >= 3,
    'hard scored ' + score + '/4  [' + log.join(', ') + ']');
})();

(function () {
  var pos = C.parseFEN(C.START_FEN);
  var outcome = 'unfinished';
  var plies = 0;
  var seen = {};
  // "hard" is deterministic, so this game is identical on every run. The
  // easier levels deliberately randomise, which makes their game length vary
  // wildly — a drawn-out endgame can legitimately run past 400 plies before
  // the fifty-move rule ends it.
  while (plies < 400) {
    if (C.legalMoves(pos).length === 0) {
      outcome = C.inCheck(pos, pos.turn) ? 'checkmate' : 'stalemate';
      break;
    }
    if (pos.halfmove >= 100) { outcome = 'fifty-move rule'; break; }
    if (C.hasInsufficientMaterial(pos)) { outcome = 'insufficient material'; break; }
    var key = pos.key();
    seen[key] = (seen[key] || 0) + 1;
    if (seen[key] >= 3) { outcome = 'threefold repetition'; break; }
    C.makeMove(pos, AI.chooseMove(pos, 'hard').move);
    plies++;
  }
  check('self-play reaches a terminal position', outcome !== 'unfinished',
    outcome + ' after ' + plies + ' plies');

  while (pos.undoStack.length) C.unmakeMove(pos);
  check('unwinding every move restores the starting position',
    C.toFEN(pos) === C.START_FEN);
})();

console.log(failures === 0 ? '\nengine-play: all checks passed'
                           : '\nengine-play: ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
