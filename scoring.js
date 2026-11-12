// Pure scoring logic — no DOM, no network. Works in the browser (window.Scoring) and Node (require).
(function (root) {
  'use strict';

  // Rank each hole 1..N by stroke index (1 = hardest). Ranking rather than using the raw SI
  // means a 9-hole round using an 18-hole card's SIs (e.g. 1,3,5...) still allocates correctly.
  function siRanks(holes) {
    const order = holes.map((_, i) => i).sort((a, b) => (holes[a].si - holes[b].si) || (a - b));
    const ranks = new Array(holes.length);
    order.forEach((holeIdx, r) => { ranks[holeIdx] = r + 1; });
    return ranks;
  }

  // Shots a player gets on a hole of the given SI rank. Plus handicaps (negative) give shots
  // back, starting on the easiest holes.
  function strokesReceived(hc, rank, n) {
    if (hc >= 0) return Math.floor(hc / n) + (rank <= hc % n ? 1 : 0);
    const h = -hc;
    return -(Math.floor(h / n) + (rank > n - (h % n) ? 1 : 0));
  }

  function playerSummary(player, holes, byHole) {
    const n = holes.length;
    const ranks = siRanks(holes);
    let thru = 0, gross = 0, grossToPar = 0, netByIndex = 0, points = 0;
    const perHole = holes.map((h, i) => {
      const recv = strokesReceived(player.handicap, ranks[i], n);
      const s = byHole[h.n];
      if (s == null) return { hole: h.n, par: h.par, recv, strokes: null };
      thru++;
      gross += s;
      grossToPar += s - h.par;
      const net = s - recv;
      netByIndex += net - h.par;
      const pts = Math.max(0, 2 + h.par - net);
      points += pts;
      return { hole: h.n, par: h.par, recv, strokes: s, net, pts };
    });
    return {
      player, thru, gross, grossToPar, points, perHole,
      upfront: grossToPar - player.handicap, // starts at -handicap, moves with gross vs par
      netByIndex,                              // shots taken hole by hole using stroke index
      finished: thru === n
    };
  }

  function sortKey(row, mode) {
    if (mode === 'stableford') return -row.points;
    if (mode === 'index') return row.netByIndex;
    return row.upfront;
  }

  // scores: [{player_id, hole, strokes}]
  function leaderboard(players, holes, scores, mode) {
    const by = {};
    scores.forEach(s => { (by[s.player_id] = by[s.player_id] || {})[s.hole] = s.strokes; });
    const rows = players.map(p => playerSummary(p, holes, by[p.id] || {}));
    rows.sort((a, b) => (sortKey(a, mode) - sortKey(b, mode)) || (b.thru - a.thru) ||
      String(a.player.name).localeCompare(String(b.player.name)));
    let pos = 0, prev = null;
    rows.forEach((r, i) => {
      const k = sortKey(r, mode);
      if (k !== prev) { pos = i + 1; prev = k; }
      r.pos = pos;
    });
    const count = {};
    rows.forEach(r => { count[r.pos] = (count[r.pos] || 0) + 1; });
    rows.forEach(r => { r.posLabel = (count[r.pos] > 1 ? 'T' : '') + r.pos; });
    return rows;
  }

  function fmtToPar(v) {
    if (v === 0) return 'E';
    return v > 0 ? '+' + v : '−' + Math.abs(v);
  }

  function scoreText(row, mode) {
    if (mode === 'stableford') return row.points + ' pts';
    return fmtToPar(mode === 'index' ? row.netByIndex : row.upfront);
  }

  function scoreName(strokes, par) {
    const d = strokes - par;
    if (strokes === 1) return 'Hole in one';
    if (d <= -3) return 'Albatross';
    if (d === -2) return 'Eagle';
    if (d === -1) return 'Birdie';
    if (d === 0) return 'Par';
    if (d === 1) return 'Bogey';
    if (d === 2) return 'Double bogey';
    if (d === 3) return 'Triple bogey';
    return '+' + d;
  }

  function soleLeader(board) {
    const top = board.filter(r => r.pos === 1);
    return top.length === 1 && top[0].thru > 0 ? top[0].player.id : null;
  }

  // Compare the board before and after one score landed and say what's worth shouting about.
  function eventAlerts(before, after, change, mode) {
    const out = [];
    const row = after.find(r => r.player.id === change.player_id);
    if (!row) return out;
    const name = row.player.name;
    const d = change.strokes - change.par;
    const where = `on the par-${change.par} ${ordinal(change.hole)}`;
    if (change.strokes === 1) out.push({ type: 'good', title: `HOLE IN ONE — ${name}!`, body: `An ace ${where}` });
    else if (d <= -3) out.push({ type: 'good', title: `Albatross for ${name}!`, body: `${change.strokes} ${where}` });
    else if (d === -2) out.push({ type: 'good', title: `Eagle for ${name}!`, body: `${change.strokes} ${where}` });
    else if (d === -1) out.push({ type: 'good', title: `Birdie for ${name}`, body: `${change.strokes} ${where}` });
    else if (d >= 3) out.push({ type: 'blob', title: `${name} ran up a ${change.strokes}`, body: `${scoreName(change.strokes, change.par)} ${where}` });

    const was = soleLeader(before), now = soleLeader(after);
    if (now && now !== was) {
      const r = after.find(x => x.player.id === now);
      out.push({ type: 'lead', title: `${r.player.name} takes the lead`, body: `${scoreText(r, mode)} thru ${r.thru}` });
    }
    const prevRow = before.find(r => r.player.id === change.player_id);
    if (row.finished && prevRow && !prevRow.finished) {
      out.push({ type: 'finish', title: `${name} is in the clubhouse`,
        body: `Net ${fmtToPar(row.upfront)} · Gross ${row.gross} · ${row.points} pts` });
    }
    return out;
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  const api = { siRanks, strokesReceived, playerSummary, leaderboard, fmtToPar, scoreText, scoreName, eventAlerts, ordinal };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof window !== 'undefined' ? window : globalThis);
