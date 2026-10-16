/*
 * browser.js — drives the real page in headless Chromium.
 *
 * Covers what the Node suites cannot reach: input handling, the three game
 * modes, and online play end to end. For the online part a local PeerJS
 * broker stands in for the public one, and two separate browser contexts
 * (separate storage, like two people's browsers) play each other.
 *
 * Needs the dev dependencies (`npm install`) and a Chromium for Playwright
 * (`npx playwright install chromium`).
 */
var http = require('http');
var fs = require('fs');
var path = require('path');
var playwright = require('playwright');
var PeerServer = require('peer').PeerServer;

var ROOT = path.join(__dirname, '..');
var TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

var failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + name + (detail ? '   ' + detail : ''));
}

function serveStatic() {
  return new Promise(function (resolve) {
    var server = http.createServer(function (req, res) {
      var file = path.join(ROOT, decodeURIComponent(req.url.split(/[?#]/)[0]));
      if (file.endsWith(path.sep)) file = path.join(file, 'index.html');
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, function (err, data) {
        if (err) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

function startBroker() {
  return new Promise(function (resolve) {
    PeerServer({ port: 0, host: '127.0.0.1', path: '/' }, function (srv) {
      resolve({ server: srv, port: srv.address().port });
    });
  });
}

// Square index as the board uses it: 0 is a8, 63 is h1.
function idx(square) {
  return (8 - Number(square[1])) * 8 + 'abcdefgh'.indexOf(square[0]);
}

function sq(square) { return '.square[data-index="' + idx(square) + '"]'; }

async function move(page, uci) {
  await page.click(sq(uci.slice(0, 2)));
  await page.click(sq(uci.slice(2, 4)));
}

async function statusText(page) {
  return page.textContent('#statusText');
}

async function waitStatus(page, pattern, timeout) {
  await page.waitForFunction(function (src) {
    return new RegExp(src).test(document.getElementById('statusText').textContent);
  }, pattern.source, { timeout: timeout || 15000 });
}

async function plyCount(page) {
  return page.$$eval('.moves__ply', function (cells) {
    return cells.filter(function (c) { return c.textContent; }).length;
  });
}

async function waitPlies(page, n, timeout) {
  await page.waitForFunction(function (want) {
    var cells = document.querySelectorAll('.moves__ply');
    var count = 0;
    for (var i = 0; i < cells.length; i++) if (cells[i].textContent) count++;
    return count === want;
  }, n, { timeout: timeout || 15000 });
}

async function pieceAt(page, square) {
  return page.$eval(sq(square), function (s) {
    var p = s.querySelector('.piece');
    return p ? p.className.replace('piece piece--', '') + ':' + p.textContent : null;
  });
}

function watchErrors(page, label, sink) {
  page.on('pageerror', function (err) { sink.push(label + ': ' + err.message); });
  page.on('console', function (msg) {
    if (msg.type() === 'error') sink.push(label + ' console: ' + msg.text());
  });
  page.on('dialog', function (d) { d.accept(); });
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, String(err && err.message || err).split('\n')[0]);
  }
}

(async function main() {
  var server = await serveStatic();
  var b = await startBroker();
  var base = 'http://127.0.0.1:' + server.address().port + '/';
  var peerOptions = {
    host: '127.0.0.1', port: b.port, path: '/', secure: false,
    config: { iceServers: [] }
  };

  var browser = await playwright.chromium.launch({
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns']
  });
  var errors = [];

  async function newPlayer(label) {
    var context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    await context.addInitScript(function (opts) { window.CHESS_PEER_OPTIONS = opts; }, peerOptions);
    var page = await context.newPage();
    watchErrors(page, label, errors);
    return { context: context, page: page };
  }

  // --- Against the computer ---------------------------------------------

  await step('computer mode', async function () {
    var p = await newPlayer('computer');
    var page = p.page;
    await page.goto(base);
    await waitStatus(page, /Your move/);
    check('computer: opens in computer mode', await page.isChecked('input[value="computer"]'));

    var pawn = await pieceAt(page, 'e2');
    check('computer: pawn glyph asks for text presentation', pawn === 'w:\u265F\uFE0E', pawn);

    await move(page, 'e2e4');
    await waitPlies(page, 2);
    check('computer: engine replies to a move', true);
    await waitStatus(page, /Your move/);

    await page.click('#btnHint');
    await page.waitForSelector('.square--suggest', { timeout: 10000 });
    check('computer: hint highlights a move', (await page.$$('.square--suggest')).length === 2);

    await page.click('#btnUndo');
    await waitPlies(page, 0);
    check('computer: undo takes back the move pair', await plyCount(page) === 0);
    check('computer: undo disabled with nothing to take back', await page.isDisabled('#btnUndo'));

    // Playing Black: the computer opens, and that move alone cannot be undone.
    await page.selectOption('#selSide', 'b');
    await waitPlies(page, 1);
    check('computer: as Black, the engine moves first', true);
    check('computer: as Black, undo stays off until you have moved', await page.isDisabled('#btnUndo'));
    await page.selectOption('#selSide', 'w');
    await p.context.close();
  });

  // --- Two players, one device ------------------------------------------

  await step('local mode', async function () {
    var p = await newPlayer('local');
    var page = p.page;
    await page.goto(base);
    await page.click('label:has(input[value="local"])');
    await waitStatus(page, /White to move/);
    check('local: eval bar hidden', await page.isHidden('#evalbar'));
    check('local: difficulty hidden', await page.isHidden('#selLevel'));

    await move(page, 'e2e4');
    await waitStatus(page, /Black to move/);
    await move(page, 'e7e5');
    await waitStatus(page, /White to move/);
    check('local: both sides move from the same screen', await plyCount(page) === 2);

    await page.click('#btnUndo');
    await waitStatus(page, /Black to move/);
    check('local: undo takes back a single move', await plyCount(page) === 1);

    await page.check('#chkAutoFlip');
    var bottomLeft = await page.$eval('.square:nth-child(57)', function (s) { return s.getAttribute('aria-label'); });
    check('local: board turns to the side to move', bottomLeft === 'h8', 'bottom-left is ' + bottomLeft);
    await page.uncheck('#chkAutoFlip');

    // Race a pawn to promotion: 1.a4 … 5.bxa8, then pick a knight.
    await page.click('#btnNew');
    var line = ['a2a4', 'b7b5', 'a4b5', 'a7a6', 'b5a6', 'c8b7', 'a6b7', 'b8c6'];
    for (var i = 0; i < line.length; i++) await move(page, line[i]);
    await move(page, 'b7a8');
    await page.waitForSelector('#promotionModal:not([hidden])');
    await page.keyboard.press('Escape');
    check('local: promotion can be cancelled', await page.isHidden('#promotionModal') &&
      (await pieceAt(page, 'b7')) === 'w:\u265F\uFE0E');
    await move(page, 'b7a8');
    await page.click('.promo-btn[title="Knight"]');
    check('local: underpromotion to a knight', (await pieceAt(page, 'a8')) === 'w:\u265E\uFE0E');
    var lastSan = await page.$eval('.moves__ply--latest', function (c) { return c.textContent; });
    check('local: promotion recorded in the move list', lastSan === 'bxa8=N', lastSan);
    // White took two pawns, a bishop and a rook, and lost nothing: the pawn
    // that promoted must not show up as a White loss.
    var takenByWhite = await page.$$eval('#capturedBottom .piece', function (ps) { return ps.length; });
    var takenByBlack = await page.$$eval('#capturedTop .piece', function (ps) { return ps.length; });
    check('local: captured pieces counted from the game record',
      takenByWhite === 4 && takenByBlack === 0, takenByWhite + ' and ' + takenByBlack + ' shown');

    // Mode survives a reload.
    await page.reload();
    check('local: mode is remembered', await page.isChecked('input[value="local"]'));
    await page.click('label:has(input[value="computer"])');
    await p.context.close();
  });

  // --- Online ------------------------------------------------------------

  await step('online mode', async function () {
    var host = await newPlayer('host');
    var guest = await newPlayer('guest');
    var hp = host.page, gp = guest.page;

    await hp.goto(base);
    await hp.click('label:has(input[value="online"])');
    await hp.selectOption('#selOnlineSide', 'w');
    await hp.click('#btnInvite');
    await waitStatus(hp, /Waiting for your friend/);
    var link = await hp.inputValue('#inviteLink');
    check('online: invite link created', /#play=[a-z0-9]{10}$/.test(link), link);

    await gp.goto(link);
    await waitStatus(gp, /Your friend.s move/, 20000);
    await waitStatus(hp, /Your move/);
    check('online: friend joins from the link and the game starts', true);
    check('online: host plays White as chosen', (await hp.textContent('#nameBottom')) === 'You' &&
      (await hp.getAttribute('#swatchBottom', 'class')).indexOf('--w') !== -1);
    check('online: guest sees the board from Black', (await gp.$eval('.square:first-child',
      function (s) { return s.getAttribute('aria-label'); })) === 'h1');

    await move(hp, 'e2e4');
    await waitPlies(gp, 1);
    check('online: host move reaches the guest', (await pieceAt(gp, 'e4')) === 'w:\u265F\uFE0E');
    await waitStatus(gp, /Your move/);
    await move(gp, 'e7e5');
    await waitPlies(hp, 2);
    check('online: guest move reaches the host', (await pieceAt(hp, 'e5')) === 'b:\u265F\uFE0E');

    // Not your turn: clicks do nothing.
    await gp.click(sq('d7'), { force: true });
    check('online: cannot move on the friend\u2019s turn', (await gp.$$('.square--selected')).length === 0);

    // The guest refreshes mid-game and carries on.
    await gp.reload();
    await waitStatus(gp, /Your friend.s move/, 20000);
    check('online: guest refresh resumes the game', await plyCount(gp) === 2);
    await waitStatus(hp, /Your move/, 20000);
    await move(hp, 'g1f3');
    await waitPlies(gp, 3);
    check('online: moves flow after the refresh', (await pieceAt(gp, 'f3')) === 'w:\u265E\uFE0E');

    // The host refreshes too: it must reclaim its ID and the game.
    await hp.reload();
    await waitStatus(hp, /Your friend.s move/, 45000);
    await waitStatus(gp, /Your move/, 45000);
    check('online: host refresh resumes the game', await plyCount(hp) === 3);
    await move(gp, 'b8c6');
    await waitPlies(hp, 4);
    check('online: moves flow after the host refresh', (await pieceAt(hp, 'c6')) === 'b:\u265E\uFE0E');

    // A stranger opening the same link is turned away.
    var stranger = await newPlayer('stranger');
    await stranger.page.goto(link);
    await waitStatus(stranger.page, /already has two players/, 20000);
    check('online: a third person is turned away', true);
    await stranger.context.close();

    // Draw offer, declined.
    await hp.click('#btnDraw');
    await gp.waitForSelector('#offer:not([hidden])');
    check('online: draw offer shown to the friend',
      /offers a draw/.test(await gp.textContent('#offerText')));
    await gp.click('#btnDecline');
    await hp.waitForFunction(function () {
      return /declined the draw/.test(document.getElementById('offerText').textContent);
    });
    check('online: declined draw reported back', true);

    // The guest resigns.
    await gp.click('#btnResign');
    await waitStatus(hp, /resigned — you win/);
    await waitStatus(gp, /You resigned/);
    check('online: resignation ends the game on both sides', true);

    // Rematch, with colours swapped.
    await hp.click('#btnRematch');
    await gp.waitForSelector('#offer:not([hidden]) #btnAccept');
    await gp.click('#btnAccept');
    await waitStatus(gp, /Your move/, 15000);
    await waitStatus(hp, /Your friend.s move/, 15000);
    check('online: rematch starts with colours swapped', await plyCount(gp) === 0 &&
      (await gp.getAttribute('#swatchBottom', 'class')).indexOf('--w') !== -1);
    await move(gp, 'd2d4');
    await waitPlies(hp, 1);
    check('online: moves flow in the rematch', (await pieceAt(hp, 'd4')) === 'w:\u265F\uFE0E');

    // A draw by agreement.
    await gp.click('#btnDraw');
    await hp.waitForSelector('#offer:not([hidden]) #btnAccept');
    await hp.click('#btnAccept');
    await waitStatus(gp, /Draw agreed/);
    await waitStatus(hp, /Draw agreed/);
    check('online: draw by agreement', true);

    // The guest leaves; the host is told.
    await gp.click('#btnLeave');
    await waitStatus(hp, /left the game/, 15000);
    check('online: leaving is reported to the friend', true);
    check('online: guest is back in the lobby', await gp.isVisible('#btnInvite'));

    await host.context.close();
    await guest.context.close();
  });

  await step('online: unknown link', async function () {
    var p = await newPlayer('lost');
    await p.page.goto(base + '#play=nosuchgame23');
    await waitStatus(p.page, /Could not find that game/, 90000);
    check('online: a dead link says so', await p.page.isVisible('#btnRetry'));
    await p.context.close();
  });

  check('no page errors', errors.length === 0, errors.slice(0, 5).join(' | '));

  await browser.close();
  server.close();
  b.server.close();
  console.log(failures === 0 ? '\nbrowser: all checks passed' : '\nbrowser: ' + failures + ' failure(s)');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (err) {
  console.error(err);
  process.exit(1);
});
