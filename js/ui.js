/*
 * ui.js — board rendering, input handling, and the game loop.
 *
 * A game is played against the computer, against a friend on the same
 * device, or against a friend online. Whichever it is, `controller` says who
 * is asked for the next move: the person at this screen, the engine, or the
 * friend at the other end of the connection.
 */
(function () {
  'use strict';

  var C = window.Chess;
  var AI = window.ChessAI;
  var Online = window.ChessOnline;

  // Both colours use the solid glyph set; the fill colour distinguishes them,
  // so the two sides always have identical silhouettes. U+FE0E asks for the
  // text form: the pawn is also an emoji, and phones would otherwise draw it
  // as a picture that ignores the piece colour.
  var GLYPH = {
    k: '♚︎', q: '♛︎', r: '♜︎',
    b: '♝︎', n: '♞︎', p: '♟︎'
  };
  var PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  var CAPTURE_ORDER = 'qrbnp';
  var LEVEL_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };
  var MODE_HINTS = {
    computer: 'Play the engine at the difficulty of your choice.',
    local: 'Two players, one device: take turns at the board.',
    online: 'Send a friend a link and play over the internet.'
  };

  var PREFS_KEY = 'chess.prefs.v1';
  var ONLINE_KEY = 'chess.online.v1';         // sessionStorage: this tab's online game
  var TOKENS_KEY = 'chess.online.tokens.v1';  // localStorage: our token for each invite

  var el = {};
  var state = {
    mode: 'computer',   // 'computer', 'local' or 'online'
    pos: null,
    humanColor: C.WHITE,  // your side against the computer
    level: 'medium',
    autoFlip: false,      // local games: turn the board towards the side to move
    orientation: C.WHITE,
    moves: [],          // { san, move, evalScore }
    keyHistory: [],     // position keys, for threefold repetition
    selected: -1,
    targets: [],        // legal moves from the selected square
    lastMove: null,
    suggestion: null,   // move highlighted by the Hint button
    result: null,
    thinking: null,     // null, or 'move' / 'hint' while the engine works
    evalScore: 0,       // centipawns, always from White's point of view
    generation: 0       // bumped to invalidate in-flight engine replies
  };

  // The online game. The host is the authority: it starts every game and
  // settles any disagreement by sending its whole copy of the game.
  var online = {
    session: null,
    role: null,         // 'host' or 'guest'
    id: null,           // the invite ID, which is also the host's address
    token: null,        // identifies the guest to the host
    status: 'idle',     // transport state, see online.js
    failure: null,      // why the session failed or ended, once it has
    sidePref: C.WHITE,  // lobby choice: 'w', 'b' or 'random'
    myColor: C.WHITE,
    gameId: null,
    started: false,     // a game has been set up with the friend
    end: null,          // a result the board cannot show: resignation or agreed draw
    incoming: null,     // the friend's open offer: 'draw' or 'rematch'
    outgoing: null,     // our open offer
    note: ''            // a passing remark, such as a declined offer
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
      this.spawn();
    },

    spawn: function () {
      var self = this;
      try {
        var worker = new Worker('js/worker.js');
        worker.onmessage = function (e) {
          var cb = self.pending[e.data.id];
          delete self.pending[e.data.id];
          if (!cb) return;
          if (e.data.error) { self.demote(); cb.retry(); return; }
          cb(e.data);
        };
        worker.onerror = function () { self.demote(); };
        this.worker = worker;
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
        if (stranded[id].retry) stranded[id].retry();
      });
    },

    // Abandons any search in flight. A worker cannot be interrupted, so a
    // busy one is replaced; otherwise, after an undo or a new game, the next
    // request would queue behind a stale search for its whole time budget.
    cancel: function () {
      if (!this.worker || !Object.keys(this.pending).length) return;
      this.worker.terminate();
      this.pending = {};
      this.spawn();
    },

    think: function (req, done) {
      var id = ++this.seq;
      var self = this;
      if (this.worker) {
        var cb = function (data) { done(data); };
        cb.retry = function () { self.inline(req, done); };
        this.pending[id] = cb;
        this.worker.postMessage({ id: id, fen: req.fen, level: req.level, history: req.history });
      } else {
        this.inline(req, done);
      }
    },

    // Yield first so the "Thinking…" state paints before the search blocks.
    inline: function (req, done) {
      setTimeout(function () {
        var res = AI.chooseMove(C.parseFEN(req.fen), req.level, req.history);
        done(res ? {
          move: { from: res.move.from, to: res.move.to, promotion: res.move.promotion },
          score: res.score, depth: res.depth, nodes: res.nodes, timeMs: res.timeMs
        } : { move: null });
      }, 30);
    }
  };

  // --- Storage ----------------------------------------------------------

  // Storage can be missing or full (private windows, strict settings); the
  // game must work regardless, so every access is wrapped.
  function readJSON(store, key) {
    try {
      var raw = window[store].getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function writeJSON(store, key, value) {
    try {
      if (value === null) window[store].removeItem(key);
      else window[store].setItem(key, JSON.stringify(value));
    } catch (err) { /* not fatal */ }
  }

  function loadPrefs() {
    var p = readJSON('localStorage', PREFS_KEY);
    if (!p) return;
    if (LEVEL_NAMES[p.level]) state.level = p.level;
    if (p.humanColor === C.WHITE || p.humanColor === C.BLACK) state.humanColor = p.humanColor;
    if (MODE_HINTS[p.mode]) state.mode = p.mode;
    state.autoFlip = p.autoFlip === true;
    if (['w', 'b', 'random'].indexOf(p.onlineSide) !== -1) online.sidePref = p.onlineSide;
  }

  function savePrefs() {
    writeJSON('localStorage', PREFS_KEY, {
      level: state.level,
      humanColor: state.humanColor,
      mode: state.mode,
      autoFlip: state.autoFlip,
      onlineSide: online.sidePref
    });
  }

  // --- Game flow --------------------------------------------------------

  // Who chooses the move for `color`: 'human', 'engine' or 'remote'.
  function controller(color) {
    if (state.mode === 'local') return 'human';
    if (state.mode === 'online') return color === online.myColor ? 'human' : 'remote';
    return color === state.humanColor ? 'human' : 'engine';
  }

  // True while a game is actually under way on the board.
  function gameLive() {
    return state.mode !== 'online' || online.started;
  }

  function humanCanMove() {
    if (state.thinking || state.result || !gameLive()) return false;
    if (state.mode === 'online' && (online.status !== 'connected' || online.failure)) return false;
    return controller(state.pos.turn) === 'human';
  }

  // Clears the board back to the starting position, abandoning anything in
  // progress: engine searches, a pending promotion, a drag.
  function resetBoard() {
    state.generation++;
    engine.cancel();
    hidePromotion();
    clearDrag();
    state.pos = C.parseFEN(C.START_FEN);
    state.moves = [];
    state.keyHistory = [state.pos.key()];
    state.selected = -1;
    state.targets = [];
    state.lastMove = null;
    state.suggestion = null;
    state.result = null;
    state.thinking = null;
    state.evalScore = 0;
    if (el.engineLine) el.engineLine.innerHTML = '&nbsp;';
  }

  function newGame() {
    resetBoard();
    state.orientation = state.mode === 'computer' ? state.humanColor : C.WHITE;
    render();
    if (controller(state.pos.turn) === 'engine') requestEngineMove();
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
    if (state.mode === 'online' && online.end) return online.end;
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

  // Adds a move to the game record without any of the follow-up, so whole
  // games can be replayed quickly.
  function recordMove(move) {
    // SAN must be generated before the move is played.
    var san = C.toSAN(state.pos, move, C.legalMoves(state.pos));
    C.makeMove(state.pos, move);
    state.moves.push({ san: san, move: move, evalScore: state.evalScore });
    state.keyHistory.push(state.pos.key());
    state.lastMove = move;
  }

  // Plays `move` for the side on turn. `origin` says who chose it: 'human',
  // 'engine' or 'remote'.
  function applyMove(move, origin) {
    recordMove(move);
    state.selected = -1;
    state.targets = [];
    state.suggestion = null;
    state.result = detectResult();

    if (state.mode === 'local' && state.autoFlip) state.orientation = state.pos.turn;

    if (state.mode === 'online') {
      // An offer lapses once the player it was made to moves instead.
      if (origin === 'human') {
        if (online.incoming === 'draw') online.incoming = null;
        sendGame({ t: 'move', ply: state.moves.length - 1, uci: C.toUCI(move) });
      } else if (online.outgoing === 'draw') {
        online.outgoing = null;
      }
      online.note = '';
      saveOnline();
    }

    render();
    if (!state.result && controller(state.pos.turn) === 'engine') requestEngineMove();
  }

  // The keys of every position before the current one, so the engine can
  // tell which moves would repeat the game.
  function priorKeys() {
    return state.keyHistory.slice(0, -1);
  }

  function requestEngineMove() {
    state.thinking = 'move';
    render();
    var gen = state.generation;
    var req = { fen: C.toFEN(state.pos), level: state.level, history: priorKeys() };

    engine.think(req, function (data) {
      // A new game or an undo happened while the engine was searching.
      if (gen !== state.generation) return;
      state.thinking = null;

      if (!data || !data.move) { render(); return; }

      var move = C.findMove(state.pos, data.move.from, data.move.to, data.move.promotion);
      if (!move) { render(); return; }

      if (typeof data.score === 'number') {
        // Scores come back from the mover's point of view; store White's.
        state.evalScore = state.pos.turn === C.WHITE ? data.score : -data.score;
      }
      showEngineLine(data);
      applyMove(move, 'engine');
    });
  }

  function canUndo() {
    if (state.mode === 'local') return state.moves.length > 0;
    if (state.mode === 'computer') {
      // There must be a move of yours to take back; playing Black, the
      // computer's opening move alone is not one.
      return state.moves.length > (state.humanColor === C.WHITE ? 0 : 1);
    }
    return false;
  }

  function takeBack() {
    C.unmakeMove(state.pos);
    state.moves.pop();
    state.keyHistory.pop();
  }

  function undo() {
    if (!canUndo()) return;
    state.generation++;          // discard any search still running
    engine.cancel();
    hidePromotion();
    state.thinking = null;

    if (state.mode === 'local') {
      takeBack();
    } else {
      // Step back until it is your turn again, so a full move pair (the
      // computer's reply plus your own move) comes off together.
      do { takeBack(); } while (state.moves.length && state.pos.turn !== state.humanColor);
    }

    var last = state.moves[state.moves.length - 1];
    state.lastMove = last ? last.move : null;
    state.evalScore = last ? last.evalScore : 0;
    state.selected = -1;
    state.targets = [];
    state.suggestion = null;
    state.result = null;
    if (state.mode === 'local' && state.autoFlip) state.orientation = state.pos.turn;
    el.engineLine.innerHTML = '&nbsp;';
    render();

    if (controller(state.pos.turn) === 'engine') requestEngineMove();
  }

  function showHint() {
    if (state.mode === 'online' || !humanCanMove()) return;
    state.thinking = 'hint';
    render();
    var gen = state.generation;
    var req = { fen: C.toFEN(state.pos), level: 'hint', history: priorKeys() };
    engine.think(req, function (data) {
      if (gen !== state.generation) return;
      state.thinking = null;
      if (data && data.move) {
        state.suggestion = { from: data.move.from, to: data.move.to };
      }
      render();
    });
  }

  function setMode(mode) {
    if (mode === state.mode || !MODE_HINTS[mode]) return;
    if (state.mode === 'online') {
      if (onlineGameInProgress() &&
          !window.confirm('Leave the online game? Your friend will be told you left.')) {
        render();   // puts the mode switch back
        return;
      }
      leaveOnline();
    }
    state.mode = mode;
    savePrefs();
    if (mode === 'online') {
      enterLobby();
    } else {
      newGame();
    }
  }

  // --- Online play ------------------------------------------------------

  function onlineGameInProgress() {
    return !!online.session && online.started && !state.result;
  }

  function ucis() {
    return state.moves.map(function (m) { return C.toUCI(m.move); });
  }

  function inviteLink(id) {
    return window.location.href.split('#')[0] + '#play=' + id;
  }

  function inviteFromHash() {
    var m = /^#play=([a-z0-9]+)$/.exec(window.location.hash);
    return m && Online.isValidId(m[1]) ? m[1] : null;
  }

  function clearInviteHash() {
    if (!window.location.hash) return;
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (err) {
      window.location.hash = '';
    }
  }

  // This browser's token for an invite. Kept in localStorage, so a friend
  // who closes the tab and opens the link again is recognised as the same
  // player rather than turned away as a stranger.
  function guestToken(id) {
    var tokens = readJSON('localStorage', TOKENS_KEY) || {};
    if (!tokens[id]) {
      tokens[id] = Online.randomId(16);
      var ids = Object.keys(tokens);
      if (ids.length > 20) delete tokens[ids[0]];   // only recent invites matter
      writeJSON('localStorage', TOKENS_KEY, tokens);
    }
    return tokens[id];
  }

  // Remembers the game for this tab, so a refresh picks it up again.
  function saveOnline() {
    if (!online.role) return;
    writeJSON('sessionStorage', ONLINE_KEY, {
      role: online.role,
      id: online.id,
      token: online.role === 'host' ? online.token : null,
      myColor: online.myColor,
      gameId: online.gameId,
      started: online.started,
      end: online.end,
      moves: ucis()
    });
  }

  function loadSavedOnline() {
    var s = readJSON('sessionStorage', ONLINE_KEY);
    if (!s || (s.role !== 'host' && s.role !== 'guest') || !Online.isValidId(s.id)) return null;
    if (s.myColor !== C.WHITE && s.myColor !== C.BLACK) return null;
    if (!Array.isArray(s.moves)) return null;
    return s;
  }

  function validEnd(end) {
    if (!end || typeof end !== 'object') return null;
    if (end.kind === 'agreement') return { kind: 'agreement' };
    if (end.kind === 'resign' && (end.winner === C.WHITE || end.winner === C.BLACK)) {
      return { kind: 'resign', winner: end.winner };
    }
    return null;
  }

  // Replaces the game with the one described by `moves` (UCI strings).
  // Returns false, leaving the board at the start, if any move is illegal.
  function loadMoves(moves) {
    resetBoard();
    for (var i = 0; i < moves.length; i++) {
      var move = C.fromUCI(state.pos, moves[i]);
      if (!move) { resetBoard(); return false; }
      recordMove(move);
    }
    state.result = detectResult();
    return true;
  }

  function resetOnline() {
    online.session = null;
    online.role = null;
    online.id = null;
    online.token = null;
    online.status = 'idle';
    online.failure = null;
    online.gameId = null;
    online.started = false;
    online.end = null;
    online.incoming = null;
    online.outgoing = null;
    online.note = '';
  }

  // Ends any online session, telling the friend, and forgets the game.
  function leaveOnline(keepHash) {
    if (online.session) online.session.leave();
    resetOnline();
    writeJSON('sessionStorage', ONLINE_KEY, null);
    if (!keepHash) clearInviteHash();
  }

  function enterLobby() {
    resetBoard();
    state.orientation = online.sidePref === C.BLACK ? C.BLACK : C.WHITE;
    render();
  }

  // Callbacks for a session. Each set is tied to its own session, so a late
  // event from one that has since been replaced is ignored.
  function sessionHandlers() {
    var handlers = {
      owner: null,
      state: function (name, info) {
        if (handlers.owner && online.session !== handlers.owner) return;
        onSessionState(name, info);
      },
      connect: function () {
        if (handlers.owner && online.session !== handlers.owner) return;
        onSessionConnect();
      },
      message: function (msg) {
        if (handlers.owner && online.session !== handlers.owner) return;
        onSessionMessage(msg);
      },
      token: function (token) {
        if (handlers.owner && online.session !== handlers.owner) return;
        online.token = token;
        saveOnline();
      }
    };
    return handlers;
  }

  function startSession(kind, opts) {
    var handlers = sessionHandlers();
    online.session = Online[kind](opts, handlers);
    handlers.owner = online.session;
    return online.session;
  }

  function createInvite() {
    leaveOnline();
    online.role = 'host';
    online.myColor = online.sidePref === 'random'
      ? (Math.random() < 0.5 ? C.WHITE : C.BLACK)
      : online.sidePref;
    resetBoard();
    state.orientation = online.myColor;
    online.id = startSession('host', {}).id;
    saveOnline();
    render();
  }

  // Picks up a game this tab was hosting before a refresh.
  function resumeHost(saved) {
    resetOnline();
    online.role = 'host';
    online.id = saved.id;
    online.token = saved.token || null;
    online.myColor = saved.myColor;
    online.gameId = saved.gameId || null;
    online.started = !!saved.started && !!saved.gameId;
    online.end = validEnd(saved.end);
    if (!loadMoves(saved.moves)) online.started = false;
    state.orientation = online.myColor;
    startSession('host', { id: saved.id, token: online.token });
  }

  function joinInvite(id, saved) {
    resetOnline();
    online.role = 'guest';
    online.id = id;
    online.token = guestToken(id);
    resetBoard();
    if (saved && saved.gameId) {
      // Show the game as it stood; the host confirms it once connected.
      online.myColor = saved.myColor;
      online.gameId = saved.gameId;
      online.end = validEnd(saved.end);
      online.started = loadMoves(saved.moves);
    }
    state.orientation = online.myColor;
    startSession('join', { id: id, token: online.token });
    saveOnline();
  }

  function retryOnline() {
    if (online.role === 'guest' && online.id) {
      var id = online.id;
      joinInvite(id, loadSavedOnline());
    } else {
      createInvite();
    }
    render();
  }

  function onSessionState(name, info) {
    online.status = name;
    if (name === 'failed' || name === 'ended') {
      online.failure = name === 'ended' ? 'left' : info.reason;
      online.session = null;
      online.incoming = null;
      online.outgoing = null;
      hidePromotion();
      writeJSON('sessionStorage', ONLINE_KEY, null);
    }
    render();
  }

  function onSessionConnect() {
    // The guest reports what it has; the host answers with the game.
    if (online.role === 'guest') sendGame({ t: 'join', moves: ucis() });
  }

  function sendGame(msg) {
    if (!online.session) return false;
    msg.gameId = online.gameId;
    return online.session.send(msg);
  }

  function sendState() {
    sendGame({
      t: 'state',
      you: C.opponent(online.myColor),
      moves: ucis(),
      end: online.end
    });
  }

  function onSessionMessage(msg) {
    if (msg.t === 'join') { if (online.role === 'host') onJoin(msg); return; }
    if (msg.t === 'state') { if (online.role === 'guest') onState(msg); return; }
    // Everything else concerns one particular game.
    if (!online.started || msg.gameId !== online.gameId) return;
    if (msg.t === 'move') onRemoteMove(msg);
    else if (msg.t === 'resign') onRemoteResign();
    else if (msg.t === 'draw') onRemoteDraw(msg.action);
    else if (msg.t === 'rematch') onRemoteRematch(msg.action);
  }

  // Host: the friend has (re)connected and said which moves it has seen.
  function onJoin(msg) {
    if (!online.started) {
      startOnlineGame(online.myColor);
      return;
    }
    // The friend may hold one move of its own that never reached us,
    // played just as the connection dropped. Accept it if it fits.
    var theirs = Array.isArray(msg.moves) ? msg.moves : [];
    var ours = ucis();
    if (msg.gameId === online.gameId && !state.result &&
        theirs.length === ours.length + 1 &&
        controller(state.pos.turn) === 'remote' &&
        ours.every(function (u, i) { return theirs[i] === u; })) {
      var move = C.fromUCI(state.pos, theirs[theirs.length - 1]);
      if (move) applyMove(move, 'remote');
    }
    sendState();
  }

  // Guest: the host's copy of the game, which replaces ours.
  function onState(msg) {
    if (typeof msg.gameId !== 'string' || !Array.isArray(msg.moves)) return;
    if (msg.you !== C.WHITE && msg.you !== C.BLACK) return;
    var isNewGame = msg.gameId !== online.gameId;
    online.gameId = msg.gameId;
    online.myColor = msg.you;
    online.end = validEnd(msg.end);
    online.started = true;
    online.incoming = null;
    online.outgoing = null;
    online.note = '';
    var orientation = state.orientation;
    loadMoves(msg.moves);
    // A new game faces you; a resynchronised one keeps any flip you made.
    state.orientation = isNewGame ? online.myColor : orientation;
    saveOnline();
    render();
  }

  // Host: a fresh game, sent to the friend.
  function startOnlineGame(hostColor) {
    resetBoard();
    online.gameId = Online.randomId(8);
    online.myColor = hostColor;
    online.started = true;
    online.end = null;
    online.incoming = null;
    online.outgoing = null;
    online.note = '';
    state.orientation = hostColor;
    saveOnline();
    sendState();
    render();
  }

  // When the two copies of the game disagree, the host's copy wins.
  function resync() {
    if (online.role === 'host') sendState();
    else sendGame({ t: 'join', moves: ucis() });
  }

  function onRemoteMove(msg) {
    var fits = !state.result && msg.ply === state.moves.length &&
      controller(state.pos.turn) === 'remote';
    var move = fits ? C.fromUCI(state.pos, msg.uci) : null;
    if (!move) { resync(); return; }
    applyMove(move, 'remote');
  }

  // Ends the online game with a result the board cannot show for itself.
  function concludeOnline(end) {
    online.end = end;
    online.incoming = null;
    online.outgoing = null;
    online.note = '';
    hidePromotion();
    state.selected = -1;
    state.targets = [];
    state.result = detectResult();
    saveOnline();
    render();
  }

  function onRemoteResign() {
    if (state.result) return;
    concludeOnline({ kind: 'resign', winner: online.myColor });
  }

  function onRemoteDraw(action) {
    if (state.result) return;
    if (action === 'offer') {
      if (online.outgoing === 'draw') {
        // Both offered at once: that is an agreement.
        sendGame({ t: 'draw', action: 'accept' });
        concludeOnline({ kind: 'agreement' });
        return;
      }
      online.incoming = 'draw';
      online.note = '';
    } else if (action === 'accept' && online.outgoing === 'draw') {
      concludeOnline({ kind: 'agreement' });
      return;
    } else if (action === 'decline' && online.outgoing === 'draw') {
      online.outgoing = null;
      online.note = 'Your friend declined the draw.';
    }
    render();
  }

  function onRemoteRematch(action) {
    if (!state.result) return;
    if (action === 'offer') {
      if (online.outgoing === 'rematch') {
        acceptRematch();
        return;
      }
      online.incoming = 'rematch';
      online.note = '';
    } else if (action === 'accept' && online.outgoing === 'rematch') {
      // Only the host starts games; the guest waits for the new state.
      if (online.role === 'host') startOnlineGame(C.opponent(online.myColor));
      return;
    } else if (action === 'decline' && online.outgoing === 'rematch') {
      online.outgoing = null;
      online.note = 'Your friend declined a rematch.';
    }
    render();
  }

  function acceptRematch() {
    online.incoming = null;
    if (online.role === 'host') {
      startOnlineGame(C.opponent(online.myColor));   // colours swap each game
    } else {
      sendGame({ t: 'rematch', action: 'accept' });
      online.note = 'Starting the rematch…';
      render();
    }
  }

  function canActOnline() {
    return state.mode === 'online' && online.started && !online.failure &&
      online.status === 'connected';
  }

  function resign() {
    if (!canActOnline() || state.result) return;
    if (!window.confirm('Resign this game?')) return;
    sendGame({ t: 'resign' });
    concludeOnline({ kind: 'resign', winner: C.opponent(online.myColor) });
  }

  function offerDraw() {
    if (!canActOnline() || state.result || online.outgoing === 'draw') return;
    if (online.incoming === 'draw') { acceptOffer(); return; }
    online.outgoing = 'draw';
    online.note = '';
    sendGame({ t: 'draw', action: 'offer' });
    render();
  }

  function offerRematch() {
    if (!canActOnline() || !state.result || online.outgoing === 'rematch') return;
    if (online.incoming === 'rematch') { acceptRematch(); return; }
    online.outgoing = 'rematch';
    online.note = '';
    sendGame({ t: 'rematch', action: 'offer' });
    render();
  }

  function acceptOffer() {
    if (!canActOnline()) return;
    if (online.incoming === 'draw' && !state.result) {
      sendGame({ t: 'draw', action: 'accept' });
      concludeOnline({ kind: 'agreement' });
    } else if (online.incoming === 'rematch' && state.result) {
      acceptRematch();
    }
  }

  function declineOffer() {
    var kind = online.incoming;
    if (!kind) return;
    online.incoming = null;
    sendGame({ t: kind, action: 'decline' });
    render();
  }

  function leaveButton() {
    if (onlineGameInProgress() && !online.failure &&
        !window.confirm('Leave this game? Your friend will be told you left.')) return;
    leaveOnline();
    enterLobby();
  }

  function copyInvite() {
    var link = el.inviteLink.value;
    var done = function () {
      el.btnCopy.textContent = 'Copied!';
      setTimeout(function () { el.btnCopy.textContent = 'Copy'; }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(done, function () { selectInvite(); });
    } else {
      selectInvite();
      try { if (document.execCommand('copy')) done(); } catch (err) { /* selected for manual copy */ }
    }
  }

  function selectInvite() {
    el.inviteLink.focus();
    el.inviteLink.select();
  }

  function shareInvite() {
    if (!navigator.share) return;
    navigator.share({
      title: 'Play chess with me',
      text: 'Join my chess game:',
      url: el.inviteLink.value
    }).catch(function () { /* dismissed */ });
  }

  // Opening an invite link while the page is already open only changes the
  // hash, which does not reload the page.
  function onHashChange() {
    var id = inviteFromHash();
    if (!id || (online.session && online.id === id)) return;
    if (onlineGameInProgress() &&
        !window.confirm('Leave your current game to join this one?')) return;
    leaveOnline(true);
    state.mode = 'online';
    savePrefs();
    joinInvite(id, null);
    render();
  }

  // --- Human input ------------------------------------------------------

  function selectSquare(index) {
    var piece = state.pos.board[index];
    if (piece === null || C.colorOf(piece) !== state.pos.turn) {
      state.selected = -1;
      state.targets = [];
      return;
    }
    state.selected = index;
    state.targets = C.movesFrom(state.pos, index);
  }

  // Returns true when the click/drop consumed the interaction.
  function attemptMove(from, to) {
    // The game can change under a pending click or drag: the friend may
    // resign, or the host may resend the game.
    if (!humanCanMove()) return false;
    var candidates = state.targets.filter(function (m) {
      return m.from === from && m.to === to;
    });
    if (!candidates.length) return false;

    if (candidates.length > 1 && candidates[0].promotion) {
      askPromotion(candidates);
      return true;
    }
    applyMove(candidates[0], 'human');
    return true;
  }

  function askPromotion(candidates) {
    el.promotionChoices.innerHTML = '';
    // Present them queen-first, which is what players want nearly always.
    var order = ['q', 'r', 'b', 'n'];
    var gen = state.generation;
    order.forEach(function (t) {
      var move = candidates.filter(function (m) {
        return C.typeOf(m.promotion) === t;
      })[0];
      if (!move) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'promo-btn';
      btn.title = { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t];
      btn.setAttribute('aria-label', btn.title);
      btn.appendChild(pieceSpan(move.promotion));
      btn.addEventListener('click', function () {
        hidePromotion();
        if (gen === state.generation && humanCanMove()) applyMove(move, 'human');
        else render();
      });
      el.promotionChoices.appendChild(btn);
    });
    el.promotionModal.hidden = false;
    var first = el.promotionChoices.querySelector('button');
    if (first) first.focus();
  }

  function hidePromotion() {
    if (!el.promotionModal) return;
    el.promotionModal.hidden = true;
    el.promotionChoices.innerHTML = '';
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
    renderMode();
    renderBoard();
    renderStatus();
    renderMoves();
    renderPlayers();
    renderEvalBar();
    renderControls();
    renderOnline();
  }

  function renderMode() {
    var nodes = document.querySelectorAll('[data-modes]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].hidden = nodes[i].getAttribute('data-modes').split(' ').indexOf(state.mode) === -1;
    }
    el.modeInputs.forEach(function (input) { input.checked = input.value === state.mode; });
    el.modeHint.textContent = MODE_HINTS[state.mode];
    el.evalbar.hidden = state.mode !== 'computer';
  }

  function renderBoard() {
    var pos = state.pos;
    var frag = document.createDocumentFragment();
    var checkedKing = -1;
    if (C.inCheck(pos, pos.turn)) checkedKing = pos.kings[pos.turn];
    var canMove = humanCanMove();

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
      } else if (piece !== null && C.colorOf(piece) === pos.turn && canMove) {
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
    el.boardVeil.hidden = canMove;
    el.boardVeil.classList.toggle('board-veil--busy', !!state.thinking);
  }

  function sideName(color) {
    return color === C.WHITE ? 'White' : 'Black';
  }

  function winsText(color) {
    if (state.mode === 'local') return sideName(color) + ' wins.';
    if (state.mode === 'online') return color === online.myColor ? 'you win!' : 'your friend wins.';
    return color === state.humanColor ? 'you win!' : 'the computer wins.';
  }

  function resultText(r) {
    switch (r.kind) {
      case 'checkmate':
        return 'Checkmate — ' + winsText(r.winner);
      case 'resign':
        if (state.mode === 'online') {
          return r.winner === online.myColor ? 'Your friend resigned — you win!' : 'You resigned.';
        }
        return sideName(C.opponent(r.winner)) + ' resigned — ' + winsText(r.winner);
      case 'agreement':
        return 'Draw agreed.';
      case 'stalemate':
        return 'Stalemate — draw.';
      case 'fifty':
        return 'Draw by the fifty-move rule.';
      case 'material':
        return 'Draw — insufficient material.';
      default:
        return 'Draw by threefold repetition.';
    }
  }

  function failureText(reason) {
    switch (reason) {
      case 'left':
        return 'Your friend left the game.';
      case 'unsupported':
        return 'This browser cannot play online. Try a current Chrome, Firefox, Safari or Edge.';
      case 'unavailable':
        return 'Could not reach the matchmaking server. Check your connection and try again.';
      case 'not-found':
        return online.started
          ? 'Lost touch with your friend.'
          : 'Could not find that game. The link may be old, or your friend closed the page.';
      case 'full':
        return 'That game already has two players.';
      case 'taken':
        return 'Could not reopen your game. Create a new invite.';
      case 'elsewhere':
        return 'This game was opened in another tab or window.';
      default:
        return 'The connection failed.';
    }
  }

  function lobbyText() {
    switch (online.status) {
      case 'starting':
        return online.role === 'host' ? 'Creating your game…' : 'Connecting to your friend…';
      case 'waiting':
        return 'Waiting for your friend to open the link…';
      case 'connecting':
      case 'connected':
        return 'Connecting to your friend…';
      case 'lost':
        return online.role === 'host'
          ? 'Waiting for your friend to open the link…'
          : 'Connecting to your friend…';
      default:
        return 'Invite a friend to a game.';
    }
  }

  function turnText() {
    var yours = controller(state.pos.turn) === 'human';
    if (state.mode === 'local') return sideName(state.pos.turn) + ' to move';
    if (state.mode === 'online') return yours ? 'Your move' : 'Your friend’s move';
    return yours ? 'Your move' : 'Computer to move';
  }

  function renderStatus() {
    var cls = 'status';
    var text;
    var isOnline = state.mode === 'online';

    if (isOnline && online.failure) {
      cls += ' status--over';
      text = failureText(online.failure);
      if (state.result) text = resultText(state.result) + ' ' + text;
    } else if (state.result) {
      cls += ' status--over';
      text = resultText(state.result);
    } else if (isOnline && !online.started) {
      cls += online.session ? ' status--thinking' : '';
      text = lobbyText();
    } else if (isOnline && online.status !== 'connected') {
      cls += ' status--thinking';
      text = online.role === 'host'
        ? 'Your friend lost connection — waiting for them to come back…'
        : 'Connection lost — reconnecting…';
    } else if (state.thinking) {
      cls += ' status--thinking';
      text = state.thinking === 'hint' ? 'Looking for a good move…' : 'Computer is thinking…';
    } else {
      var checked = C.inCheck(state.pos, state.pos.turn);
      if (checked) cls += ' status--check';
      text = turnText() + (checked ? ' — check!' : '.');
    }

    el.status.className = cls;
    el.statusText.textContent = text;
  }

  function showEngineLine(data) {
    if (typeof data.depth !== 'number') { el.engineLine.innerHTML = '&nbsp;'; return; }
    if (data.depth === 0) { el.engineLine.textContent = 'only one legal move'; return; }
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

    // Games always begin from the standard position, so the first ply of
    // each row is White's.
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

  function playerName(color) {
    if (state.mode === 'local') return sideName(color);
    if (state.mode === 'online') return color === online.myColor ? 'You' : 'Friend';
    return color === state.humanColor ? 'You' : 'Computer · ' + LEVEL_NAMES[state.level];
  }

  function renderPlayers() {
    // Captures come from the game record rather than from counting what is
    // left on the board, which would mistake a promoted pawn for a lost one.
    var lost = { w: [], b: [] };
    state.moves.forEach(function (entry) {
      var cap = entry.move.captured;
      if (cap) lost[C.colorOf(cap)].push(cap);
    });
    ['w', 'b'].forEach(function (color) {
      lost[color].sort(function (a, b) {
        return CAPTURE_ORDER.indexOf(C.typeOf(a)) - CAPTURE_ORDER.indexOf(C.typeOf(b));
      });
    });

    // The material edge, though, is what is on the board now.
    var material = { w: 0, b: 0 };
    for (var i = 0; i < 64; i++) {
      var p = state.pos.board[i];
      if (p !== null) material[C.colorOf(p)] += PIECE_VALUE[C.typeOf(p)];
    }

    var bottom = state.orientation;
    var top = C.opponent(bottom);
    var edge = material[bottom] - material[top];
    fillPlayer('Bottom', bottom, lost[top], edge);
    fillPlayer('Top', top, lost[bottom], -edge);
  }

  function fillPlayer(where, color, captured, advantage) {
    el['name' + where].textContent = playerName(color);
    el['swatch' + where].className = 'player__swatch player__swatch--' + color;
    el['player' + where].classList.toggle('player--turn',
      !state.result && gameLive() && state.pos.turn === color);

    var container = el['captured' + where];
    container.innerHTML = '';
    captured.forEach(function (p) { container.appendChild(pieceSpan(p)); });
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
    el.btnUndo.disabled = !canUndo();
    el.btnHint.disabled = !humanCanMove();
    el.selLevel.value = state.level;
    el.selSide.value = state.humanColor;
    el.chkAutoFlip.checked = state.autoFlip;
    el.selOnlineSide.value = online.sidePref;

    if (state.mode !== 'online') {
      el.controls.hidden = false;
      return;
    }

    // Online: the game controls appear once there is a game.
    el.controls.hidden = !online.started;
    var over = !!state.result;
    var active = canActOnline();
    el.btnDraw.hidden = over || !!online.failure;
    el.btnResign.hidden = over || !!online.failure;
    el.btnRematch.hidden = !over || !!online.failure;
    el.btnDraw.disabled = !active || online.outgoing === 'draw';
    el.btnDraw.textContent = online.outgoing === 'draw' ? 'Draw offered' : 'Offer draw';
    el.btnResign.disabled = !active;
    el.btnRematch.disabled = !active || online.outgoing === 'rematch';
    el.btnRematch.textContent = online.outgoing === 'rematch' ? 'Rematch offered' : 'Rematch';
    el.btnLeave.textContent = online.failure ? 'New invite' : 'Leave';
  }

  function renderOnline() {
    var on = state.mode === 'online';
    el.lobby.hidden = !on || online.started;

    if (on && !online.started) {
      var hosting = online.role === 'host' && !!online.session;
      el.lobbyStart.hidden = !!online.session || !!online.failure;
      el.invitePanel.hidden = !hosting;
      if (hosting && el.inviteLink.value !== inviteLink(online.id)) {
        el.inviteLink.value = inviteLink(online.id);
      }
      el.btnShare.hidden = !navigator.share;
      el.lobbyRetry.hidden = !online.failure;
      // Some failures cannot be fixed by trying the same thing again.
      el.btnRetry.hidden = online.failure === 'full' || online.failure === 'elsewhere' ||
        online.failure === 'unsupported';
      el.btnRetry.textContent = online.role === 'guest' ? 'Try again' : 'Create a new invite';
      el.btnBackToLobby.hidden = online.role !== 'guest';
    }

    var text = '';
    var actions = false;
    if (on && online.started && !online.failure) {
      if (online.incoming === 'draw' && !state.result) {
        text = 'Your friend offers a draw.';
        actions = true;
      } else if (online.incoming === 'rematch' && state.result) {
        text = 'Your friend wants a rematch. You would swap colours.';
        actions = true;
      } else if (online.outgoing === 'rematch' && state.result) {
        text = 'Rematch offered. Waiting for your friend…';
      } else if (online.note) {
        text = online.note;
      }
    }
    el.offer.hidden = !text;
    el.offerText.textContent = text;
    el.offerActions.hidden = !actions;
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
    if (piece === null || C.colorOf(piece) !== state.pos.turn) {
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
    if (el.dragLayer) el.dragLayer.hidden = true;
    drag.active = false;
    drag.moved = false;
    drag.ghost = null;
    var dragging = el.board ? el.board.querySelector('.square--dragging') : null;
    if (dragging) dragging.classList.remove('square--dragging');
  }

  // --- Wiring -----------------------------------------------------------

  function init() {
    [
      'board', 'boardVeil', 'status', 'statusText', 'engineLine', 'moveList',
      'playerTop', 'playerBottom', 'nameTop', 'nameBottom', 'swatchTop', 'swatchBottom',
      'capturedTop', 'capturedBottom', 'evalbar', 'evalbarFill', 'dragLayer',
      'promotionModal', 'promotionChoices', 'controls', 'btnNew', 'btnUndo', 'btnHint',
      'btnFlip', 'btnDraw', 'btnResign', 'btnRematch', 'btnLeave', 'selLevel', 'selSide',
      'chkAutoFlip', 'modeHint', 'lobby', 'lobbyStart', 'selOnlineSide', 'btnInvite',
      'invitePanel', 'inviteLink', 'btnCopy', 'btnShare', 'btnCancelInvite', 'lobbyRetry',
      'btnRetry', 'btnBackToLobby', 'offer', 'offerText', 'offerActions', 'btnAccept',
      'btnDecline'
    ].forEach(function (id) { el[id] = document.getElementById(id); });
    el.modeInputs = Array.prototype.slice.call(document.querySelectorAll('input[name="mode"]'));

    loadPrefs();
    engine.init();

    el.modeInputs.forEach(function (input) {
      input.addEventListener('change', function () {
        if (input.checked) setMode(input.value);
      });
    });

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
    el.chkAutoFlip.addEventListener('change', function () {
      state.autoFlip = el.chkAutoFlip.checked;
      savePrefs();
      if (state.autoFlip) state.orientation = state.pos.turn;
      render();
    });

    el.selOnlineSide.addEventListener('change', function () {
      online.sidePref = el.selOnlineSide.value;
      savePrefs();
      if (!online.session) {
        state.orientation = online.sidePref === C.BLACK ? C.BLACK : C.WHITE;
        render();
      }
    });
    el.btnInvite.addEventListener('click', createInvite);
    el.btnCopy.addEventListener('click', copyInvite);
    el.btnShare.addEventListener('click', shareInvite);
    el.inviteLink.addEventListener('focus', selectInvite);
    el.btnCancelInvite.addEventListener('click', function () { leaveOnline(); enterLobby(); });
    el.btnRetry.addEventListener('click', retryOnline);
    el.btnBackToLobby.addEventListener('click', function () { leaveOnline(); enterLobby(); });
    el.btnDraw.addEventListener('click', offerDraw);
    el.btnResign.addEventListener('click', resign);
    el.btnRematch.addEventListener('click', offerRematch);
    el.btnLeave.addEventListener('click', leaveButton);
    el.btnAccept.addEventListener('click', acceptOffer);
    el.btnDecline.addEventListener('click', declineOffer);

    el.board.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', clearDrag);

    // Clicking outside the promotion choices backs out of the move.
    el.promotionModal.addEventListener('click', function (e) {
      if (e.target === el.promotionModal) { hidePromotion(); render(); }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el.promotionModal.hidden) { hidePromotion(); render(); return; }
      state.selected = -1;
      state.targets = [];
      state.suggestion = null;
      render();
    });

    window.addEventListener('hashchange', onHashChange);
    // Release the broker registration promptly, so a refreshed host can
    // claim its invite ID again without waiting for it to time out.
    window.addEventListener('pagehide', function (e) {
      if (online.session && !e.persisted) online.session.close();
    });

    startUp();
  }

  // Decides what the page opens on: an invite link, a game this tab was
  // already playing online, or the last mode used.
  function startUp() {
    var invite = inviteFromHash();
    var saved = loadSavedOnline();

    if (invite) {
      state.mode = 'online';
      savePrefs();
      if (saved && saved.role === 'host' && saved.id === invite) resumeHost(saved);
      else joinInvite(invite, saved && saved.role === 'guest' && saved.id === invite ? saved : null);
      render();
    } else if (saved && saved.role === 'host') {
      state.mode = 'online';
      resumeHost(saved);
      render();
    } else if (state.mode === 'online') {
      writeJSON('sessionStorage', ONLINE_KEY, null);
      enterLobby();
    } else {
      newGame();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
