/*
 * ui.js — board rendering, input handling, and the game loop that alternates
 * between the human player and the engine.
 */
(function () {
  'use strict';

  var C = window.Chess;
  var AI = window.ChessAI;

  // Both colours use the solid glyph set; the fill colour distinguishes them,
  // so the two sides always have identical silhouettes.
  var GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  var PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  var FULL_ARMY = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
  var STORAGE_KEY = 'chess.prefs.v1';

  var el = {};
  var state = {
    pos: null,
    humanColor: C.WHITE,
    level: 'medium',
    orientation: C.WHITE,
    moves: [],          // { san, move }
    keyHistory: [],     // position keys, for threefold repetition
    selected: -1,
    targets: [],        // legal moves from the selected square
    lastMove: null,
    suggestion: null,   // move highlighted by the Hint button
    result: null,
    thinking: false,
    evalScore: 0,       // centipawns, always from White's point of view
    generation: 0       // bumped to invalidate in-flight engine replies
  };

  // --- Engine transport -------------------------------------------------

  // Prefers a worker so the board stays responsive, and falls back to the
  // main thread when workers are unavailable — notably for file:// pages,
  // where browsers refuse to construct a worker.
  var engine = {
    worker: null,
    seq: 0,
    pending: {},

    init: function () {
      if (typeof Worker !== 'function' || window.location.protocol === 'file:') return;
      try {
        this.worker = new Worker('js/worker.js');
        var self = this;
        this.worker.onmessage = function (e) {
          var cb = self.pending[e.data.id];
          delete self.pending[e.data.id];
          if (!cb) return;
          if (e.data.error) { self.demote(); return; }
          cb(e.data);
        };
        this.worker.onerror = function () { self.demote(); };
      } catch (err) {
        this.worker = null;
      }
    },

    // The worker failed; drop it and let later requests run inline.
    demote: function () {
      var stranded = this.pending;
      this.pending = {};
      if (this.worker) { this.worker.terminate(); this.worker = null; }
      Object.keys(stranded).forEach(function (id) {
        // Re-issue on the main thread so the game does not stall.
        var req = stranded[id];
        if (req && req.retry) req.retry();
      });
    },

    think: function (fen, level, done) {
      var id = ++this.seq;
      if (this.worker) {
        var self = this;
        var cb = function (data) { done(data); };
        cb.retry = function () { self.inline(fen, level, done); };
        this.pending[id] = cb;
        this.worker.postMessage({ id: id, fen: fen, level: level });
      } else {
        this.inline(fen, level, done);
      }
    },

    // Yield first so the "Thinking…" state paints before the search blocks.
    inline: function (fen, level, done) {
      setTimeout(function () {
        var pos = C.parseFEN(fen);
        var res = AI.chooseMove(pos, level);
        done(res ? {
          move: { from: res.move.from, to: res.move.to, promotion: res.move.promotion },
          score: res.score, depth: res.depth, nodes: res.nodes, timeMs: res.timeMs
        } : { move: null });
      }, 30);
    }
  };

  // --- Preferences ------------------------------------------------------

  function loadPrefs() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var p = JSON.parse(raw);
      if (p.level && AI.LEVELS[p.level]) state.level = p.level;
      if (p.humanColor === C.WHITE || p.humanColor === C.BLACK) state.humanColor = p.humanColor;
    } catch (err) { /* storage may be unavailable; defaults are fine */ }
  }

  function savePrefs() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        level: state.level, humanColor: state.humanColor
      }));
    } catch (err) { /* ignore */ }
  }

  // --- Game flow --------------------------------------------------------

  function newGame() {
    state.generation++;
    state.pos = C.parseFEN(C.START_FEN);
    state.moves = [];
    state.keyHistory = [state.pos.key()];
    state.selected = -1;
    state.targets = [];
    state.lastMove = null;
    state.suggestion = null;
    state.result = null;
    state.thinking = false;
    state.evalScore = 0;
    state.orientation = state.humanColor;
    render();
    if (state.pos.turn !== state.humanColor) requestEngineMove();
  }

  function detectResult() {
    var pos = state.pos;
    if (C.legalMoves(pos).length === 0) {
      return C.inCheck(pos, pos.turn)
        ? { kind: 'checkmate', winner: C.opponent(pos.turn) }
        : { kind: 'stalemate' };
    }
    if (pos.halfmove >= 100) return { kind: 'fifty' };
    if (C.hasInsufficientMaterial(pos)) return { kind: 'material' };
    if (repetitionCount() >= 3) return { kind: 'repetition' };
    return null;
  }

  function repetitionCount() {
    var key = state.pos.key();
    var n = 0;
    for (var i = 0; i < state.keyHistory.length; i++) {
      if (state.keyHistory[i] === key) n++;
    }
    return n;
  }

  function applyMove(move) {
    // SAN must be generated before the move is played.
    var san = C.toSAN(state.pos, move, C.legalMoves(state.pos));
    C.makeMove(state.pos, move);
    state.moves.push({ san: san, move: move });
    state.keyHistory.push(state.pos.key());
    state.lastMove = move;
    state.selected = -1;
    state.targets = [];
    state.suggestion = null;
    state.result = detectResult();
    render();
    if (!state.result && state.pos.turn !== state.humanColor) requestEngineMove();
  }

  function requestEngineMove() {
    state.thinking = true;
    render();
    var gen = state.generation;
    var fen = C.toFEN(state.pos);

    engine.think(fen, state.level, function (data) {
      // A new game or an undo happened while the engine was searching.
      if (gen !== state.generation) return;
      state.thinking = false;

      if (!data || !data.move) { render(); return; }

      var move = C.findMove(state.pos, data.move.from, data.move.to, data.move.promotion);
      if (!move) { render(); return; }

      if (typeof data.score === 'number') {
        // Scores come back from the mover's point of view; store White's.
        state.evalScore = state.pos.turn === C.WHITE ? data.score : -data.score;
      }
      showEngineLine(data);
      applyMove(move);
    });
  }

  function undo() {
    if (!state.moves.length) return;
    state.generation++;          // discard any search still running
    state.thinking = false;

    // Step back until it is the human's turn again, so a full move pair
    // (the computer's reply plus your own move) comes off together.
    do {
      C.unmakeMove(state.pos);
      state.moves.pop();
      state.keyHistory.pop();
    } while (state.moves.length && state.pos.turn !== state.humanColor);

    state.lastMove = state.moves.length ? state.moves[state.moves.length - 1].move : null;
    state.selected = -1;
    state.targets = [];
    state.suggestion = null;
    state.result = null;
    el.engineLine.innerHTML = '&nbsp;';
    render();

    // Undoing into a position where the engine is on move (playing Black and
    // taking back to the very start) needs the engine to move again.
    if (state.pos.turn !== state.humanColor) requestEngineMove();
  }

  function showHint() {
    if (state.thinking || state.result || state.pos.turn !== state.humanColor) return;
    state.thinking = true;
    render();
    var gen = state.generation;
    engine.think(C.toFEN(state.pos), 'medium', function (data) {
      if (gen !== state.generation) return;
      state.thinking = false;
      if (data && data.move) {
        state.suggestion = { from: data.move.from, to: data.move.to };
      }
      render();
    });
  }

  // --- Human input ------------------------------------------------------

  function humanCanMove() {
    return !state.thinking && !state.result && state.pos.turn === state.humanColor;
  }

  function selectSquare(index) {
    var piece = state.pos.board[index];
    if (piece === null || C.colorOf(piece) !== state.humanColor) {
      state.selected = -1;
      state.targets = [];
      return;
    }
    state.selected = index;
    state.targets = C.movesFrom(state.pos, index);
  }

  // Returns true when the click/drop consumed the interaction.
  function attemptMove(from, to) {
    var candidates = state.targets.filter(function (m) {
      return m.from === from && m.to === to;
    });
    if (!candidates.length) return false;

    if (candidates.length > 1 && candidates[0].promotion) {
      askPromotion(candidates);
      return true;
    }
    applyMove(candidates[0]);
    return true;
  }

  function askPromotion(candidates) {
    el.promotionChoices.innerHTML = '';
    // Present them queen-first, which is what players want nearly always.
    var order = ['q', 'r', 'b', 'n'];
    order.forEach(function (t) {
      var move = candidates.filter(function (m) {
        return C.typeOf(m.promotion) === t;
      })[0];
      if (!move) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promo-btn';
      btn.title = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t];
      btn.appendChild(pieceSpan(move.promotion));
      btn.addEventListener('click', function () {
        el.promotionModal.hidden = true;
        applyMove(move);
      });
      el.promotionChoices.appendChild(btn);
    });
    el.promotionModal.hidden = false;
  }

  // --- Rendering --------------------------------------------------------

  function pieceSpan(piece) {
    var span = document.createElement('span');
    span.className = 'piece piece--' + C.colorOf(piece);
    span.textContent = GLYPH[C.typeOf(piece)];
    return span;
  }

  function boardIndexAt(visual) {
    return state.orientation === C.WHITE ? visual : 63 - visual;
  }

  function render() {
    renderBoard();
    renderStatus();
    renderMoves();
    renderCaptured();
    renderEvalBar();
    renderControls();
  }

  function renderBoard() {
    var pos = state.pos;
    var frag = document.createDocumentFragment();
    var checkedKing = -1;
    if (C.inCheck(pos, pos.turn)) checkedKing = pos.kings[pos.turn];

    for (var visual = 0; visual < 64; visual++) {
      var index = boardIndexAt(visual);
      var vr = visual >> 3, vc = visual & 7;
      var square = document.createElement('div');
      var isLight = (C.rowOf(index) + C.colOf(index)) % 2 === 0;

      square.className = 'square ' + (isLight ? 'square--light' : 'square--dark');
      square.dataset.index = String(index);
      square.setAttribute('role', 'gridcell');
      square.setAttribute('aria-label', C.toAlgebraic(index));

      if (state.lastMove && (index === state.lastMove.from || index === state.lastMove.to)) {
        square.classList.add('square--last');
      }
      if (index === state.selected) square.classList.add('square--selected');
      if (index === checkedKing) square.classList.add('square--check');
      if (state.suggestion &&
          (index === state.suggestion.from || index === state.suggestion.to)) {
        square.classList.add('square--suggest');
      }

      var piece = pos.board[index];
      if (piece !== null) square.appendChild(pieceSpan(piece));

      // Move hints: a dot for a quiet move, a ring for a capture.
      var target = state.targets.filter(function (m) { return m.to === index; })[0];
      if (target) {
        var hint = document.createElement('span');
        hint.className = target.captured !== null ? 'hint-ring' : 'hint-dot';
        square.appendChild(hint);
        square.classList.add('square--playable');
      } else if (piece !== null && C.colorOf(piece) === state.humanColor && humanCanMove()) {
        square.classList.add('square--playable');
      }

      // Coordinates along the left and bottom edges only.
      if (vc === 0) {
        var rank = document.createElement('span');
        rank.className = 'square__rank';
        rank.textContent = String(8 - C.rowOf(index));
        square.appendChild(rank);
      }
      if (vr === 7) {
        var file = document.createElement('span');
        file.className = 'square__file';
        file.textContent = C.FILES[C.colOf(index)];
        square.appendChild(file);
      }

      frag.appendChild(square);
    }

    el.board.innerHTML = '';
    el.board.appendChild(frag);
    el.boardVeil.hidden = humanCanMove();
  }

  function renderStatus() {
    var cls = 'status';
    var text;

    if (state.result) {
      cls += ' status--over';
      var r = state.result;
      if (r.kind === 'checkmate') {
        var youWon = r.winner === state.humanColor;
        text = 'Checkmate — ' + (youWon ? 'you win!' : 'the computer wins.');
      } else if (r.kind === 'stalemate') {
        text = 'Stalemate — draw.';
      } else if (r.kind === 'fifty') {
        text = 'Draw by the fifty-move rule.';
      } else if (r.kind === 'material') {
        text = 'Draw — insufficient material.';
      } else {
        text = 'Draw by threefold repetition.';
      }
    } else if (state.thinking) {
      cls += ' status--thinking';
      text = 'Computer is thinking…';
    } else {
      var checked = C.inCheck(state.pos, state.pos.turn);
      if (checked) cls += ' status--check';
      var yours = state.pos.turn === state.humanColor;
      text = (yours ? 'Your move' : 'Computer to move') + (checked ? ' — check!' : '.');
    }

    el.status.className = cls;
    el.statusText.textContent = text;
  }

  function showEngineLine(data) {
    if (typeof data.depth !== 'number') { el.engineLine.innerHTML = '&nbsp;'; return; }
    // Both readouts are from White's point of view, so a leading + always
    // means White is better, mate scores included.
    var score = state.evalScore;
    var sign = score >= 0 ? '+' : '−';
    var shown;
    if (Math.abs(score) > AI.MATE - 100) {
      shown = sign + 'M' + Math.ceil((AI.MATE - Math.abs(score)) / 2);
    } else {
      shown = sign + (Math.abs(score) / 100).toFixed(2);
    }
    el.engineLine.textContent =
      'depth ' + data.depth + '  ·  ' + shown +
      '  ·  ' + (data.nodes || 0).toLocaleString() + ' nodes' +
      '  ·  ' + (data.timeMs || 0) + 'ms';
  }

  function renderMoves() {
    el.moveList.innerHTML = '';
    if (!state.moves.length) {
      var empty = document.createElement('li');
      empty.className = 'moves__empty';
      empty.textContent = 'No moves yet.';
      el.moveList.appendChild(empty);
      return;
    }

    // The first ply is Black's whenever the game began mid-move; with a
    // standard start it is always White's.
    for (var i = 0; i < state.moves.length; i += 2) {
      var row = document.createElement('li');
      row.className = 'moves__row';

      var num = document.createElement('span');
      num.className = 'moves__num';
      num.textContent = (i / 2 + 1) + '.';
      row.appendChild(num);

      for (var j = 0; j < 2; j++) {
        var ply = document.createElement('span');
        ply.className = 'moves__ply';
        if (i + j === state.moves.length - 1) ply.classList.add('moves__ply--latest');
        ply.textContent = state.moves[i + j] ? state.moves[i + j].san : '';
        row.appendChild(ply);
      }
      el.moveList.appendChild(row);
    }
    el.moveList.scrollTop = el.moveList.scrollHeight;
  }

  function renderCaptured() {
    var alive = { w: {}, b: {} };
    'pnbrqk'.split('').forEach(function (t) { alive.w[t] = 0; alive.b[t] = 0; });
    for (var i = 0; i < 64; i++) {
      var p = state.pos.board[i];
      if (p !== null) alive[C.colorOf(p)][C.typeOf(p)]++;
    }

    var lost = { w: [], b: [] };
    var onBoardValue = { w: 0, b: 0 };
    ['w', 'b'].forEach(function (color) {
      'qrbnp'.split('').forEach(function (t) {
        onBoardValue[color] += alive[color][t] * PIECE_VALUE[t];
        // A promotion can leave more of a piece alive than the army started
        // with; the loop simply does not run when `missing` is negative.
        var missing = FULL_ARMY[t] - alive[color][t];
        for (var k = 0; k < missing; k++) {
          lost[color].push(color === 'w' ? t.toUpperCase() : t);
        }
      });
    });

    // Scoring from what is still on the board rather than from what was
    // captured keeps the count right after a promotion.
    var bottom = state.orientation;
    var top = C.opponent(bottom);
    var edge = onBoardValue[bottom] - onBoardValue[top];
    fillCaptured(el.capturedBottom, lost[top], edge);
    fillCaptured(el.capturedTop, lost[bottom], -edge);
  }

  function fillCaptured(container, pieces, advantage) {
    container.innerHTML = '';
    pieces.forEach(function (p) { container.appendChild(pieceSpan(p)); });
    if (advantage > 0) {
      var badge = document.createElement('span');
      badge.className = 'captured__edge';
      badge.textContent = '+' + advantage;
      container.appendChild(badge);
    }
  }

  function renderEvalBar() {
    // The bar fills from the bottom, so it always reflects the advantage of
    // whichever side is sitting at the bottom of the board.
    var bottomScore = state.orientation === C.WHITE ? state.evalScore : -state.evalScore;
    var pct;
    if (Math.abs(bottomScore) > AI.MATE - 100) {
      pct = bottomScore > 0 ? 100 : 0;
    } else {
      pct = 50 + 50 * Math.tanh(bottomScore / 400);
    }
    el.evalbarFill.style.height = pct.toFixed(1) + '%';
    el.evalbar.classList.toggle('evalbar--flip', state.orientation === C.BLACK);
  }

  function renderControls() {
    el.btnUndo.disabled = state.moves.length === 0;
    el.btnHint.disabled = !humanCanMove();
    el.selLevel.value = state.level;
    el.selSide.value = state.humanColor;
  }

  // --- Pointer handling (click-to-move and drag-and-drop) ---------------

  var drag = { active: false, from: -1, ghost: null, startX: 0, startY: 0, moved: false };

  function squareIndexFromPoint(x, y) {
    var target = document.elementFromPoint(x, y);
    if (!target) return -1;
    var square = target.closest ? target.closest('.square') : null;
    return square ? Number(square.dataset.index) : -1;
  }

  function onPointerDown(e) {
    if (!humanCanMove() || e.button !== 0) return;
    var square = e.target.closest('.square');
    if (!square) return;
    var index = Number(square.dataset.index);

    // Completing a move onto a highlighted destination.
    if (state.selected !== -1 && attemptMove(state.selected, index)) return;

    var piece = state.pos.board[index];
    if (piece === null || C.colorOf(piece) !== state.humanColor) {
      state.selected = -1;
      state.targets = [];
      render();
      return;
    }

    selectSquare(index);
    render();

    drag.active = true;
    drag.from = index;
    drag.moved = false;
    drag.startX = e.clientX;
    drag.startY = e.clientY;

    // Capture keeps events flowing if the pointer leaves the board mid-drag.
    // It throws when the pointer is already gone, which is harmless here
    // because pointermove and pointerup are bound to the window anyway.
    try {
      el.board.setPointerCapture(e.pointerId);
    } catch (err) { /* no active pointer; window listeners still cover us */ }
  }

  function onPointerMove(e) {
    if (!drag.active) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;   // ignore jitter

    if (!drag.moved) {
      drag.moved = true;
      var piece = state.pos.board[drag.from];
      if (piece === null) { drag.active = false; return; }

      drag.ghost = pieceSpan(piece);
      drag.ghost.classList.add('drag-piece');
      var squareSize = el.board.getBoundingClientRect().width / 8;
      drag.ghost.style.fontSize = (squareSize * 0.78) + 'px';
      el.dragLayer.hidden = false;
      el.dragLayer.appendChild(drag.ghost);

      var origin = el.board.querySelector('.square[data-index="' + drag.from + '"]');
      if (origin) origin.classList.add('square--dragging');
    }

    drag.ghost.style.left = e.clientX + 'px';
    drag.ghost.style.top = e.clientY + 'px';
  }

  function onPointerUp(e) {
    if (!drag.active) return;
    var wasDrag = drag.moved;
    var from = drag.from;
    clearDrag();

    if (!wasDrag) return;   // a plain click keeps the selection for the next tap

    var to = squareIndexFromPoint(e.clientX, e.clientY);
    if (to === -1 || to === from) { render(); return; }
    if (!attemptMove(from, to)) render();
  }

  function clearDrag() {
    if (drag.ghost && drag.ghost.parentNode) drag.ghost.parentNode.removeChild(drag.ghost);
    el.dragLayer.hidden = true;
    drag.active = false;
    drag.moved = false;
    drag.ghost = null;
    var dragging = el.board.querySelector('.square--dragging');
    if (dragging) dragging.classList.remove('square--dragging');
  }

  // --- Wiring -----------------------------------------------------------

  function init() {
    [
      'board', 'boardVeil', 'status', 'statusText', 'engineLine', 'moveList',
      'capturedTop', 'capturedBottom', 'evalbar', 'evalbarFill', 'dragLayer',
      'promotionModal', 'promotionChoices', 'btnNew', 'btnUndo', 'btnHint',
      'btnFlip', 'selLevel', 'selSide'
    ].forEach(function (id) { el[id] = document.getElementById(id); });

    loadPrefs();
    engine.init();

    el.btnNew.addEventListener('click', newGame);
    el.btnUndo.addEventListener('click', undo);
    el.btnHint.addEventListener('click', showHint);
    el.btnFlip.addEventListener('click', function () {
      state.orientation = C.opponent(state.orientation);
      render();
    });

    // Changing either setting restarts, since both alter how the game is played.
    el.selLevel.addEventListener('change', function () {
      state.level = el.selLevel.value;
      savePrefs();
      newGame();
    });
    el.selSide.addEventListener('change', function () {
      state.humanColor = el.selSide.value === 'b' ? C.BLACK : C.WHITE;
      savePrefs();
      newGame();
    });

    el.board.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', clearDrag);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!el.promotionModal.hidden) return;   // the dialog must be answered
        state.selected = -1;
        state.targets = [];
        state.suggestion = null;
        render();
      }
    });

    newGame();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
