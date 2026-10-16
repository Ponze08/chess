/*
 * online.js — the connection for playing a friend over the internet.
 *
 * The two browsers talk directly over a WebRTC data channel. PeerJS's free
 * public broker is only used to introduce them: the host registers an ID,
 * the ID goes into the invite link, and the guest asks the broker to put it
 * in touch with that ID. From then on every message travels peer to peer.
 *
 * This file only moves messages; ui.js decides what they mean. On top of
 * the raw channel it adds:
 *   - a handshake, so the host keeps playing the same friend. The guest's
 *     first message carries a token that this browser remembers for the
 *     link, and anyone else who opens the link later is turned away;
 *   - a heartbeat, so a vanished peer is noticed within seconds rather than
 *     whenever WebRTC gets round to it;
 *   - reconnection, so a refreshed page or a network blip resumes the game.
 *
 * Messages whose type starts with an underscore belong to this layer and
 * never reach the game.
 */
(function (global) {
  'use strict';

  var ID_PREFIX = 'ponze08-chess-';
  var PEERJS_SRC = 'js/vendor/peerjs.min.js';

  var HEARTBEAT_MS = 3000;     // how often each side pings the other
  var SILENCE_MS = 12000;      // no word for this long means the link is dead
  var RETRY_MS = 3000;         // pause between reconnection attempts
  var DIAL_TIMEOUT_MS = 15000; // give up on a connection attempt after this

  // How long to keep trying before giving up, per situation.
  var FIND_HOST_TRIES = 4;        // first contact: the link may simply be wrong
  var REFIND_HOST_TRIES = 60;     // the friend was here a moment ago: ~3 minutes
  var RECLAIM_ID_TRIES = 15;      // a refreshed host waiting for the broker to free its ID
  var BROKER_TRIES = 4;

  // --- Loading PeerJS ---------------------------------------------------

  // Only fetched when someone actually plays online, so the rest of the
  // game keeps working offline and loads nothing it does not need.
  var loading = null;
  function loadPeerJS(done) {
    if (global.Peer) { done(null); return; }
    if (loading) { loading.push(done); return; }
    loading = [done];
    var script = document.createElement('script');
    script.src = PEERJS_SRC;
    script.onload = function () { finish(global.Peer ? null : new Error('PeerJS failed to start')); };
    script.onerror = function () { finish(new Error('PeerJS could not be downloaded')); };
    document.head.appendChild(script);

    function finish(err) {
      var waiting = loading;
      loading = null;
      if (err) script.parentNode.removeChild(script);
      waiting.forEach(function (cb) { cb(err); });
    }
  }

  function supported() {
    return typeof global.RTCPeerConnection === 'function' && typeof global.WebSocket === 'function';
  }

  // --- Identifiers ------------------------------------------------------

  // Without look-alikes (0/o, 1/l/i), so a link read aloud still works.
  var ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

  // Ten characters from a 31-letter alphabet is about 50 bits: unguessable,
  // and short enough to keep the invite link tidy.
  function randomId(length) {
    var bytes = new Uint8Array(length || 10);
    global.crypto.getRandomValues(bytes);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  function isValidId(id) {
    return typeof id === 'string' && /^[a-z0-9]{6,32}$/.test(id);
  }

  function peerOptions() {
    // The browser tests point this at a local broker. Nothing else sets it,
    // and a link cannot: choosing the broker is not something a URL should
    // be able to do to the person who opens it.
    var opts = { debug: 0 };
    var custom = global.CHESS_PEER_OPTIONS;
    if (custom) Object.keys(custom).forEach(function (k) { opts[k] = custom[k]; });
    return opts;
  }

  // --- Session ----------------------------------------------------------

  // States reported through handlers.state(name, info):
  //   starting    contacting the broker
  //   waiting     host registered; the friend has not arrived yet
  //   connecting  guest is dialling the host
  //   connected   channel open and handshake done
  //   lost        the friend was here but the link dropped; trying to restore it
  //   failed      gave up; info.reason says why (see ui.js for the wording)
  //   ended       the friend left on purpose
  function Session(role, handlers) {
    this.role = role;
    this.handlers = handlers;
    this.peer = null;
    this.conn = null;          // the live, verified connection
    this.dialing = null;       // guest: a connection attempt in progress
    this.state = 'idle';
    this.everConnected = false;
    this.lastHeard = 0;
    this.tries = 0;
    this.brokerTries = 0;
    this.finished = false;
    this.timers = {};
    var self = this;
    this.timers.heartbeat = setInterval(function () { self.heartbeat(); }, HEARTBEAT_MS);
  }

  Session.prototype.setState = function (name, info) {
    if (this.finished) return;
    this.state = name;
    if (this.handlers.state) this.handlers.state(name, info || {});
  };

  Session.prototype.fail = function (reason) {
    if (this.finished) return;
    this.setState('failed', { reason: reason });
    this.teardown();
  };

  Session.prototype.later = function (name, ms, fn) {
    var self = this;
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(function () {
      if (!self.finished) fn.call(self);
    }, ms);
  };

  Session.prototype.teardown = function () {
    this.finished = true;
    clearInterval(this.timers.heartbeat);
    var self = this;
    Object.keys(this.timers).forEach(function (k) { clearTimeout(self.timers[k]); });
    var conn = this.conn, dialing = this.dialing, peer = this.peer;
    this.conn = this.dialing = this.peer = null;
    // Give a just-sent goodbye a moment to leave before the channel closes.
    setTimeout(function () {
      try { if (conn) conn.close(); } catch (e) { /* already gone */ }
      try { if (dialing) dialing.close(); } catch (e) { /* already gone */ }
      try { if (peer) peer.destroy(); } catch (e) { /* already gone */ }
    }, conn ? 250 : 0);
  };

  // Sends a game message. Returns false when there is no live connection.
  Session.prototype.send = function (msg) {
    if (!this.conn || !this.conn.open) return false;
    try {
      this.conn.send(msg);
      return true;
    } catch (err) {
      return false;
    }
  };

  // Leaving on purpose: the friend is told, rather than left waiting for a
  // reconnection that will never come.
  Session.prototype.leave = function () {
    this.send({ t: '_bye' });
    this.finished = true;   // no state callbacks after this point
    this.teardown();
  };

  // Abandons the session without telling the friend, as when a page closes.
  Session.prototype.close = function () {
    this.finished = true;
    this.teardown();
  };

  Session.prototype.createPeer = function (id) {
    var self = this;
    var peer = id ? new global.Peer(ID_PREFIX + id, peerOptions()) : new global.Peer(peerOptions());
    this.peer = peer;

    peer.on('open', function () {
      if (self.peer !== peer || self.finished) return;
      self.brokerTries = 0;
      self.onBrokerOpen();
    });

    peer.on('connection', function (conn) {
      if (self.peer !== peer || self.finished) return;
      self.onIncoming(conn);
    });

    // The broker connection dropped. An established data channel does not
    // need it, but a reconnecting friend does, so get it back.
    peer.on('disconnected', function () {
      if (self.peer !== peer || self.finished || peer.destroyed) return;
      self.later('broker', RETRY_MS, function () {
        if (self.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect();
      });
    });

    peer.on('error', function (err) {
      if (self.peer !== peer || self.finished) return;
      self.onPeerError(err && err.type, peer);
    });
  };

  Session.prototype.onPeerError = function (type, peer) {
    switch (type) {
      case 'browser-incompatible':
        this.fail('unsupported');
        return;

      case 'unavailable-id':
        // A host that just refreshed: the broker still holds the old page's
        // registration and will release it shortly.
        peer.destroy();
        if (++this.tries > RECLAIM_ID_TRIES) { this.fail('taken'); return; }
        this.later('reclaim', RETRY_MS, function () { this.createPeer(this.id); });
        return;

      case 'peer-unavailable':
        // Guest only: nobody is registered under the host's ID right now.
        this.abandonDial();
        var limit = this.everConnected ? REFIND_HOST_TRIES : FIND_HOST_TRIES;
        if (++this.tries >= limit) { this.fail('not-found'); return; }
        this.later('dial', RETRY_MS, this.dial);
        return;

      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed':
        if (!peer.open && !peer.disconnected) {
          // Never got through to the broker at all.
          peer.destroy();
          if (++this.brokerTries > BROKER_TRIES && !this.everConnected) {
            this.fail('unavailable');
            return;
          }
          this.later('restart', RETRY_MS * this.brokerTries, function () {
            this.createPeer(this.role === 'host' ? this.id : null);
          });
        }
        return;

      default:
        // Errors on a single connection surface through its own events.
        return;
    }
  };

  // Wires up a data connection. `onOpen` runs once it can carry messages.
  Session.prototype.watch = function (conn, onOpen) {
    var self = this;
    conn.on('open', function () {
      if (self.finished) return;
      onOpen();
    });
    conn.on('data', function (msg) {
      if (self.finished) return;
      self.onData(conn, msg);
    });
    var gone = function () {
      if (self.finished) return;
      if (conn === self.dialing) self.dialing = null;
      if (conn === self.conn) self.onLost();
    };
    conn.on('close', gone);
    conn.on('error', gone);
  };

  Session.prototype.adopt = function (conn) {
    var old = this.conn;
    this.conn = conn;
    this.lastHeard = Date.now();
    this.tries = 0;
    this.everConnected = true;
    if (old && old !== conn) {
      // The same friend came back on a new connection (a refreshed page or
      // a second tab). The newest one wins; the old one is told to stop.
      try { old.send({ t: '_replaced' }); } catch (e) { /* closing anyway */ }
      setTimeout(function () { try { old.close(); } catch (e) { /* gone */ } }, 250);
    }
    this.setState('connected');
    if (this.handlers.connect) this.handlers.connect();
  };

  Session.prototype.onData = function (conn, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    if (msg.t === '_hello') {
      if (this.role === 'host') this.onHello(conn, msg);
      return;
    }
    if (conn !== this.conn) return;   // stale or not yet verified
    this.lastHeard = Date.now();

    switch (msg.t) {
      case '_ping':
        return;
      case '_full':
        this.fail('full');
        return;
      case '_replaced':
        this.fail('elsewhere');
        return;
      case '_bye':
        this.setState('ended', { reason: 'left' });
        this.teardown();
        return;
      default:
        if (msg.t.charAt(0) === '_') return;
        if (this.handlers.message) this.handlers.message(msg);
    }
  };

  Session.prototype.heartbeat = function () {
    if (!this.conn) return;
    if (Date.now() - this.lastHeard > SILENCE_MS) {
      var dead = this.conn;
      this.onLost();
      try { dead.close(); } catch (e) { /* already gone */ }
      return;
    }
    this.send({ t: '_ping' });
  };

  Session.prototype.onLost = function () {
    this.conn = null;
    if (this.finished) return;
    this.setState('lost');
    if (this.role === 'guest') this.later('dial', RETRY_MS, this.dial);
  };

  // --- Hosting ----------------------------------------------------------

  Session.prototype.startHost = function () {
    this.setState('starting');
    this.createPeer(this.id);
  };

  Session.prototype.onIncoming = function (conn) {
    if (this.role !== 'host') { conn.close(); return; }
    var self = this;
    this.watch(conn, function () { /* wait for the guest's hello */ });
    // A connection that never says hello is dropped.
    setTimeout(function () {
      if (conn !== self.conn && conn.open && !conn.__verified) conn.close();
    }, DIAL_TIMEOUT_MS);
  };

  Session.prototype.onHello = function (conn, msg) {
    var token = typeof msg.token === 'string' ? msg.token : '';
    if (!token) { conn.close(); return; }
    if (!this.token) {
      // The first guest to arrive is the friend for the rest of the session.
      this.token = token;
      if (this.handlers.token) this.handlers.token(token);
    }
    if (token !== this.token) {
      try { conn.send({ t: '_full' }); } catch (e) { /* closing anyway */ }
      setTimeout(function () { conn.close(); }, 250);
      return;
    }
    conn.__verified = true;
    this.adopt(conn);
  };

  Session.prototype.onBrokerOpen = function () {
    if (this.role === 'host') {
      this.tries = 0;
      // A resumed session expects its friend back; a new one is waiting
      // for them to arrive for the first time.
      if (!this.conn) this.setState(this.token ? 'lost' : 'waiting');
    } else if (!this.conn && !this.dialing) {
      this.dial();
    }
  };

  // --- Joining ----------------------------------------------------------

  Session.prototype.startGuest = function () {
    this.setState('connecting');
    this.createPeer(null);
  };

  Session.prototype.dial = function () {
    if (this.conn || !this.peer || this.finished) return;
    if (this.peer.disconnected || !this.peer.open) {
      // Wait for the broker; 'open' calls back here.
      if (this.peer.disconnected && !this.peer.destroyed) this.peer.reconnect();
      return;
    }
    if (!this.everConnected) this.setState('connecting');

    var self = this;
    var conn = this.peer.connect(ID_PREFIX + this.id, { reliable: true, serialization: 'json' });
    this.dialing = conn;
    this.watch(conn, function () {
      if (self.dialing !== conn) { conn.close(); return; }
      self.dialing = null;
      clearTimeout(self.timers.dialTimeout);
      conn.send({ t: '_hello', token: self.token, v: 1 });
      self.adopt(conn);
    });
    this.later('dialTimeout', DIAL_TIMEOUT_MS, function () {
      if (this.dialing !== conn) return;
      this.abandonDial();
      if (++this.tries >= (this.everConnected ? REFIND_HOST_TRIES : FIND_HOST_TRIES)) {
        this.fail('not-found');
        return;
      }
      this.dial();
    });
  };

  Session.prototype.abandonDial = function () {
    clearTimeout(this.timers.dialTimeout);
    var conn = this.dialing;
    this.dialing = null;
    try { if (conn) conn.close(); } catch (e) { /* already gone */ }
  };

  // --- Public API -------------------------------------------------------

  function begin(session, start) {
    if (!supported()) {
      setTimeout(function () { session.fail('unsupported'); }, 0);
      return session;
    }
    session.setState('starting');
    loadPeerJS(function (err) {
      if (session.finished) return;
      if (err) { session.fail('unavailable'); return; }
      try {
        start.call(session);
      } catch (e) {
        session.fail('unavailable');
      }
    });
    return session;
  }

  // Starts hosting. Pass `id` and `token` from an earlier session to resume
  // it after a page refresh; leave them out for a fresh invite.
  function host(opts, handlers) {
    var session = new Session('host', handlers);
    session.id = opts && isValidId(opts.id) ? opts.id : randomId(10);
    session.token = opts && opts.token || null;
    return begin(session, session.startHost);
  }

  // Joins the game hosted under `id`, introducing ourselves with `token`.
  function join(opts, handlers) {
    var session = new Session('guest', handlers);
    session.id = opts.id;
    session.token = opts.token;
    return begin(session, session.startGuest);
  }

  global.ChessOnline = {
    host: host,
    join: join,
    randomId: randomId,
    isValidId: isValidId,
    supported: supported
  };
})(typeof self !== 'undefined' ? self : this);
