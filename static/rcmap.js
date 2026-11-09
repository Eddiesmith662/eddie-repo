/* Race control's Map tab: iRacing's official track map with every car on it (plan doc, race control; Nov 7 2026).

The map for the session's track (by iRacing's track id, static/trackmaps.json) is loaded from iRacing's public server
when the race opens, never copied here. Its layers: background, inactive, active (the track: a filled ribbon between
its two edges), pitroad, start-finish (the line, and an arrow for the direction of travel) and turns (corner numbers).

Each car's place on the lap (0 to 1 from the start/finish line, from iRacing) becomes a point on the track's centre
line, worked out from the ribbon's two edges. The start/finish line sets where 0 is, and its arrow which way the cars
run. Cars on pit road are drawn on the pit lane, beside where they are on the lap; a stopped or slow car (an incident in the queue in the last 30 seconds)
flashes; open incidents and the last two laps' incidents are marked where they happened.

window.RCMap.mount(el, {onCar(idx), onIncident(id)}) then RCMap.update(live, rc) on every reading.
RCMap.geometry(layers), RCMap.at and RCMap.onPitRoad are the maths on their own, for the tests. */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const LAYERS = ['background', 'inactive', 'active', 'pitroad', 'start-finish', 'turns'];
  const N = 1000;                       // centre line points
  const FLASH_S = 30;                   // an incident flashes its car for this long
  const FLASH = new Set(['stopped', 'slow', 'spin', 'contact', 'multi', 'wall', 'offtrack', 'mechanical']);
  const st = { el: null, opts: {}, list: null, trackId: null, loading: null, geo: null, svg: null, cars: null, marks: null, msg: null };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- geometry: the track's centre line, start/finish and direction ---------- */
  function scratch() {                  // a hidden 1920x1080 drawing to measure paths in, at iRacing's own scale
    let s = document.getElementById('rcmap-scratch');
    if (!s) {
      s = document.createElementNS(NS, 'svg');
      s.id = 'rcmap-scratch';
      s.setAttribute('width', '1920'); s.setAttribute('height', '1080'); s.setAttribute('viewBox', '0 0 1920 1080');
      s.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden';
      document.body.appendChild(s);
    }
    return s;
  }
  function shapes(svgText) {            // the drawable elements of one layer, placed in the scratch drawing
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const g = document.createElementNS(NS, 'g');
    [...doc.documentElement.childNodes].forEach(n => g.appendChild(document.importNode(n, true)));
    scratch().appendChild(g);
    return { g, els: [...g.querySelectorAll('path,polygon,polyline,rect,line,circle,ellipse')] };
  }
  function pointsOf(el, n) {            // points along an element, in drawing coordinates (its transform applied)
    const m = el.getCTM();
    const tf = p => { const q = scratch().createSVGPoint(); q.x = p.x; q.y = p.y; const r = m ? q.matrixTransform(m) : q; return { x: r.x, y: r.y }; };
    const len = el.getTotalLength ? el.getTotalLength() : 0;
    if (len > 0) return Array.from({ length: n + 1 }, (_, i) => tf(el.getPointAtLength(len * i / n)));
    const b = el.getBBox();
    return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y }, { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }].map(tf);
  }
  const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
  function splitLoops(pts) {            // a path drawn as several loops (the ribbon's edges): split where it jumps
    const steps = pts.slice(1).map((p, i) => Math.sqrt(d2(p, pts[i])));
    const med = steps.slice().sort((a, b) => a - b)[Math.floor(steps.length / 2)] || 1;
    const loops = [[pts[0]]];
    steps.forEach((s, i) => { if (s > med * 25 && s > 15) loops.push([]); loops[loops.length - 1].push(pts[i + 1]); });
    return loops.filter(l => l.length > 20);
  }
  function resample(line, n, closed) {  // n points evenly spaced along a line
    const pts = closed ? line.concat([line[0]]) : line;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.sqrt(d2(pts[i], pts[i - 1])));
    const total = cum[cum.length - 1], out = [];
    let j = 0;
    for (let k = 0; k < n; k++) {
      const at = total * k / n;
      while (j < cum.length - 2 && cum[j + 1] < at) j++;
      const f = (at - cum[j]) / ((cum[j + 1] - cum[j]) || 1);
      out.push({ x: pts[j].x + (pts[j + 1].x - pts[j].x) * f, y: pts[j].y + (pts[j + 1].y - pts[j].y) * f });
    }
    return { pts: out, length: total };
  }
  function nearest(line, p) { let bi = 0, bd = Infinity; line.forEach((q, i) => { const d = d2(q, p); if (d < bd) { bd = d; bi = i; } }); return { i: bi, d: Math.sqrt(bd) }; }
  function centreLine(activeText) {
    const { g, els } = shapes(activeText);
    let loops = [];
    els.forEach(el => { loops = loops.concat(splitLoops(pointsOf(el, 4000))); });
    g.remove();
    if (!loops.length) return null;
    loops.sort((a, b) => b.length - a.length);
    const a = resample(loops[0], N, true).pts;
    if (loops.length < 2) return a;      // drawn as a single line: that is the centre line
    const b = resample(loops[1], N * 2, true).pts;
    return resample(a.map(p => { const q = b[nearest(b, p).i]; return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; }), N, true).pts;
  }
  function startFinish(sfText, line) {  // -> {i0: index of the line on the centre line, dir: +1 or -1}
    const { g, els } = shapes(sfText);
    const parts = els.map(el => {
      const pts = pointsOf(el, 60);
      const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
      return { pts, c, near: nearest(line, c) };
    });
    g.remove();
    if (!parts.length) return { i0: 0, dir: 1, sure: false };
    parts.sort((x, y) => x.near.d - y.near.d);
    const sf = parts[0], i0 = sf.near.i;
    const tan = { x: line[(i0 + 3) % N].x - line[(i0 - 3 + N) % N].x, y: line[(i0 + 3) % N].y - line[(i0 - 3 + N) % N].y };
    const arrow = parts[1];
    if (!arrow) return { i0, dir: 1, sure: false };
    // the arrow's tip is its point furthest from its middle: which way along the track does it point?
    const tip = arrow.pts.reduce((best, p) => d2(p, arrow.c) > d2(best, arrow.c) ? p : best, arrow.pts[0]);
    const dot = (tip.x - arrow.c.x) * tan.x + (tip.y - arrow.c.y) * tan.y;
    return { i0, dir: dot >= 0 ? 1 : -1, sure: Math.abs(dot) > 1e-6 };
  }
  // Pit road. iRacing reports a car in the pits by how far round the lap it is, the same as on track, so on its own
  // the dot sits on the track beside its pit box. iRacing's pitroad layer draws the pit lane as a dashed line (older
  // maps: each dash its own small shape; newer ones such as Charlotte 2025: one dashed line), an arrow at pit entry,
  // and the blue merge lane at pit exit in a group named Mergeline; a few (Nashville, Atlanta 2022, Spielberg,
  // Chicago, Coronado) draw all the dashes as one shape. The pit lane is everything but the merge lane and the arrow
  // (a small, compact shape: under 100 map pixels across, unlike a lane drawn as one shape). Each pit lane point gets
  // a lap position (where it is beside the track), and a car on pit road goes between the pit lane points either side
  // of its own lap position. That covers the gaps between the dashes, and a pit lane that runs straight where the
  // track bends away from it (Phoenix's dogleg); where two pit lanes share lap positions, the one nearer the car is
  // used. Just past the end of the drawn lane the car waits at its end: at Phoenix (Nov 8, 2026, practice) cars park
  // in stalls up to 0.03 of a lap beyond where iRacing's drawing stops. The first version (one nearest point, only if
  // beside the car) left cars on the track in the gaps between dashes and past the start/finish line there, so a car
  // driving down pit road flicked between the two.
  const PIT_SNAP = 200;                 // a pit lane point further than this from the track (map pixels) isn't used
  const PIT_REACH = 0.03;               // lap positions: how far before or after the car a pit lane point is looked for
  const PIT_LANE = 60;                  // map pixels: pit lane points this much further away than the nearest are another lane
  function pitLane(pitText) {
    const { g, els } = shapes(pitText);
    let pts = [];
    els.forEach(el => {
      for (let a = el.parentElement; a && a !== g; a = a.parentElement) if (/merge/i.test(a.id || '')) return;
      const style = (el.getAttribute('style') || '').replace(/\s/g, '');
      const open = el.getAttribute('fill') === 'none' || /fill:none/.test(style);     // a drawn line, not a filled shape
      const len = el.getTotalLength ? el.getTotalLength() : 0, box = el.getBBox();
      if (!open && len > 110 && Math.max(box.width, box.height) < 100) return;           // the entry arrow, not the lane
      pts = pts.concat(pointsOf(el, len > 110 ? Math.round(len / 4) : 12));
    });
    g.remove();
    return pts.length >= 8 ? pts : null;
  }
  const lapDiff = (a, b) => ((a - b) % 1 + 1.5) % 1 - 0.5;         // -0.5..0.5, across the line
  function pitLapPositions(geo) {       // each pit lane point, with where it is on the lap
    return geo.pit.map(p => { const n = nearest(geo.line, p); return { x: p.x, y: p.y, lp: ((((n.i - geo.i0) * geo.dir) % N + N) % N) / N, d: n.d }; })
      .filter(q => q.d <= PIT_SNAP);
  }
  function onPitRoad(geo, lapPos) {     // a car on pit road: lap position -> a point on the pit lane beside it
    const p = at(geo, lapPos);
    if (!geo.pitLp || !geo.pitLp.length) return p;
    const near = geo.pitLp.map(q => ({ q, dl: lapDiff(q.lp, lapPos), dd: Math.hypot(q.x - p.x, q.y - p.y) }))
      .filter(o => Math.abs(o.dl) <= PIT_REACH);
    if (!near.length) return p;
    const closest = Math.min(...near.map(o => o.dd));
    let before = null, after = null;
    near.forEach(o => {
      if (o.dd > closest + PIT_LANE) return;                       // another pit lane (Bristol's dual pit roads)
      if (o.dl <= 0 && (!before || o.dl > before.dl)) before = o;
      if (o.dl > 0 && (!after || o.dl < after.dl)) after = o;
    });
    if (before && after) {
      const t = -before.dl / ((after.dl - before.dl) || 1);
      return { x: before.q.x + (after.q.x - before.q.x) * t, y: before.q.y + (after.q.y - before.q.y) * t };
    }
    const end = before || after;                                   // past one end of the drawn lane: wait at its end
    return { x: end.q.x, y: end.q.y };
  }
  // A few maps draw the start/finish layer as a single arrow beside the track (Phoenix 2021, Kansas, Nashville,
  // Spielberg, Hungaroring and others, Nov 8, 2026), and its shape doesn't show which way along the track it points.
  // For those the track list says which way the cars run as seen on the map ("runs": "clockwise" or "anticlockwise").
  function runsWay(line, i0, dir) {     // the way the cars go round, as seen on the map
    let a = 0;
    for (let k = 0; k < N; k++) { const p = line[((i0 + dir * k) % N + N) % N], q = line[((i0 + dir * (k + 1)) % N + N) % N]; a += p.x * q.y - q.x * p.y; }
    return a > 0 ? 'clockwise' : 'anticlockwise';                  // the map's y runs downwards
  }
  function geometry(layers, runs) {
    const line = centreLine(layers.active);
    if (!line) return null;
    const sf = layers['start-finish'] ? startFinish(layers['start-finish'], line) : { i0: 0, dir: 1, sure: false };
    if (!sf.sure && (runs === 'clockwise' || runs === 'anticlockwise')) {
      sf.dir = runsWay(line, sf.i0, 1) === runs ? 1 : -1;
      sf.sure = true;
    }
    const geo = { line, i0: sf.i0, dir: sf.dir, sure: sf.sure, pit: layers.pitroad ? pitLane(layers.pitroad) : null };
    geo.pitLp = geo.pit ? pitLapPositions(geo) : null;
    return geo;
  }
  function at(geo, lapPos) {            // lap position 0..1 -> a point on the map
    const p = ((lapPos % 1) + 1) % 1;
    return geo.line[((geo.i0 + geo.dir * Math.round(p * N)) % N + N) % N];
  }

  /* ---------- drawing ---------- */
  function message(text) {
    st.el.innerHTML = `<div class="rcmap-msg">${text}</div>`;
    st.svg = st.cars = st.marks = null;
  }
  async function load(trackId) {
    st.trackId = trackId; st.geo = null;
    if (!trackId) return message('Waiting for iRacing');
    try { st.list = st.list || await (await fetch('/static/trackmaps.json')).json(); } catch (e) { return message('Couldn’t read the track list'); }
    const t = st.list.tracks[String(trackId)];
    if (!t) return message(`No map for this track yet (iRacing track ${esc(trackId)}).<br><span>Add it to static/trackmaps.json: one line.</span>`);
    message(`Loading iRacing’s map of ${esc(t.name)}…`);
    const want = trackId;
    const layers = {};
    try {
      await Promise.all(LAYERS.map(async n => {
        const r = await fetch(st.list.base + t.folder + '/' + n + '.svg');
        if (r.ok) layers[n] = await r.text(); else if (n === 'active') throw new Error('HTTP ' + r.status);
      }));
    } catch (e) {
      return message(`Couldn’t load iRacing’s map of ${esc(t.name)} (${esc(e.message)}). Is this PC online?`);
    }
    if (st.trackId !== want) return;       // the track changed while it loaded
    const geo = geometry(layers, t.runs);
    if (!geo) return message(`iRacing’s map of ${esc(t.name)} has no track line to put cars on.`);
    st.geo = geo; st.name = t.name;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 1920 1080'); svg.setAttribute('class', 'rcmap-svg');
    LAYERS.forEach(n => {
      if (!layers[n]) return;
      const doc = new DOMParser().parseFromString(layers[n], 'image/svg+xml');
      const g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'L-' + n);
      [...doc.documentElement.childNodes].forEach(c => g.appendChild(document.importNode(c, true)));
      svg.appendChild(g);
    });
    st.marks = document.createElementNS(NS, 'g'); st.marks.setAttribute('class', 'rcmap-marks'); svg.appendChild(st.marks);
    st.cars = document.createElementNS(NS, 'g'); st.cars.setAttribute('class', 'rcmap-cars'); svg.appendChild(st.cars);
    st.el.innerHTML = ''; st.el.appendChild(svg); st.svg = svg; st.dots = {};
    if (!geo.sure) console.warn('Race control map: couldn’t tell which way the cars run at ' + t.name + ' (iRacing track ' + trackId + '): add "runs" to its line in static/trackmaps.json');
  }
  function dot(c) {
    let g = st.dots[c.idx];
    if (!g) {
      g = document.createElementNS(NS, 'g'); g.setAttribute('class', 'car'); g.dataset.idx = c.idx;
      g.innerHTML = '<circle r="17"></circle><text text-anchor="middle" dy="6"></text>';
      st.cars.appendChild(g); st.dots[c.idx] = g;
    }
    return g;
  }
  function update(live, rc) {
    if (!st.el) return;
    const tid = live && live.connected ? live.trackId : null;
    if (tid !== st.trackId) { st.loading = load(tid); return; }
    if (!st.geo || !st.svg) return;
    const now = live.sessTime || 0, seen = new Set();
    const flash = new Set((rc.queue || []).filter(q => FLASH.has(q.type) && q.t != null && now - q.t >= 0 && now - q.t < FLASH_S).map(q => q.idx));
    (live.cars || []).forEach(c => {
      if (c.progress == null || c.onTrack === false && !c.pit) return;
      const p = c.pit ? onPitRoad(st.geo, c.progress) : at(st.geo, c.progress), g = dot(c);
      seen.add(String(c.idx));
      g.setAttribute('transform', `translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`);
      g.querySelector('text').textContent = c.num;
      g.classList.toggle('cam', c.idx === live.camCarIdx);
      g.classList.toggle('pit', !!c.pit);
      g.classList.toggle('bf', !!c.blackFlag);
      g.classList.toggle('flash', flash.has(c.idx));
    });
    Object.keys(st.dots).forEach(k => { if (!seen.has(k)) { st.dots[k].remove(); delete st.dots[k]; } });
    // the camera car on top
    const cam = st.dots[live.camCarIdx]; if (cam && cam !== st.cars.lastChild) st.cars.appendChild(cam);
    // incidents: still to review, or from the last two laps (under caution, the wreck stays marked)
    const lap = live.lap || 0;
    const marks = (rc.queue || []).filter(q => q.lapPos != null && q.status !== 'logged' &&
      (q.status === 'new' || q.status === 'reviewing' || (q.lap != null && lap - q.lap <= 1) || live.flag === 'caution' && q.lap != null && lap - q.lap <= 3));
    const html = marks.map(q => { const p = at(st.geo, q.lapPos);
      return `<g class="mark ${esc(q.status)}" data-id="${esc(q.id)}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})"><title>${esc(q.type)} · #${esc(q.num)} ${esc(q.name)} · L${esc(q.lap)}</title><path d="M0,-34 L22,4 L-22,4 Z"></path><text text-anchor="middle" dy="-4">!</text></g>`; }).join('');
    if (st.marks._h !== html) { st.marks._h = html; st.marks.innerHTML = html; }
  }
  function mount(el, opts) {
    st.el = el; st.opts = opts || {}; st.trackId = undefined;
    el.addEventListener('click', e => {
      const m = e.target.closest('.mark'); if (m && st.opts.onIncident) return st.opts.onIncident(m.dataset.id);
      const c = e.target.closest('.car'); if (c && st.opts.onCar) st.opts.onCar(+c.dataset.idx);
    });
    message('Waiting for iRacing');
  }
  window.RCMap = { mount, update, geometry: (layers, runs) => geometry(layers, runs), at, onPitRoad, runsWay, N };
})();
