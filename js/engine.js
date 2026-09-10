/*
 * engine.js — chess rules.
 *
 * The board is a flat 64-entry array. Index 0 is a8 and index 63 is h1, so
 * row 0 is rank 8 and column 0 is file a. Pieces are single characters:
 * uppercase for white (PNBRQK), lowercase for black, null for an empty square.
 */
(function (global) {
  'use strict';

  var FILES = 'abcdefgh';
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  var WHITE = 'w';
  var BLACK = 'b';

  // Castling rights are packed into four bits.
  var WK = 1, WQ = 2, BK = 4, BQ = 8;

  var KNIGHT_DELTAS = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  var KING_DELTAS   = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
  var DIAG_DIRS     = [[-1,-1],[-1,1],[1,-1],[1,1]];
  var ORTHO_DIRS    = [[-1,0],[1,0],[0,-1],[0,1]];
  var ALL_DIRS      = DIAG_DIRS.concat(ORTHO_DIRS);

  function sq(r, c) { return r * 8 + c; }
  function rowOf(i) { return i >> 3; }
  function colOf(i) { return i & 7; }
  function onBoard(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
  function isUpper(p) { return p >= 'A' && p <= 'Z'; }
  function colorOf(p) { return p === null ? null : (isUpper(p) ? WHITE : BLACK); }
  function typeOf(p) { return p === null ? null : p.toLowerCase(); }
  function opponent(c) { return c === WHITE ? BLACK : WHITE; }
  function toAlgebraic(i) { return FILES[colOf(i)] + (8 - rowOf(i)); }
  function fromAlgebraic(s) { return sq(8 - Number(s[1]), FILES.indexOf(s[0])); }

  // --- Zobrist hashing --------------------------------------------------
  // Hashes are kept as two 32-bit halves because JS bitwise ops are 32-bit.

  var seed = 0x2f6e2b17;
  function rnd32() {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed >>> 0;
  }

  var PIECE_KEYS = {};
  'PNBRQKpnbrqk'.split('').forEach(function (p) {
    var table = new Array(64);
    for (var i = 0; i < 64; i++) table[i] = [rnd32(), rnd32()];
    PIECE_KEYS[p] = table;
  });
  var SIDE_KEY = [rnd32(), rnd32()];
  var CASTLE_KEYS = [];
  for (var ci = 0; ci < 16; ci++) CASTLE_KEYS.push([rnd32(), rnd32()]);
  var EP_KEYS = [];
  for (var ei = 0; ei < 8; ei++) EP_KEYS.push([rnd32(), rnd32()]);

  function xorKey(pos, key) {
    pos.hashHi = (pos.hashHi ^ key[0]) >>> 0;
    pos.hashLo = (pos.hashLo ^ key[1]) >>> 0;
  }
  function xorPiece(pos, piece, i) { xorKey(pos, PIECE_KEYS[piece][i]); }

  // --- Position ---------------------------------------------------------

  function Position() {
    this.board = new Array(64).fill(null);
    this.turn = WHITE;
    this.castling = 0;
    this.ep = -1;          // square a pawn may capture onto, or -1
    this.halfmove = 0;     // plies since the last capture or pawn move
    this.fullmove = 1;
    this.kings = { w: -1, b: -1 };
    this.hashHi = 0;
    this.hashLo = 0;
    this.undoStack = [];
  }

  Position.prototype.clone = function () {
    var p = new Position();
    p.board = this.board.slice();
    p.turn = this.turn;
    p.castling = this.castling;
    p.ep = this.ep;
    p.halfmove = this.halfmove;
    p.fullmove = this.fullmove;
    p.kings = { w: this.kings.w, b: this.kings.b };
    p.hashHi = this.hashHi;
    p.hashLo = this.hashLo;
    return p;
  };

  Position.prototype.key = function () {
    return this.hashHi.toString(16) + ':' + this.hashLo.toString(16);
  };

  function recomputeHash(pos) {
    pos.hashHi = 0;
    pos.hashLo = 0;
    for (var i = 0; i < 64; i++) {
      if (pos.board[i] !== null) xorPiece(pos, pos.board[i], i);
    }
    if (pos.turn === BLACK) xorKey(pos, SIDE_KEY);
    xorKey(pos, CASTLE_KEYS[pos.castling]);
    if (pos.ep !== -1) xorKey(pos, EP_KEYS[colOf(pos.ep)]);
  }

  function parseFEN(fen) {
    var pos = new Position();
    var parts = fen.trim().split(/\s+/);
    var rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('Bad FEN: expected 8 ranks');

    for (var r = 0; r < 8; r++) {
      var c = 0;
      for (var k = 0; k < rows[r].length; k++) {
        var ch = rows[r][k];
        if (ch >= '1' && ch <= '8') {
          c += Number(ch);
        } else {
          pos.board[sq(r, c)] = ch;
          if (ch === 'K') pos.kings.w = sq(r, c);
          if (ch === 'k') pos.kings.b = sq(r, c);
          c++;
        }
      }
    }

    pos.turn = parts[1] === 'b' ? BLACK : WHITE;

    var rights = parts[2] || '-';
    if (rights.indexOf('K') !== -1) pos.castling |= WK;
    if (rights.indexOf('Q') !== -1) pos.castling |= WQ;
    if (rights.indexOf('k') !== -1) pos.castling |= BK;
    if (rights.indexOf('q') !== -1) pos.castling |= BQ;

    pos.ep = (parts[3] && parts[3] !== '-') ? fromAlgebraic(parts[3]) : -1;
    pos.halfmove = parts[4] ? Number(parts[4]) : 0;
    pos.fullmove = parts[5] ? Number(parts[5]) : 1;

    recomputeHash(pos);
    return pos;
  }

  function toFEN(pos) {
    var rows = [];
    for (var r = 0; r < 8; r++) {
      var row = '', empty = 0;
      for (var c = 0; c < 8; c++) {
        var p = pos.board[sq(r, c)];
        if (p === null) {
          empty++;
        } else {
          if (empty) { row += empty; empty = 0; }
          row += p;
        }
      }
      if (empty) row += empty;
      rows.push(row);
    }
    var rights = '';
    if (pos.castling & WK) rights += 'K';
    if (pos.castling & WQ) rights += 'Q';
    if (pos.castling & BK) rights += 'k';
    if (pos.castling & BQ) rights += 'q';
    return [
      rows.join('/'),
      pos.turn,
      rights || '-',
      pos.ep === -1 ? '-' : toAlgebraic(pos.ep),
      pos.halfmove,
      pos.fullmove
    ].join(' ');
  }

  // --- Attack detection -------------------------------------------------

  // True if side `by` attacks `target`. Used for check tests and castling
  // paths, so it deliberately ignores whether the attacker is pinned.
  function isAttacked(pos, target, by) {
    var b = pos.board;
    var tr = rowOf(target), tc = colOf(target);
    var i, r, c, p, dir;

    // Pawns. A white pawn on (r, c) attacks (r-1, c±1), so a white attacker
    // of `target` sits one row below it.
    var pawnRow = by === WHITE ? tr + 1 : tr - 1;
    var pawn = by === WHITE ? 'P' : 'p';
    if (onBoard(pawnRow, tc - 1) && b[sq(pawnRow, tc - 1)] === pawn) return true;
    if (onBoard(pawnRow, tc + 1) && b[sq(pawnRow, tc + 1)] === pawn) return true;

    var knight = by === WHITE ? 'N' : 'n';
    for (i = 0; i < KNIGHT_DELTAS.length; i++) {
      r = tr + KNIGHT_DELTAS[i][0]; c = tc + KNIGHT_DELTAS[i][1];
      if (onBoard(r, c) && b[sq(r, c)] === knight) return true;
    }

    var king = by === WHITE ? 'K' : 'k';
    for (i = 0; i < KING_DELTAS.length; i++) {
      r = tr + KING_DELTAS[i][0]; c = tc + KING_DELTAS[i][1];
      if (onBoard(r, c) && b[sq(r, c)] === king) return true;
    }

    var bishop = by === WHITE ? 'B' : 'b';
    var queen  = by === WHITE ? 'Q' : 'q';
    for (i = 0; i < DIAG_DIRS.length; i++) {
      dir = DIAG_DIRS[i];
      r = tr + dir[0]; c = tc + dir[1];
      while (onBoard(r, c)) {
        p = b[sq(r, c)];
        if (p !== null) {
          if (p === bishop || p === queen) return true;
          break;
        }
        r += dir[0]; c += dir[1];
      }
    }

    var rook = by === WHITE ? 'R' : 'r';
    for (i = 0; i < ORTHO_DIRS.length; i++) {
      dir = ORTHO_DIRS[i];
      r = tr + dir[0]; c = tc + dir[1];
      while (onBoard(r, c)) {
        p = b[sq(r, c)];
        if (p !== null) {
          if (p === rook || p === queen) return true;
          break;
        }
        r += dir[0]; c += dir[1];
      }
    }

    return false;
  }

  function inCheck(pos, color) {
    var k = pos.kings[color];
    return k !== -1 && isAttacked(pos, k, opponent(color));
  }

  // --- Move generation --------------------------------------------------

  // A move is a plain object:
  //   from, to      square indices
  //   piece         the moving piece character
  //   captured      captured piece character, or null
  //   capturedSq    where the captured piece sits (differs from `to` on en passant)
  //   promotion     promotion piece character, or null
  //   flag          '', 'double', 'ep' or 'castle'
  function mkMove(from, to, piece, captured, capturedSq, promotion, flag) {
    return {
      from: from,
      to: to,
      piece: piece,
      captured: captured === undefined ? null : captured,
      capturedSq: capturedSq === undefined ? to : capturedSq,
      promotion: promotion || null,
      flag: flag || ''
    };
  }

  var PROMOTION_PIECES = { w: ['Q', 'R', 'B', 'N'], b: ['q', 'r', 'b', 'n'] };

  function generatePseudoMoves(pos, capturesOnly) {
    var moves = [];
    var b = pos.board;
    var us = pos.turn;
    var them = opponent(us);
    var from, i, j, r, c, nr, nc, to, target, d, dir, dirs, deltas, promos;

    for (from = 0; from < 64; from++) {
      var piece = b[from];
      if (piece === null || colorOf(piece) !== us) continue;
      var type = typeOf(piece);
      r = rowOf(from);
      c = colOf(from);

      if (type === 'p') {
        var forward = us === WHITE ? -1 : 1;
        var startRow = us === WHITE ? 6 : 1;
        var promoRow = us === WHITE ? 0 : 7;
        promos = PROMOTION_PIECES[us];

        nr = r + forward;
        if (!capturesOnly && onBoard(nr, c) && b[sq(nr, c)] === null) {
          if (nr === promoRow) {
            for (j = 0; j < promos.length; j++) {
              moves.push(mkMove(from, sq(nr, c), piece, null, undefined, promos[j], ''));
            }
          } else {
            moves.push(mkMove(from, sq(nr, c), piece));
            // Double push: only from the home rank, and only over empty squares.
            if (r === startRow && b[sq(r + forward * 2, c)] === null) {
              moves.push(mkMove(from, sq(r + forward * 2, c), piece, null, undefined, null, 'double'));
            }
          }
        }

        // Captures, including en passant.
        for (d = -1; d <= 1; d += 2) {
          nr = r + forward;
          nc = c + d;
          if (!onBoard(nr, nc)) continue;
          to = sq(nr, nc);
          target = b[to];
          if (target !== null && colorOf(target) === them) {
            if (nr === promoRow) {
              for (j = 0; j < promos.length; j++) {
                moves.push(mkMove(from, to, piece, target, to, promos[j], ''));
              }
            } else {
              moves.push(mkMove(from, to, piece, target));
            }
          } else if (target === null && to === pos.ep && pos.ep !== -1) {
            var capSq = sq(r, nc);
            moves.push(mkMove(from, to, piece, b[capSq], capSq, null, 'ep'));
          }
        }
        continue;
      }

      if (type === 'n' || type === 'k') {
        deltas = type === 'n' ? KNIGHT_DELTAS : KING_DELTAS;
        for (i = 0; i < deltas.length; i++) {
          nr = r + deltas[i][0];
          nc = c + deltas[i][1];
          if (!onBoard(nr, nc)) continue;
          to = sq(nr, nc);
          target = b[to];
          if (target !== null && colorOf(target) === us) continue;
          if (capturesOnly && target === null) continue;
          moves.push(mkMove(from, to, piece, target));
        }
        continue;
      }

      // Sliding pieces.
      dirs = type === 'b' ? DIAG_DIRS : type === 'r' ? ORTHO_DIRS : ALL_DIRS;
      for (i = 0; i < dirs.length; i++) {
        dir = dirs[i];
        nr = r + dir[0];
        nc = c + dir[1];
        while (onBoard(nr, nc)) {
          to = sq(nr, nc);
          target = b[to];
          if (target === null) {
            if (!capturesOnly) moves.push(mkMove(from, to, piece));
          } else {
            if (colorOf(target) === them) moves.push(mkMove(from, to, piece, target));
            break;
          }
          nr += dir[0];
          nc += dir[1];
        }
      }
    }

    if (!capturesOnly) addCastlingMoves(pos, moves);
    return moves;
  }

  function addCastlingMoves(pos, moves) {
    var b = pos.board;
    var us = pos.turn;
    var them = opponent(us);
    var homeRow = us === WHITE ? 7 : 0;
    var king = us === WHITE ? 'K' : 'k';
    var rook = us === WHITE ? 'R' : 'r';
    var kingSq = sq(homeRow, 4);

    if (b[kingSq] !== king) return;
    if (isAttacked(pos, kingSq, them)) return;   // no castling out of check

    var kingSide = us === WHITE ? WK : BK;
    var queenSide = us === WHITE ? WQ : BQ;

    if ((pos.castling & kingSide) && b[sq(homeRow, 7)] === rook &&
        b[sq(homeRow, 5)] === null && b[sq(homeRow, 6)] === null &&
        !isAttacked(pos, sq(homeRow, 5), them) &&
        !isAttacked(pos, sq(homeRow, 6), them)) {
      moves.push(mkMove(kingSq, sq(homeRow, 6), king, null, undefined, null, 'castle'));
    }

    if ((pos.castling & queenSide) && b[sq(homeRow, 0)] === rook &&
        b[sq(homeRow, 1)] === null && b[sq(homeRow, 2)] === null &&
        b[sq(homeRow, 3)] === null &&
        !isAttacked(pos, sq(homeRow, 3), them) &&
        !isAttacked(pos, sq(homeRow, 2), them)) {
      moves.push(mkMove(kingSq, sq(homeRow, 2), king, null, undefined, null, 'castle'));
    }
  }

  // Castling rights are lost when a king or rook leaves its home square, and
  // when a rook is captured on its home square.
  function castlingMask(i) {
    switch (i) {
      case 0:  return BQ;         // a8
      case 4:  return BK | BQ;    // e8
      case 7:  return BK;         // h8
      case 56: return WQ;         // a1
      case 60: return WK | WQ;    // e1
      case 63: return WK;         // h1
      default: return 0;
    }
  }

  function makeMove(pos, m) {
    pos.undoStack.push({
      move: m,
      ep: pos.ep,
      castling: pos.castling,
      halfmove: pos.halfmove,
      fullmove: pos.fullmove,
      hashHi: pos.hashHi,
      hashLo: pos.hashLo
    });

    var b = pos.board;
    var us = pos.turn;

    if (pos.ep !== -1) xorKey(pos, EP_KEYS[colOf(pos.ep)]);
    xorKey(pos, CASTLE_KEYS[pos.castling]);

    if (m.captured !== null) {
      xorPiece(pos, m.captured, m.capturedSq);
      b[m.capturedSq] = null;
    }

    xorPiece(pos, m.piece, m.from);
    b[m.from] = null;
    var landed = m.promotion || m.piece;
    b[m.to] = landed;
    xorPiece(pos, landed, m.to);

    if (m.flag === 'castle') {
      var homeRow = rowOf(m.from);
      var rook = us === WHITE ? 'R' : 'r';
      var rookFrom = colOf(m.to) === 6 ? sq(homeRow, 7) : sq(homeRow, 0);
      var rookTo   = colOf(m.to) === 6 ? sq(homeRow, 5) : sq(homeRow, 3);
      xorPiece(pos, rook, rookFrom);
      b[rookFrom] = null;
      b[rookTo] = rook;
      xorPiece(pos, rook, rookTo);
    }

    if (typeOf(m.piece) === 'k') pos.kings[us] = m.to;

    pos.castling &= ~(castlingMask(m.from) | castlingMask(m.to));
    xorKey(pos, CASTLE_KEYS[pos.castling]);

    pos.ep = m.flag === 'double' ? (m.from + m.to) / 2 : -1;
    if (pos.ep !== -1) xorKey(pos, EP_KEYS[colOf(pos.ep)]);

    if (typeOf(m.piece) === 'p' || m.captured !== null) pos.halfmove = 0;
    else pos.halfmove++;

    if (us === BLACK) pos.fullmove++;
    pos.turn = opponent(us);
    xorKey(pos, SIDE_KEY);
  }

  function unmakeMove(pos) {
    var undo = pos.undoStack.pop();
    if (!undo) return null;
    var m = undo.move;
    var b = pos.board;

    pos.turn = colorOf(m.piece);
    pos.ep = undo.ep;
    pos.castling = undo.castling;
    pos.halfmove = undo.halfmove;
    pos.fullmove = undo.fullmove;
    pos.hashHi = undo.hashHi;
    pos.hashLo = undo.hashLo;

    b[m.to] = null;
    b[m.from] = m.piece;
    if (m.captured !== null) b[m.capturedSq] = m.captured;

    if (m.flag === 'castle') {
      var homeRow = rowOf(m.from);
      var rook = pos.turn === WHITE ? 'R' : 'r';
      var rookFrom = colOf(m.to) === 6 ? sq(homeRow, 7) : sq(homeRow, 0);
      var rookTo   = colOf(m.to) === 6 ? sq(homeRow, 5) : sq(homeRow, 3);
      b[rookTo] = null;
      b[rookFrom] = rook;
    }

    if (typeOf(m.piece) === 'k') pos.kings[pos.turn] = m.from;
    return m;
  }

  // Pseudo-legal moves filtered down to those that leave our own king safe.
  function legalMoves(pos) {
    var pseudo = generatePseudoMoves(pos, false);
    var us = pos.turn;
    var out = [];
    for (var i = 0; i < pseudo.length; i++) {
      makeMove(pos, pseudo[i]);
      if (!inCheck(pos, us)) out.push(pseudo[i]);
      unmakeMove(pos);
    }
    return out;
  }

  function movesFrom(pos, from) {
    return legalMoves(pos).filter(function (m) { return m.from === from; });
  }

  function findMove(pos, from, to, promotion) {
    var candidates = legalMoves(pos).filter(function (m) {
      return m.from === from && m.to === to;
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    var wanted = (promotion || 'q').toLowerCase();
    var matched = candidates.filter(function (m) {
      return m.promotion && m.promotion.toLowerCase() === wanted;
    });
    return matched[0] || candidates[0];
  }

  // --- Notation ---------------------------------------------------------

  // Standard algebraic notation. Needs the legal move list of the position
  // *before* the move, to work out how much disambiguation is required.
  function toSAN(pos, move, legal) {
    legal = legal || legalMoves(pos);
    var type = typeOf(move.piece);
    var san;

    if (move.flag === 'castle') {
      san = colOf(move.to) === 6 ? 'O-O' : 'O-O-O';
    } else if (type === 'p') {
      san = move.captured !== null
        ? FILES[colOf(move.from)] + 'x' + toAlgebraic(move.to)
        : toAlgebraic(move.to);
      if (move.promotion) san += '=' + move.promotion.toUpperCase();
    } else {
      var rivals = legal.filter(function (m) {
        return m.to === move.to && m.piece === move.piece && m.from !== move.from;
      });
      var hint = '';
      if (rivals.length) {
        var sharesFile = rivals.some(function (m) { return colOf(m.from) === colOf(move.from); });
        var sharesRank = rivals.some(function (m) { return rowOf(m.from) === rowOf(move.from); });
        if (!sharesFile) hint = FILES[colOf(move.from)];
        else if (!sharesRank) hint = String(8 - rowOf(move.from));
        else hint = toAlgebraic(move.from);
      }
      san = type.toUpperCase() + hint + (move.captured !== null ? 'x' : '') + toAlgebraic(move.to);
    }

    makeMove(pos, move);
    if (inCheck(pos, pos.turn)) san += legalMoves(pos).length === 0 ? '#' : '+';
    unmakeMove(pos);

    return san;
  }

  // --- Draw conditions --------------------------------------------------

  function hasInsufficientMaterial(pos) {
    var minors = [];
    for (var i = 0; i < 64; i++) {
      var p = pos.board[i];
      if (p === null) continue;
      var t = typeOf(p);
      if (t === 'p' || t === 'r' || t === 'q') return false;
      if (t !== 'k') {
        minors.push({ type: t, light: (rowOf(i) + colOf(i)) % 2 === 0 });
      }
    }
    // Bare kings, or a single minor piece.
    if (minors.length <= 1) return true;
    // Bishops only, all sharing one colour complex.
    if (minors.every(function (m) { return m.type === 'b'; })) {
      return minors.every(function (m) { return m.light === minors[0].light; });
    }
    return false;
  }

  global.Chess = {
    WHITE: WHITE,
    BLACK: BLACK,
    START_FEN: START_FEN,
    FILES: FILES,
    Position: Position,
    parseFEN: parseFEN,
    toFEN: toFEN,
    sq: sq,
    rowOf: rowOf,
    colOf: colOf,
    colorOf: colorOf,
    typeOf: typeOf,
    opponent: opponent,
    toAlgebraic: toAlgebraic,
    fromAlgebraic: fromAlgebraic,
    isAttacked: isAttacked,
    inCheck: inCheck,
    generatePseudoMoves: generatePseudoMoves,
    legalMoves: legalMoves,
    movesFrom: movesFrom,
    findMove: findMove,
    makeMove: makeMove,
    unmakeMove: unmakeMove,
    toSAN: toSAN,
    hasInsufficientMaterial: hasInsufficientMaterial
  };
})(typeof self !== 'undefined' ? self : this);
