(() => {
  'use strict';
  const S = window.Scoring;
  const CFG = window.SCORECARD_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  const $app = document.getElementById('app');
  const $toasts = document.getElementById('toasts');

  // ---------- storage (best effort) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  const DEFAULT_SETTINGS = { alerts: true, notify: false, vibrate: true, good: true, blobs: true, lead: true, finish: true };

  const state = {
    view: 'home',            // home | setup | who | round
    round: null,
    players: [],
    confirmed: {},           // "playerId:hole" -> strokes (as the server has it)
    local: {},               // pending edits not yet saved: key -> strokes | null
    meId: null,
    tab: 'score',            // score | board | card
    hole: 1,
    mode: store.get('gs:mode', 'upfront'),
    scope: store.get('gs:scope', 'group'), // me | group
    joinGrp: null,
    cardGrp: null,
    live: false,
    channel: null,
    courses: [],
    setup: null,
    settings: Object.assign({}, DEFAULT_SETTINGS, store.get('gs:settings', {})),
    sheet: false,
    busy: false,
    error: ''
  };

  const timers = {};
  let swReg = null;

  // ---------- helpers ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtHc = h => (h < 0 ? '+' + (-h) : String(h));
  function parseHc(v) {
    v = String(v == null ? '' : v).trim();
    if (!v) return NaN;
    let plus = false;
    if (v[0] === '+') { plus = true; v = v.slice(1); }
    const n = Number(v);
    if (!Number.isInteger(n)) return NaN;
    return plus ? -n : n;
  }
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function genCode() {
    const a = crypto.getRandomValues(new Uint8Array(6));
    let s = '';
    for (const x of a) s += ALPH[x % ALPH.length];
    return s;
  }
  const keyOf = (pid, hole) => pid + ':' + hole;
  function makeHoles(n) {
    return Array.from({ length: n }, (_, i) => ({ n: i + 1, par: 4, si: '' }));
  }
  const holeByN = n => state.round.holes.find(h => h.n === n);
  // The course is fixed to Wheatlands for now (par, stroke index and yards from the club card).
  const COURSE = {
    name: 'Wheatlands',
    holes: [[18, 125], [15, 126], [8, 167], [1, 195], [13, 162], [11, 150], [4, 170], [2, 183], [9, 149],
            [17, 141], [16, 110], [5, 179], [6, 143], [14, 132], [10, 174], [7, 139], [12, 131], [3, 191]]
      .map(([si, y], i) => ({ n: i + 1, par: 3, si, y }))
  };
  const MAX_GROUP = 4;
  const grpOf = p => p.grp || 1;
  const groupNums = () => [...new Set(state.players.map(grpOf))].sort((a, b) => a - b);
  const groupCount = g => state.players.filter(p => grpOf(p) === g).length;
  const meP = () => state.players.find(p => p.id === state.meId);
  const myGroup = () => { const me = meP(); return me ? grpOf(me) : null; };
  const inGroup = g => state.players.filter(p => grpOf(p) === g);
  function defaultJoinGroup() {
    const open = groupNums().find(g => groupCount(g) < MAX_GROUP);
    return open || (groupNums().length ? Math.max(...groupNums()) + 1 : 1);
  }
  // Chips for picking a playing group: existing groups (full ones locked) plus a new one.
  function groupChips(action, selected, extra) {
    const nums = groupNums();
    const next = nums.length ? Math.max(...nums) + 1 : 1;
    const opts = nums.concat(nums.includes(next) ? [] : [next]);
    return `<div class="gchips">${opts.map(g => {
      const n = groupCount(g), full = n >= MAX_GROUP && g !== selected;
      const label = nums.includes(g) ? `Group ${g}<small>${n} player${n === 1 ? '' : 's'}${n >= MAX_GROUP ? ' · full' : ''}</small>` : `+ New group<small>Group ${g}</small>`;
      return `<button type="button" class="gchip ${g === selected ? 'on' : ''}" data-a="${action}" data-v="${g}" ${full ? 'disabled' : ''}${extra || ''}>${label}</button>`;
    }).join('')}</div>`;
  }
  const parTotal = holes => holes.reduce((a, h) => a + Number(h.par || 0), 0);
  const shareUrl = code => location.origin + location.pathname + '?r=' + code;

  function scoresFrom(map) {
    return Object.keys(map).map(k => {
      const i = k.lastIndexOf(':');
      return { player_id: k.slice(0, i), hole: Number(k.slice(i + 1)), strokes: map[k] };
    }).filter(s => s.strokes != null);
  }
  function mergedMap() {
    const m = Object.assign({}, state.confirmed);
    for (const k of Object.keys(state.local)) {
      if (state.local[k] == null) delete m[k]; else m[k] = state.local[k];
    }
    return m;
  }
  const boardOf = (map, mode) => S.leaderboard(state.players, state.round.holes, scoresFrom(map), mode || state.mode);

  function scoreClass(strokes, par) {
    if (strokes == null) return '';
    const d = strokes - par;
    if (d <= -2) return 'eagle';
    if (d === -1) return 'birdie';
    if (d === 0) return 'par';
    if (d === 1) return 'bogey';
    return 'dbl';
  }
  const toParClass = v => (v < 0 ? 'under' : v > 0 ? 'over' : 'even');

  // ---------- alerts ----------
  function toast(title, body, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.addEventListener('click', () => el.remove());
    el.innerHTML = `<b>${esc(title)}</b>${body ? `<span>${esc(body)}</span>` : ''}`;
    while ($toasts.children.length >= 2) $toasts.firstElementChild.remove();
    $toasts.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, 3800);
  }
  function fireAlerts(list) {
    const st = state.settings;
    if (!st.alerts) return;
    const allowed = list.filter(a => st[a.type] !== false);
    if (!allowed.length) return;
    allowed.forEach(a => toast(a.title, a.body, a.type));
    if (st.vibrate && navigator.vibrate) navigator.vibrate(allowed.some(a => a.type === 'good') ? [80, 60, 80] : 120);
    if (st.notify && document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') {
      allowed.forEach(a => {
        const opts = { body: a.body, icon: 'icon-192.png', badge: 'icon-192.png', tag: a.type + ':' + a.title, data: { url: shareUrl(state.round.code) } };
        if (swReg && swReg.showNotification) swReg.showNotification(a.title, opts);
        else { try { new Notification(a.title, opts); } catch (e) { /* ignore */ } }
      });
    }
  }
  async function enableNotifications() {
    if (!('Notification' in window)) {
      toast('Not supported here', 'On iPhone, add the app to your Home Screen first, then enable notifications.');
      return;
    }
    const p = await Notification.requestPermission();
    state.settings.notify = p === 'granted';
    store.set('gs:settings', state.settings);
    toast(p === 'granted' ? 'Notifications on' : 'Notifications blocked',
      p === 'granted' ? 'You\'ll get alerts while the app is open in the background.' : 'You can change this in your browser settings.');
    render();
  }

  // ---------- data ----------
  function applyConfirmed(pid, hole, strokes, silent) {
    const k = keyOf(pid, hole);
    const prev = k in state.confirmed ? state.confirmed[k] : null;
    if (prev === strokes) return;
    const before = state.round ? boardOf(state.confirmed) : null;
    if (strokes == null) delete state.confirmed[k]; else state.confirmed[k] = strokes;
    if (!silent && strokes != null && before) {
      const after = boardOf(state.confirmed);
      const h = holeByN(hole);
      if (h) fireAlerts(S.eventAlerts(before, after, { player_id: pid, hole, strokes, par: h.par }, state.mode));
    }
    if (state.view === 'round') render();
  }


  async function fetchRound(code) {
    const { data: round, error } = await sb.from('rounds').select('*').eq('code', code).maybeSingle();
    if (error) throw error;
    if (!round) return null;
    const [{ data: players, error: e1 }, { data: scores, error: e2 }] = await Promise.all([
      sb.from('players').select('*').eq('round_id', round.id).order('created_at'),
      sb.from('scores').select('player_id,hole,strokes').eq('round_id', round.id)
    ]);
    if (e1 || e2) throw (e1 || e2);
    return { round, players: players || [], scores: scores || [] };
  }

  async function openRound(code) {
    code = String(code || '').trim().toUpperCase();
    if (!code) return;
    state.busy = true; state.error = ''; render();
    try {
      const res = await fetchRound(code);
      if (!res) { state.error = `No round found with code ${code}.`; state.view = 'home'; return; }
      state.round = res.round;
      state.players = res.players;
      state.confirmed = {};
      res.scores.forEach(s => { state.confirmed[keyOf(s.player_id, s.hole)] = s.strokes; });
      state.local = {};
      state.meId = store.get('gs:me:' + res.round.id, null);
      if (state.meId && !state.players.some(p => p.id === state.meId)) state.meId = null;
      state.hole = nextHoleFor(state.meId);
      state.tab = 'score';
      rememberRound(res.round);
      history.replaceState(null, '', '?r=' + res.round.code);
      state.view = state.meId || store.get('gs:spectate:' + res.round.id, false) ? 'round' : 'who';
      subscribe();
    } catch (e) {
      state.error = 'Couldn\'t load the round — check your signal and try again.';
      state.view = 'home';
    } finally {
      state.busy = false; render();
    }
  }

  async function resync() {
    if (!state.round) return;
    try {
      const res = await fetchRound(state.round.code);
      if (!res) return;
      state.players = res.players;
      const fresh = {};
      res.scores.forEach(s => { fresh[keyOf(s.player_id, s.hole)] = s.strokes; });
      state.confirmed = fresh;
      render();
    } catch (e) { /* offline; try later */ }
  }

  function subscribe() {
    if (state.channel) sb.removeChannel(state.channel);
    const rid = state.round.id;
    const flt = `round_id=eq.${rid}`;
    const onScore = p => {
      const r = p.new;
      if (!r || r.round_id !== rid) return;
      applyConfirmed(r.player_id, r.hole, r.strokes, false);
    };
    const onPlayer = p => {
      const r = p.new;
      if (!r || r.round_id !== rid) return;
      const i = state.players.findIndex(x => x.id === r.id);
      if (i >= 0) state.players[i] = r; else { state.players.push(r); if (r.id !== state.meId) toast(`${r.name} joined`, `Playing off ${fmtHc(r.handicap)}`); }
      render();
    };
    state.channel = sb.channel('round-' + rid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'scores', filter: flt }, onScore)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'scores', filter: flt }, onScore)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'scores' }, p => {
        const o = p.old;
        if (o && o.round_id === rid) applyConfirmed(o.player_id, o.hole, null, true);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'players', filter: flt }, onPlayer)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'players', filter: flt }, onPlayer)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'players' }, p => {
        const o = p.old;
        if (!o || o.round_id !== rid) return;
        state.players = state.players.filter(x => x.id !== o.id);
        render();
      })
      .subscribe(status => {
        const was = state.live;
        state.live = status === 'SUBSCRIBED';
        if (state.live && !was) resync();
        if (was !== state.live) render();
      });
  }

  function rememberRound(r) {
    const list = store.get('gs:recent', []).filter(x => x.code !== r.code);
    list.unshift({ code: r.code, name: r.name, course: r.course_name, date: new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) });
    store.set('gs:recent', list.slice(0, 8));
  }

  function nextHoleFor(pid) {
    if (!state.round) return 1;
    const m = mergedMap();
    const ids = pid ? [pid] : state.players.map(p => p.id);
    const h = state.round.holes.find(h => ids.some(id => m[keyOf(id, h.n)] == null));
    return h ? h.n : state.round.holes[state.round.holes.length - 1].n;
  }

  // Save a score after the taps settle, so + + + doesn't fire three alerts.
  function setScore(pid, hole, strokes) {
    const k = keyOf(pid, hole);
    state.local[k] = strokes;
    render();
    clearTimeout(timers[k]);
    timers[k] = setTimeout(() => saveScore(pid, hole), 900);
  }
  async function saveScore(pid, hole) {
    const k = keyOf(pid, hole);
    if (!(k in state.local)) return;
    const strokes = state.local[k];
    let error;
    if (strokes == null) {
      ({ error } = await sb.from('scores').delete().eq('player_id', pid).eq('hole', hole));
    } else {
      ({ error } = await sb.from('scores').upsert({
        player_id: pid, round_id: state.round.id, hole, strokes, updated_at: new Date().toISOString()
      }, { onConflict: 'player_id,hole' }));
    }
    if (error) {
      toast('Not saved', 'No signal? Will retry in a few seconds.', 'blob');
      timers[k] = setTimeout(() => saveScore(pid, hole), 5000);
      return;
    }
    if (state.local[k] === strokes) delete state.local[k];
    applyConfirmed(pid, hole, strokes, strokes == null);
  }

  // ---------- render ----------
  function render() {
    // keep focus/typing intact across live re-renders
    const a = document.activeElement;
    const keep = a && a.id && (a.tagName === 'INPUT') ? { id: a.id, v: a.value, s: a.selectionStart, e: a.selectionEnd } : null;
    let html = '';
    if (state.view === 'home') html = renderHome();
    else if (state.view === 'setup') html = renderSetup();
    else if (state.view === 'who') html = renderWho();
    else html = renderRound();
    $app.innerHTML = html;
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) { el.value = keep.v; el.focus(); try { el.setSelectionRange(keep.s, keep.e); } catch (e) { /* ignore */ } }
    }
  }

  function renderHome() {
    const recent = store.get('gs:recent', []);
    return `
    <header class="hero">
      <img class="wordmark" src="radar.png" alt="Radar">
      <div class="rule"><span></span><img src="goose.png" alt=""><span></span></div>
      <p>Live scores for your group, hole by hole.</p>
    </header>
    <main class="pad">
      <button class="btn primary big" data-a="newRound" ${state.busy ? 'disabled' : ''}>Start a new round</button>
      <div class="card">
        <label class="lbl" for="joinCode">Have a round code?</label>
        <div class="row">
          <input id="joinCode" class="input code" maxlength="8" placeholder="CODE" autocapitalize="characters" autocomplete="off" spellcheck="false">
          <button class="btn dark" data-a="join" ${state.busy ? 'disabled' : ''}>Join round</button>
        </div>
      </div>
      ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
      ${recent.length ? `<h2 class="sub">Your recent rounds</h2>
      <div class="list">${recent.map(r => `
        <button class="item" data-a="open" data-code="${esc(r.code)}">
          <div><b>${esc(r.name || r.course)}</b><small>${esc(r.course)} · ${esc(r.date)}</small></div>
          <span class="chip">${esc(r.code)}</span>
        </button>`).join('')}</div>` : ''}
    </main>`;
  }

  function renderSetup() {
    const st = state.setup;
    return `
    <header class="bar"><button class="icon" data-a="home" aria-label="Back">‹</button><div class="bar-t"><b>New round</b></div></header>
    <main class="pad">
      <div class="card">
        <label class="lbl">Round name <span class="muted">(optional)</span></label>
        <input class="input" data-f="name" placeholder="Saturday medal" value="${esc(st.name)}">
      </div>
      <div class="course-fixed">
        <div><b>${esc(COURSE.name)}</b><small>18 holes · the nine played twice</small></div>
        <dl><div><dt>Par</dt><dd>${parTotal(COURSE.holes)}</dd></div><div><dt>Yards</dt><dd>${COURSE.holes.reduce((a, h) => a + h.y, 0).toLocaleString('en-GB')}</dd></div></dl>
      </div>
      <div class="card">
        <label class="lbl">Your name and handicap</label>
        ${st.players.map((p, i) => `
          <div class="prow">
            <input class="input" data-f="pname" data-i="${i}" placeholder="Name" value="${esc(p.name)}" autocomplete="off">
            <input class="input hc" data-f="phc" data-i="${i}" placeholder="HC" inputmode="numeric" value="${esc(p.hc)}">
            <select class="input grp" data-f="pgrp" data-i="${i}" aria-label="Group">${[1, 2, 3, 4, 5, 6, 7, 8].map(g => `<option value="${g}" ${Number(p.grp) === g ? 'selected' : ''}>G${g}</option>`).join('')}</select>
            ${st.players.length > 1 ? `<button class="icon sm" data-a="rmSetupPlayer" data-i="${i}" aria-label="Remove">✕</button>` : '<span class="icon sm"></span>'}
          </div>`).join('')}
        <p class="muted">Everyone else joins from the link you share next, and picks their own group. Add others here only if you're scoring for them. Use +2 for a plus handicap.</p>
        <button class="btn ghost sm" data-a="addSetupPlayer">+ Add another player</button>
      </div>
      ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
      <button class="btn primary big" data-a="startRound" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Creating…' : 'Tee off'}</button>
    </main>`;
  }

  function shareBox() {
    const r = state.round;
    return `
      <div class="share">
        <div><small>Round code</small><b class="codebig">${esc(r.code)}</b></div>
        <button class="btn sm" data-a="share">Share link</button>
      </div>`;
  }

  function renderWho() {
    const r = state.round;
    return `
    <header class="bar"><button class="icon" data-a="home" aria-label="Home">‹</button>
      <div class="bar-t"><b>${esc(r.name || r.course_name)}</b><small>${esc(r.course_name)}</small></div></header>
    <main class="pad">
      ${shareBox()}
      <h2 class="sub">Who are you?</h2>
      ${groupNums().map(g => `
        <div class="ghead">Group ${g}<span>${groupCount(g)}-ball</span></div>
        <div class="list">${inGroup(g).map(p => `
          <button class="item" data-a="pickMe" data-id="${p.id}"><b>${esc(p.name)}</b><span class="chip">HC ${fmtHc(p.handicap)}</span></button>`).join('')}
        </div>`).join('')}
      <div class="card">
        <label class="lbl">Not on the list? Add yourself</label>
        <div class="row">
          <input id="meName" class="input" placeholder="Name" autocomplete="off">
          <input id="meHc" class="input hc" placeholder="HC" inputmode="numeric">
        </div>
        <label class="lbl mt">Your playing group</label>
        ${groupChips('joinGrp', state.joinGrp || defaultJoinGroup())}
        <button class="btn primary" data-a="addMe">Add me</button>
      </div>
      ${state.error ? `<p class="err">${esc(state.error)}</p>` : ''}
      <button class="btn ghost" data-a="spectate">Just watching</button>
    </main>`;
  }

  function renderRound() {
    const r = state.round;
    const me = state.players.find(p => p.id === state.meId);
    let body = '';
    if (state.tab === 'score') body = renderScore();
    else if (state.tab === 'board') body = renderBoard();
    else body = renderCard();
    return `
    <header class="bar">
      <button class="icon" data-a="home" aria-label="Home">‹</button>
      <img class="bar-goose" src="goose.png" alt="">
      <div class="bar-t"><b>${esc(r.name || r.course_name)}</b><small><span class="dot ${state.live ? 'on' : ''}"></span>${state.live ? 'Live' : 'Connecting…'} · ${esc(r.course_name)}${me ? ' · ' + esc(me.name) : ''}</small></div>
      <button class="chip code-chip" data-a="share">${esc(r.code)}</button>
      <button class="icon" data-a="openSheet" aria-label="Settings">⚙︎</button>
    </header>
    <main class="pad tabbed">${body}</main>
    <nav class="tabs">
      ${[['score', 'Score', '<path d="M7 21V4"/><path d="M7 4l11 4-11 4"/><ellipse cx="12" cy="21" rx="8" ry="1.6"/>'],
         ['board', 'Leaderboard', '<path d="M4 20h16"/><rect x="5" y="11" width="4" height="9"/><rect x="10" y="6" width="4" height="14"/><rect x="15" y="14" width="4" height="6"/>'],
         ['card', 'Card', '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>']].map(([k, l, ic]) =>
        `<button class="${state.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}" aria-current="${state.tab === k ? 'page' : 'false'}"><svg viewBox="0 0 24 24" aria-hidden="true">${ic}</svg><span>${l}</span></button>`).join('')}
    </nav>
    ${state.sheet ? renderSheet() : ''}`;
  }

  function renderScore() {
    const holes = state.round.holes;
    const h = holeByN(state.hole) || holes[0];
    const idx = holes.indexOf(h);
    const ranks = S.siRanks(holes);
    const m = mergedMap();
    const board = boardOf(m);
    const mg = myGroup();
    const list = !state.meId ? state.players : state.scope === 'group' ? inGroup(mg) : state.players.filter(p => p.id === state.meId);
    const stripPlayers = mg ? inGroup(mg) : state.players;
    const strip = holes.map(x => {
      const done = stripPlayers.length && stripPlayers.every(p => m[keyOf(p.id, x.n)] != null);
      const mine = state.meId && m[keyOf(state.meId, x.n)] != null;
      return `<button class="hchip ${x.n === h.n ? 'on' : ''} ${done ? 'done' : mine ? 'mine' : ''}" data-a="goHole" data-v="${x.n}">${x.n}</button>`;
    }).join('');
    const rows = list.map(p => {
      const v = m[keyOf(p.id, h.n)];
      const recv = S.strokesReceived(p.handicap, ranks[idx], holes.length);
      const row = board.find(b => b.player.id === p.id);
      const shots = recv > 0 ? `<span class="shots" aria-hidden="true">${'●'.repeat(Math.min(recv, 4))}</span>${recv} shot${recv > 1 ? 's' : ''} here` : recv < 0 ? `Gives ${-recv} back` : 'No shot here';
      const runV = row && row.thru ? (state.mode === 'stableford' ? row.points : state.mode === 'index' ? row.netByIndex : row.upfront) : null;
      return `
      <div class="entry">
        <div class="who">
          <b>${esc(p.name)}</b>
          <small>HC ${fmtHc(p.handicap)} <span class="sep"></span> ${shots}</small>
          <small class="run">${row && row.thru ? `<span class="${state.mode === 'stableford' ? '' : toParClass(runV)}">${S.scoreText(row, state.mode)}</span> after ${row.thru}` : 'Not started'}</small>
        </div>
        <div class="stepper">
          <button data-a="dec" data-p="${p.id}" aria-label="One less for ${esc(p.name)}">−</button>
          <div class="valwrap">
            <button class="val ${scoreClass(v, h.par)}" data-a="tapScore" data-p="${p.id}" aria-label="${v != null ? 'Clear score' : 'Set par'} for ${esc(p.name)}">${v != null ? v : '–'}</button>
            <span class="vname">${v != null ? S.scoreName(v, h.par) : 'Tap for par'}</span>
          </div>
          <button data-a="inc" data-p="${p.id}" aria-label="One more for ${esc(p.name)}">+</button>
        </div>
      </div>`;
    }).join('');
    return `
      <section class="hole-hero">
        <div class="hh-top">
          <button class="hh-nav" data-a="prevHole" ${idx === 0 ? 'disabled' : ''} aria-label="Previous hole">‹</button>
          <div class="hh-main">
            <span class="hh-label">Hole</span>
            <span class="hh-num">${h.n}</span>
          </div>
          <button class="hh-nav" data-a="nextHole" ${idx === holes.length - 1 ? 'disabled' : ''} aria-label="Next hole">›</button>
        </div>
        <dl class="hh-meta">
          <div><dt>Par</dt><dd>${h.par}</dd></div>
          ${h.y ? `<div><dt>Yards</dt><dd>${h.y}</dd></div>` : ''}
          <div><dt>Stroke index</dt><dd>${h.si}</dd></div>
        </dl>
        <div class="strip" role="navigation" aria-label="Holes">${strip}</div>
      </section>
      ${state.meId ? `<div class="seg wide">
        <button class="${state.scope === 'me' ? 'on' : ''}" data-a="scope" data-v="me">Just me</button>
        <button class="${state.scope === 'group' ? 'on' : ''}" data-a="scope" data-v="group">My group · G${mg}</button></div>` : ''}
      <div class="entries">${rows || '<p class="muted">No players yet.</p>'}</div>
      ${state.meId && state.scope === 'group' ? (inGroup(mg).length < MAX_GROUP ? `
      <details class="addpartner"${state.openAdd ? ' open' : ''}>
        <summary data-a="toggleAdd">+ Add a playing partner to Group ${mg}</summary>
        <p class="muted">For someone who won't use their own phone — you'll keep their score.</p>
        <div class="row">
          <input id="ptName" class="input" placeholder="Name" autocomplete="off">
          <input id="ptHc" class="input hc" placeholder="HC" inputmode="numeric">
          <button class="btn primary" data-a="addPartner">Add</button>
        </div>
      </details>` : `<p class="muted tip">Group ${mg} is a full four-ball.</p>`) : ''}
      ${idx < holes.length - 1 ? `<button class="btn primary big next" data-a="nextHole">On to the ${S.ordinal(holes[idx + 1].n)}</button>` : `<button class="btn primary big next" data-a="tab" data-v="card">See the full card</button>`}
      <p class="muted tip">Scores save as you tap and appear on everyone's phone.</p>
      <div class="sub-row"><h2 class="sub">Standings</h2><button class="link" data-a="tab" data-v="board">Full leaderboard</button></div>
      ${boardTable(board, true)}`;
  }

  const MODES = {
    upfront: ['Net', 'Everyone starts on minus their handicap; each hole adds your gross score against par.'],
    index: ['Net by SI', 'Shots are taken on each hole by stroke index — the fairest picture mid-round.'],
    stableford: ['Stableford', 'Points per hole using your shots: 2 for net par, 3 net birdie, and so on.']
  };

  function boardTable(board, compact) {
    if (!board.length) return '<p class="muted">No players yet.</p>';
    const n = state.round.holes.length;
    return `
    <div class="board ${compact ? 'compact' : ''}">
      <div class="brow head"><span>Pos</span><span>Player</span><span>Thru</span><span>${state.mode === 'stableford' ? 'Pts' : 'Score'}</span></div>
      ${board.map(r => {
        const val = state.mode === 'stableford' ? r.points : state.mode === 'index' ? r.netByIndex : r.upfront;
        const cls = state.mode === 'stableford' ? '' : toParClass(val);
        const shown = state.mode === 'stableford' ? String(r.points) : S.fmtToPar(val);
        return `
        <div class="brow ${r.player.id === state.meId ? 'me' : ''}">
          <span class="pos">${r.thru ? r.posLabel : '–'}</span>
          <span class="pl"><b>${esc(r.player.name)}</b><small>HC ${fmtHc(r.player.handicap)}${groupNums().length > 1 ? ` · G${grpOf(r.player)}` : ''}${r.thru ? ` · Gross ${r.gross} (${S.fmtToPar(r.grossToPar)})` : ''}</small></span>
          <span class="thru">${r.finished ? 'F' : r.thru ? r.thru : '–'}</span>
          <span class="sc ${cls}">${shown}</span>
        </div>`;
      }).join('')}
    </div>
    ${n ? '' : ''}`;
  }

  // Running score after each hole, in the style of the old hand-operated tournament boards.
  function holeBoard(board, list, label) {
    const mode = state.mode;
    const cell = (r, h) => {
      const ph = r.perHole.find(x => x.hole === h.n);
      if (!ph || ph.strokes == null) return '<td></td>';
      const v = ph.run[mode];
      if (mode === 'stableford') return `<td class="pts">${v}</td>`;
      return `<td class="${v < 0 ? 'under' : 'over'}">${v === 0 ? 'E' : Math.abs(v)}</td>`;
    };
    return `
      <div class="hb">
        <table>
          <thead>
            <tr class="hb-hole"><th>${label}</th>${list.map(h => `<th>${h.n}</th>`).join('')}</tr>
            <tr class="hb-par"><th>Par</th>${list.map(h => `<th>${h.par}</th>`).join('')}</tr>
          </thead>
          <tbody>${board.map(r => `<tr class="${r.player.id === state.meId ? 'me' : ''}"><th>${esc(r.player.name.split(' ')[0].slice(0, 9).toUpperCase())}</th>${list.map(h => cell(r, h)).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  function renderBoard() {
    const board = boardOf(mergedMap());
    const holes = state.round.holes;
    const front = holes.filter(h => h.n <= 9), back = holes.filter(h => h.n > 9);
    return `
      <div class="seg wide">${Object.keys(MODES).map(k => `<button class="${state.mode === k ? 'on' : ''}" data-a="mode" data-v="${k}">${MODES[k][0]}</button>`).join('')}</div>
      <p class="muted">${MODES[state.mode][1]}</p>
      <div class="leaders">
        <div class="leaders-title"><img src="radar.png" alt="Radar"><span>Leaders</span></div>
        ${boardTable(board, false)}
      </div>
      <div class="hb-wrap">
        ${holeBoard(board, front, 'Hole')}
        ${back.length ? holeBoard(board, back, 'Hole') : ''}
        <p class="hb-key"><span class="under">Red</span> under par · <span class="over">Green</span> over par${state.mode === 'stableford' ? ' · Stableford points' : ''}</p>
      </div>
      ${shareBox()}`;
  }

  function renderCard() {
    const holes = state.round.holes;
    const m = mergedMap();
    const nums = groupNums();
    let cg = state.cardGrp;
    if (cg !== 'all' && !nums.includes(cg)) cg = myGroup() || nums[0] || 1;
    const ps = cg === 'all' ? state.players : inGroup(cg);
    const picker = nums.length > 1 ? `<div class="seg wide">${nums.map(g => `<button class="${cg === g ? 'on' : ''}" data-a="cardGrp" data-v="${g}">Group ${g}</button>`).join('')}<button class="${cg === 'all' ? 'on' : ''}" data-a="cardGrp" data-v="all">All</button></div>` : '';
    const sum = (pid, list) => {
      let t = 0, any = false;
      list.forEach(h => { const v = m[keyOf(pid, h.n)]; if (v != null) { t += v; any = true; } });
      return any ? t : '';
    };
    const front = holes.filter(h => h.n <= 9), back = holes.filter(h => h.n > 9);
    const ranks = S.siRanks(holes);
    const holeRow = h => {
      const rank = ranks[holes.indexOf(h)];
      return `<tr><th>${h.n}</th><td class="mut">${h.par}</td><td class="mut">${h.si}</td>${ps.map(p => {
        const v = m[keyOf(p.id, h.n)];
        const recv = S.strokesReceived(p.handicap, rank, holes.length);
        const dots = recv > 0 ? `<i class="dots">${'•'.repeat(Math.min(recv, 3))}</i>` : '';
        return `<td>${dots}<span class="mark ${scoreClass(v, h.par)}">${v != null ? v : ''}</span></td>`;
      }).join('')}</tr>`;
    };
    const totRow = (label, list) => `<tr class="tot"><th>${label}</th><td class="mut">${parTotal(list)}</td><td></td>${ps.map(p => `<td>${sum(p.id, list)}</td>`).join('')}</tr>`;
    const board = boardOf(m, 'upfront');
    const netRow = `<tr class="tot net"><th>Net</th><td></td><td></td>${ps.map(p => { const r = board.find(b => b.player.id === p.id); return `<td class="${toParClass(r.upfront)}">${r.thru ? S.fmtToPar(r.upfront) : ''}</td>`; }).join('')}</tr>`;
    const ptsRow = `<tr class="tot"><th>Pts</th><td></td><td></td>${ps.map(p => { const r = board.find(b => b.player.id === p.id); return `<td>${r.thru ? r.points : ''}</td>`; }).join('')}</tr>`;
    return `
      ${picker}
      <div class="cardwrap players-${Math.min(ps.length, 5)}">
        <div class="card-head">
          <img src="radar.png" alt="Radar">
          <div><b>${esc(state.round.course_name)}</b><small>${cg === 'all' ? 'All players' : `Group ${cg}`} · ${esc(state.round.name || '')}${state.round.name ? ' · ' : ''}${new Date(state.round.created_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}</small></div>
        </div>
        <table class="sc-table">
          <thead><tr><th>Hole</th><th>Par</th><th>SI</th>${ps.map(p => `<th class="pn">${esc(p.name.split(' ')[0].slice(0, 9))}<small>${fmtHc(p.handicap)}</small></th>`).join('')}</tr></thead>
          <tbody>
            ${front.map(holeRow).join('')}
            ${back.length ? totRow('Out', front) + back.map(holeRow).join('') + totRow('In', back) : ''}
            ${totRow('Gross', holes)}
            ${netRow}${ptsRow}
          </tbody>
        </table>
      </div>
      <div class="legend"><span class="mark eagle">2</span>Eagle+ <span class="mark birdie">3</span>Birdie <span class="mark bogey">5</span>Bogey <span class="mark dbl">6</span>Double+ <span><i class="dots">••</i> shots received</span></div>
      <h2 class="sub">Players &amp; groups</h2>
      <div class="card">
        ${state.players.map(p => `
          <div class="prow">
            <span class="pname">${esc(p.name)}${p.id === state.meId ? ' <small class="muted">(you)</small>' : ''}</span>
            <input id="hc-${p.id}" class="input hc" inputmode="numeric" value="${fmtHc(p.handicap)}" data-f="editHc" data-p="${p.id}" aria-label="Handicap for ${esc(p.name)}">
            <select class="input grp" data-f="editGrp" data-p="${p.id}" aria-label="Group for ${esc(p.name)}">${Array.from({ length: Math.max(...nums, 0) + 1 }, (_, i) => i + 1).map(g => `<option value="${g}" ${grpOf(p) === g ? 'selected' : ''} ${g !== grpOf(p) && groupCount(g) >= MAX_GROUP ? 'disabled' : ''}>G${g}</option>`).join('')}</select>
            <button class="icon sm" data-a="rmPlayer" data-p="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>
          </div>`).join('')}
        <div class="row mt">
          <input id="addName" class="input" placeholder="Add player" autocomplete="off">
          <input id="addHc" class="input hc" placeholder="HC" inputmode="numeric">
          <button class="btn" data-a="addPlayer">Add</button>
        </div>
        <p class="muted">${cg === 'all' ? 'New players go into the first group with space.' : `New players go into Group ${cg}.`}</p><div>
        </div>
      </div>`;
  }

  function renderSheet() {
    const st = state.settings;
    const t = (k, label) => `<label class="toggle"><span>${label}</span><input type="checkbox" data-f="setting" data-k="${k}" ${st[k] ? 'checked' : ''}><i></i></label>`;
    const perm = 'Notification' in window ? Notification.permission : 'unsupported';
    return `
    <div class="scrim" data-a="closeSheet"></div>
    <div class="sheet" role="dialog" aria-label="Settings">
      <div class="grab"></div>
      <h2>Alerts</h2>
      ${t('alerts', 'Show alerts')}
      ${t('good', 'Birdies, eagles, aces')}
      ${t('lead', 'Lead changes')}
      ${t('blobs', 'Big numbers (triple bogey+)')}
      ${t('finish', 'Player finishes')}
      ${t('vibrate', 'Vibrate')}
      <div class="row between mt">
        <span>Phone notifications<br><small class="muted">${perm === 'granted' && st.notify ? 'On — when the app is in the background' : perm === 'denied' ? 'Blocked in browser settings' : perm === 'unsupported' ? 'Add to Home Screen first (iPhone)' : 'Off'}</small></span>
        ${perm === 'granted' ? t('notify', '') : `<button class="btn sm" data-a="enableNotify">Enable</button>`}
      </div>
      <h2>Round</h2>
      <button class="btn ghost" data-a="changeMe">Change who I am</button>
      <button class="btn ghost" data-a="home">Leave round</button>
      <button class="btn primary" data-a="closeSheet">Done</button>
    </div>`;
  }

  // ---------- actions ----------
  const actions = {
    home() {
      if (state.channel) { sb.removeChannel(state.channel); state.channel = null; }
      state.view = 'home'; state.round = null; state.sheet = false; state.error = ''; state.live = false;
      history.replaceState(null, '', location.pathname);
      render();
    },
    newRound() {
      state.error = '';
      state.setup = { name: '', players: [{ name: '', hc: '', grp: 1 }] };
      state.view = 'setup'; render();
    },
    addSetupPlayer() { const n = state.setup.players.length; state.setup.players.push({ name: '', hc: '', grp: Math.floor(n / MAX_GROUP) + 1 }); render(); },
    rmSetupPlayer(el) { state.setup.players.splice(+el.dataset.i, 1); render(); },
    async startRound() {
      const st = state.setup;
      state.error = '';
      const cname = COURSE.name;
      const holes = COURSE.holes.map(h => Object.assign({}, h));
      const players = st.players.map(p => ({ name: String(p.name || '').trim(), handicap: parseHc(p.hc), grp: Number(p.grp) || 1 })).filter(p => p.name || !Number.isNaN(p.handicap));
      if (!players.length) state.error = 'Add at least one player.';
      else if (players.some(p => !p.name)) state.error = 'Every player needs a name.';
      else if (players.some(p => Number.isNaN(p.handicap) || p.handicap < -10 || p.handicap > 54)) state.error = 'Handicaps must be whole numbers between +10 and 54.';
      else if ([...new Set(players.map(p => p.grp))].some(g => players.filter(p => p.grp === g).length > MAX_GROUP)) state.error = 'Groups can have at most 4 players.';
      if (state.error) { render(); return; }
      state.busy = true; render();
      try {
        let round = null;
        for (let i = 0; i < 5 && !round; i++) {
          const { data, error } = await sb.from('rounds').insert({ code: genCode(), name: String(st.name || '').trim(), course_name: cname, holes }).select().single();
          if (!error) round = data;
          else if (error.code !== '23505') throw error;
        }
        if (!round) throw new Error('code');
        const { error: pe } = await sb.from('players').insert(players.map(p => ({ round_id: round.id, name: p.name, handicap: p.handicap, grp: p.grp })));
        if (pe) throw pe;
        state.busy = false;
        await openRound(round.code);
      } catch (e) {
        state.busy = false;
        state.error = 'Couldn\'t create the round — check your signal and try again.';
        render();
      }
    },
    pickMe(el) {
      state.meId = el.dataset.id;
      store.set('gs:me:' + state.round.id, state.meId);
      state.hole = nextHoleFor(state.meId);
      state.view = 'round'; state.tab = 'score'; state.error = ''; render();
    },
    async addMe() {
      const name = document.getElementById('meName').value.trim();
      const handicap = parseHc(document.getElementById('meHc').value);
      if (!name || Number.isNaN(handicap) || handicap < -10 || handicap > 54) { state.error = 'Enter your name and a handicap between +10 and 54.'; render(); return; }
      const grp = state.joinGrp || defaultJoinGroup();
      if (groupCount(grp) >= MAX_GROUP) { state.error = `Group ${grp} is full — pick another.`; render(); return; }
      const { data, error } = await sb.from('players').insert({ round_id: state.round.id, name, handicap, grp }).select().single();
      if (error) { state.error = 'Couldn\'t add you — try again.'; render(); return; }
      if (!state.players.some(p => p.id === data.id)) state.players.push(data);
      actions.pickMe({ dataset: { id: data.id } });
    },
    spectate() {
      store.set('gs:spectate:' + state.round.id, true);
      state.meId = null; state.view = 'round'; state.tab = 'board'; render();
    },
    changeMe() {
      store.del('gs:me:' + state.round.id); store.del('gs:spectate:' + state.round.id);
      state.meId = null; state.sheet = false; state.view = 'who'; render();
    },
    async share() {
      const url = shareUrl(state.round.code);
      const text = `Join our round at ${state.round.course_name} — code ${state.round.code}`;
      if (navigator.share) { try { await navigator.share({ title: 'Radar', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
      try { await navigator.clipboard.writeText(url); toast('Link copied', url); } catch (e) { toast('Round code', state.round.code); }
    },
    tab(el) { state.tab = el.dataset.v; render(); window.scrollTo(0, 0); },
    mode(el) { state.mode = el.dataset.v; store.set('gs:mode', state.mode); render(); },
    scope(el) { state.scope = el.dataset.v; store.set('gs:scope', state.scope); render(); },
    toggleAdd(el, e) { e.preventDefault(); state.openAdd = !state.openAdd; render(); if (state.openAdd) { const i = document.getElementById('ptName'); if (i) i.focus(); } },
    async addPartner() {
      const name = document.getElementById('ptName').value.trim();
      const handicap = parseHc(document.getElementById('ptHc').value);
      const grp = myGroup();
      if (!name || Number.isNaN(handicap) || handicap < -10 || handicap > 54) { toast('Check the details', 'Name and a handicap between +10 and 54.', 'blob'); return; }
      if (groupCount(grp) >= MAX_GROUP) { toast(`Group ${grp} is full`, '', 'blob'); return; }
      const { data, error } = await sb.from('players').insert({ round_id: state.round.id, name, handicap, grp }).select().single();
      if (error) { toast('Not added', 'Try again.', 'blob'); return; }
      if (!state.players.some(p => p.id === data.id)) state.players.push(data);
      state.openAdd = false;
      toast(`${name} added to Group ${grp}`, 'You can score for them on this screen.');
      render();
    },
    joinGrp(el) { state.joinGrp = +el.dataset.v; render(); },
    cardGrp(el) { state.cardGrp = el.dataset.v === 'all' ? 'all' : +el.dataset.v; render(); },
    goHole(el) { state.hole = +el.dataset.v; render(); },
    prevHole() { const hs = state.round.holes, i = hs.findIndex(h => h.n === state.hole); if (i > 0) { state.hole = hs[i - 1].n; render(); } },
    nextHole() { const hs = state.round.holes, i = hs.findIndex(h => h.n === state.hole); if (i < hs.length - 1) { state.hole = hs[i + 1].n; render(); window.scrollTo(0, 0); } },
    tapScore(el) {
      const h = holeByN(state.hole), m = mergedMap(), v = m[keyOf(el.dataset.p, h.n)];
      if (v == null) setScore(el.dataset.p, h.n, h.par);
      else if (confirm('Clear this score?')) setScore(el.dataset.p, h.n, null);
    },
    inc(el) { const h = holeByN(state.hole), v = mergedMap()[keyOf(el.dataset.p, h.n)]; setScore(el.dataset.p, h.n, Math.min(20, v == null ? h.par + 1 : v + 1)); },
    dec(el) { const h = holeByN(state.hole), v = mergedMap()[keyOf(el.dataset.p, h.n)]; setScore(el.dataset.p, h.n, Math.max(1, v == null ? h.par - 1 : v - 1)); },
    async addPlayer() {
      const name = document.getElementById('addName').value.trim();
      const handicap = parseHc(document.getElementById('addHc').value);
      if (!name || Number.isNaN(handicap) || handicap < -10 || handicap > 54) { toast('Check the details', 'Name and a handicap between +10 and 54.', 'blob'); return; }
      let grp = typeof state.cardGrp === 'number' && groupNums().includes(state.cardGrp) ? state.cardGrp : (myGroup() || defaultJoinGroup());
      if (groupCount(grp) >= MAX_GROUP) grp = defaultJoinGroup();
      const { data, error } = await sb.from('players').insert({ round_id: state.round.id, name, handicap, grp }).select().single();
      if (error) { toast('Not added', 'Try again.', 'blob'); return; }
      if (!state.players.some(p => p.id === data.id)) state.players.push(data);
      document.getElementById('addName').value = ''; document.getElementById('addHc').value = '';
      render();
    },
    async rmPlayer(el) {
      const p = state.players.find(x => x.id === el.dataset.p);
      if (!p || !confirm(`Remove ${p.name} and their scores?`)) return;
      const { error } = await sb.from('players').delete().eq('id', p.id);
      if (error) { toast('Not removed', 'Try again.', 'blob'); return; }
      state.players = state.players.filter(x => x.id !== p.id);
      Object.keys(state.confirmed).forEach(k => { if (k.startsWith(p.id + ':')) delete state.confirmed[k]; });
      if (state.meId === p.id) { state.meId = null; store.del('gs:me:' + state.round.id); }
      render();
    },
    openSheet() { state.sheet = true; render(); },
    closeSheet() { state.sheet = false; render(); },
    enableNotify() { enableNotifications(); }
  };

  $app.addEventListener('click', e => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.a];
    if (fn) { e.preventDefault(); fn(el, e); }
  });

  // Form fields update state without re-rendering so typing isn't interrupted.
  $app.addEventListener('input', e => {
    const el = e.target, f = el.dataset && el.dataset.f;
    if (!f || !state.setup) return;
    const st = state.setup, i = +el.dataset.i;
    if (f === 'name') st.name = el.value;
    else if (f === 'pname') st.players[i].name = el.value;
    else if (f === 'phc') st.players[i].hc = el.value;
  });

  $app.addEventListener('change', async e => {
    const el = e.target, f = el.dataset && el.dataset.f;
    if (!f) return;
    if (f === 'setting') {
      state.settings[el.dataset.k] = el.checked;
      store.set('gs:settings', state.settings);
      render();
    } else if (f === 'pgrp') {
      state.setup.players[+el.dataset.i].grp = +el.value;
    } else if (f === 'editGrp') {
      const p = state.players.find(x => x.id === el.dataset.p);
      const g = +el.value;
      if (!p) return;
      if (groupCount(g) >= MAX_GROUP) { toast(`Group ${g} is full`, '', 'blob'); render(); return; }
      const { error } = await sb.from('players').update({ grp: g }).eq('id', p.id);
      if (error) { toast('Not saved', 'Try again.', 'blob'); render(); return; }
      p.grp = g; render();
    } else if (f === 'editHc') {
      const hc = parseHc(el.value);
      const p = state.players.find(x => x.id === el.dataset.p);
      if (!p) return;
      if (Number.isNaN(hc) || hc < -10 || hc > 54) { el.value = fmtHc(p.handicap); toast('Handicap must be +10 to 54', '', 'blob'); return; }
      const { error } = await sb.from('players').update({ handicap: hc }).eq('id', p.id);
      if (error) { toast('Not saved', 'Try again.', 'blob'); el.value = fmtHc(p.handicap); return; }
      p.handicap = hc; render();
    }
  });

  $app.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.id === 'joinCode') actions.join();
    else if (e.target.id === 'meHc' || e.target.id === 'meName') actions.addMe();
    else if (e.target.id === 'addHc' || e.target.id === 'addName') actions.addPlayer();
    else if (e.target.id === 'ptHc' || e.target.id === 'ptName') actions.addPartner();
  });

  // Catch up on anything missed while the phone was locked.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.view === 'round') resync(); });
  window.addEventListener('online', () => { Object.keys(state.local).forEach(k => { const i = k.lastIndexOf(':'); saveScore(k.slice(0, i), Number(k.slice(i + 1))); }); resync(); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(r => { swReg = r; }).catch(() => {});
  }

  const code = new URLSearchParams(location.search).get('r');
  render();
  if (code) openRound(code);
})();
