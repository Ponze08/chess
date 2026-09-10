# Chess

Play chess against a computer opponent in your browser. No build step, no
dependencies, no server required — it is plain HTML, CSS and JavaScript.

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

- Click a piece and then its destination, or drag it.
- Legal destinations appear as dots; a ring means a capture.
- **Undo** takes back your move and the computer's reply together.
- **Hint** asks the engine what it would play in your position.
- Changing the difficulty or your colour starts a new game.

The bar beside the board is the engine's evaluation, and it always fills from
the bottom for whichever side you are playing.

All the rules are implemented: castling, en passant, underpromotion,
stalemate, the fifty-move rule, threefold repetition and draws by insufficient
material.

## Difficulty

| Level  | Search depth | Time budget | Notes |
| ------ | ------------ | ----------- | ----- |
| Easy   | 2 ply        | 0.4s        | Plays randomly among near-equal moves |
| Medium | 3 ply        | 0.9s        | Slight randomness, so games differ |
| Hard   | 5 ply        | 2.0s        | Deterministic, plays the move it thinks is best |
| Expert | 8 ply        | 4.5s        | Deterministic, searches as deep as the clock allows |

Depth is a ceiling rather than a promise: the search deepens one ply at a time
and stops when it runs out of time, so it uses whatever your machine allows.

## How the engine works

`js/engine.js` holds the rules. The board is a flat 64-entry array where index
0 is a8, and moves are made and unmade in place with an undo stack rather than
by copying the position, which keeps the search cheap. A Zobrist hash is
maintained incrementally for the transposition table and for detecting
repetitions.

`js/ai.js` is the search: negamax with alpha-beta pruning, iterative
deepening, a transposition table, and a quiescence search that follows
captures to the end so the engine is not fooled by an exchange cut off
half-way. Move ordering — transposition-table move first, then captures by
most-valuable-victim, then killer and history moves — is what makes the
pruning effective. Evaluation is material, piece-square tables blended between
middlegame and endgame, the bishop pair, and pawn structure.

## Tests

```bash
npm test
```

Two suites run. `test/perft.js` walks the move tree from six standard test
positions and compares the leaf counts against published values — this is what
catches subtle rule bugs around en passant, pinned pieces and castling rights.
`test/engine-play.js` checks that the search finds forced mates, wins hanging
material, keeps to its time budget, and that a stronger level beats a weaker
one over four games.

## Layout

```
index.html        markup
css/style.css     theme and layout
js/engine.js      rules: move generation, make/unmake, SAN, FEN
js/ai.js          search and evaluation
js/ui.js          rendering, input, game loop
js/worker.js      runs the search off the main thread
test/             perft and engine-strength suites
```

## License

MIT — see [LICENSE](LICENSE).
