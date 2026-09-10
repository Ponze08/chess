/*
 * worker.js — runs the search off the main thread so the board stays
 * responsive while the computer thinks.
 *
 * ui.js falls back to searching on the main thread when workers are
 * unavailable, which is the case when the page is opened directly from disk.
 */
/* global importScripts */
importScripts('engine.js', 'ai.js');

self.onmessage = function (e) {
  var req = e.data;
  try {
    var pos = self.Chess.parseFEN(req.fen);
    var result = self.ChessAI.chooseMove(pos, req.level);
    if (!result) {
      self.postMessage({ id: req.id, move: null });
      return;
    }
    self.postMessage({
      id: req.id,
      move: { from: result.move.from, to: result.move.to, promotion: result.move.promotion },
      score: result.score,
      depth: result.depth,
      nodes: result.nodes,
      timeMs: result.timeMs
    });
  } catch (err) {
    self.postMessage({ id: req.id, error: String(err && err.message || err) });
  }
};
