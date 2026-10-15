# Chess

Play chess in your browser against the computer, against a friend on the
same device, or against a friend online. No build step, no sign-up, no server
of its own — it is plain HTML, CSS and JavaScript.

**▶ [Play it here](https://ponze08.github.io/chess/)**

## Running it locally

Clone the repository and open `index.html` in a browser. That is the whole
setup.

Serving it over HTTP is slightly better, because the engine then runs in a Web
Worker and the board stays responsive while the computer thinks:

```bash
npm start
```

Opened straight from disk the game still works — browsers block workers on
`file://` URLs, so the search falls back to the main thread instead.

## Playing

Pick an opponent at the top of the panel:

- **Computer** — play the engine. **Undo** takes back your move and the
  computer's reply together, **Hint** shows the move the engine would play,
  and changing the difficulty or your colour starts a new game. The bar
  beside the board is the engine's evaluation, and it always fills from the
  bottom for whichever side is at the bottom.
- **Friend** — two players on one device. **Undo** takes back one move.
  Tick *Turn the board for whoever is to move* to have the board face each
  player in turn.
- **Online** — play a friend over the internet. Choose your colour, press
  **Create invite link** and send the link; the game starts when your friend
  opens it. You can offer a draw, resign, and ask for a rematch (colours swap
  each game).

Click a piece and then its destination, or drag it. Legal destinations
appear as dots; a ring means a capture.

All the rules are implemented: castling, en passant, underpromotion,
stalemate, the fifty-move rule, threefold repetition and draws by insufficient
material.

## Online play

The two browsers talk to each other directly over a WebRTC data channel, so
moves never pass through a game server. To find each other they use the free
public [PeerJS](https://peerjs.com/) broker: the host registers a random ID,
that ID is the `#play=…` part of the invite link, and the broker introduces
the friend who opens it. When a direct connection is impossible (some
corporate or mobile networks), PeerJS's public TURN relay carries the
traffic instead. The PeerJS client is vendored in `js/vendor/` and only
loaded once you create or open an invite.

The host's browser is the referee: it starts each game and, if the two
copies ever disagree, its copy wins. Either player can refresh the page or
drop off the network briefly and the game resumes where it was. The first
person to open an invite link becomes the opponent for that link; anyone who
opens it later is told the game already has two players.

## Difficulty

| Level  | Search depth | Time budget | Notes |
| ------ | ------------ | ----------- | ----- |
| Easy   | 2 ply        | 0.4s        | Plays randomly among near-equal moves |
| Medium | 3 ply        | 0.9s        | Slight randomness, so games differ |
| Hard   | 5 ply        | 2.0s        | Deterministic, plays the move it thinks is best |
| Expert | 8 ply        | 4.5s        | Deterministic, searches as deep as the clock allows |

Depth is a ceiling rather than a promise: the search deepens one ply at a time
and stops when it runs out of time, so it uses whatever your machine allows.
The engine also searches further along any line that gives check, so it does
not miss mates sitting just past its horizon.

## How the engine works

`js/engine.js` holds the rules. The board is a flat 64-entry array where index
0 is a8, and moves are made and unmade in place with an undo stack rather than
by copying the position, which keeps the search cheap. A Zobrist hash is
maintained incrementally for the transposition table and for detecting
repetitions.

`js/ai.js` is the search: negamax with alpha-beta pruning, iterative
deepening, a transposition table, and a quiescence search that follows
captures (and every reply to a check) to the end so the engine is not fooled
by an exchange cut off half-way. The search is given the game's earlier
positions, so it avoids repetition draws when it is winning and takes them
when it is losing. Move ordering — transposition-table move first, then captures by
most-valuable-victim, then killer and history moves — is what makes the
pruning effective. Evaluation is material, piece-square tables blended between
middlegame and endgame, the bishop pair, and pawn structure.

## Tests

```bash
npm test
```

Two suites run, with no dependencies. `test/perft.js` walks the move tree
from six standard test positions and compares the leaf counts against
published values — this is what catches subtle rule bugs around en passant,
pinned pieces and castling rights — and checks repetition hashing and move
notation. `test/engine-play.js` checks that the search finds forced mates
with the right length, wins hanging material, handles repetitions, keeps to
its time budget, and that a stronger level beats a weaker one over four
games.

```bash
npm install
npx playwright install chromium   # once
npm run test:browser
```

`test/browser.js` drives the real page in headless Chromium: all three modes,
promotion, undo, and a full online game between two separate browser
profiles — including both players refreshing mid-game, a stranger being
turned away, draw offers, resignation and a rematch — against a local PeerJS
broker.

## Layout

```
index.html             markup
css/style.css          theme and layout
js/engine.js           rules: move generation, make/unmake, SAN, UCI, FEN
js/ai.js               search and evaluation
js/ui.js               rendering, input, game modes, online protocol
js/online.js           peer-to-peer connection: handshake, heartbeat, reconnects
js/worker.js           runs the search off the main thread
js/vendor/peerjs.min.js  PeerJS 1.5.5 (MIT), loaded only for online play
test/                  perft, engine-strength and browser suites
```

## License

MIT — see [LICENSE](LICENSE). The bundled PeerJS client is also MIT
licensed, by Michelle Bu and Eric Zhang.
