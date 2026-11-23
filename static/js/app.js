/* ── Map setup ──────────────────────────────────────────────────── */
const map = L.map('map', {
  center: [54.5, 18.5],
  zoom: 5,
  zoomControl: true,
});

// Nautical-style tile layer (OpenSeaMap on top of OSM)
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
}).addTo(map);

L.tileLayer('https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png', {
  opacity: 0.6,
  maxZoom: 18,
}).addTo(map);

// Track colors — one per voyage, cycled
const TRACK_COLORS = [
  '#00b4d8', '#48cae4', '#c9a84c', '#e8c97e',
  '#4cc9f0', '#f72585', '#7209b7', '#3a86ff',
  '#06d6a0', '#ffd166',
];

let voyages = [];          // raw list from API
let trackLayers = {};      // voyageId → Leaflet layer group
let voyageColors = {};     // voyageId → assigned color (persistent)
let activeVoyageId = null;
let colorIndex = 0;

/* ── Load everything on start ───────────────────────────────────── */
async function init() {
  await loadStats();
  await loadVoyages();
}

async function loadStats() {
  try {
    const r = await fetch('/api/stats');
    const s = await r.json();
    document.getElementById('stat-voyages').textContent = s.voyage_count ?? 0;
    document.getElementById('stat-nm').textContent = (s.total_nm ?? 0).toFixed(1);
    document.getElementById('stat-hours').textContent = (s.total_hours ?? 0).toFixed(1);
  } catch (e) { console.error(e); }
}

async function loadVoyages() {
  try {
    const r = await fetch('/api/voyages');
    voyages = await r.json();
    renderVoyageList();
    for (const v of voyages) await loadTrack(v);
  } catch (e) { console.error(e); }
}

/* ── Render sidebar list ────────────────────────────────────────── */
function renderVoyageList() {
  const el = document.getElementById('voyage-list');
  if (voyages.length === 0) {
    el.innerHTML = '<div class="empty-state">No voyages yet.<br/>Log your first passage!</div>';
    return;
  }
  el.innerHTML = voyages.map(v => {
    const route = [v.start_port, v.end_port].filter(Boolean).join(' → ') || '—';
    return `
      <div class="voyage-card" id="card-${v.id}" onclick="selectVoyage('${v.id}')">
        <button class="vc-del" title="Delete" onclick="deleteVoyage(event,'${v.id}')">✕</button>
        <div class="vc-title">${esc(v.title)}</div>
        <div class="vc-meta">${v.date}${v.boat ? ' · ' + esc(v.boat) : ''}</div>
        ${route !== '—' ? `<div class="vc-route">⚓ ${esc(route)}</div>` : ''}
        <div class="vc-stats">
          <span class="vc-stat"><strong>${v.distance_nm?.toFixed(1) ?? 0}</strong> NM</span>
          <span class="vc-stat"><strong>${v.duration_h?.toFixed(1) ?? 0}</strong> h</span>
        </div>
      </div>`;
  }).join('');
}

/* ── Load GPX track onto map ────────────────────────────────────── */
async function loadTrack(v) {
  if (trackLayers[v.id]) return;   // already loaded
  // Assign a stable color — reuse if this voyage was seen before
  if (!voyageColors[v.id]) {
    voyageColors[v.id] = TRACK_COLORS[colorIndex++ % TRACK_COLORS.length];
  }
  const color = voyageColors[v.id];

  try {
    const r = await fetch(`/api/voyages/${v.id}`);
    const data = await r.json();

    if (!data.track || !data.track.points || data.track.points.length < 2) return;

    const pts = data.track.points.map(p => [p.lat, p.lng]);
    const layer = L.featureGroup();

    // Main track polyline
    L.polyline(pts, {
      color,
      weight: 3,
      opacity: 0.85,
      lineJoin: 'round',
    }).addTo(layer);

    // Start / end markers
    const startIcon = makeIcon('🟢', color);
    const endIcon   = makeIcon('🔴', color);
    L.marker(pts[0], { icon: startIcon })
      .bindPopup(`<b>${esc(v.title)}</b><br/>Start: ${esc(v.start_port || '—')}`)
      .addTo(layer);
    L.marker(pts[pts.length - 1], { icon: endIcon })
      .bindPopup(`<b>${esc(v.title)}</b><br/>End: ${esc(v.end_port || '—')}`)
      .addTo(layer);

    // Waypoints
    if (data.track.waypoints) {
      for (const wp of data.track.waypoints) {
        L.circleMarker([wp.lat, wp.lng], { radius: 5, color, fillOpacity: .8 })
          .bindPopup(wp.name || 'Waypoint')
          .addTo(layer);
      }
    }

    layer.addTo(map);
    trackLayers[v.id] = layer;

  } catch (e) { console.error('Track load failed', v.id, e); }
}

function makeIcon(emoji, color) {
  return L.divIcon({
    className: '',
    html: `<div style="font-size:18px;filter:drop-shadow(0 0 4px ${color});">${emoji}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

/* ── Select & highlight a voyage ────────────────────────────────── */
async function selectVoyage(id) {
  // De-select previous
  document.querySelectorAll('.voyage-card').forEach(c => c.classList.remove('active'));

  if (activeVoyageId === id) {
    activeVoyageId = null;
    closeDetail();
    resetTrackStyles();
    return;
  }

  activeVoyageId = id;
  document.getElementById(`card-${id}`)?.classList.add('active');

  resetTrackStyles();

  const layer = trackLayers[id];
  if (layer) map.fitBounds(layer.getBounds(), { padding: [60, 60] });

  // Show detail panel
  const v = voyages.find(x => x.id === id);
  if (v) showDetail(v);
}

function resetTrackStyles() {
  for (const [id, layer] of Object.entries(trackLayers)) {
    const isActive = id === activeVoyageId;
    layer.eachLayer(l => {
      if (l instanceof L.Polyline) {
        l.setStyle({
          color:   voyageColors[id] || '#00b4d8',
          weight:  isActive ? 6 : 3,
          opacity: 0.85,
        });
      }
    });
    // Bring active track to front so it renders on top
    if (isActive) layer.eachLayer(l => l.bringToFront?.());
  }
}

/* ── Detail panel ───────────────────────────────────────────────── */
function showDetail(v) {
  const panel = document.getElementById('detail-panel');
  const content = document.getElementById('detail-content');

  const rows = [
    ['Date', v.date],
    ['Boat', v.boat || '—'],
    ['From', v.start_port || '—'],
    ['To', v.end_port || '—'],
    ['Distance', `${(v.distance_nm||0).toFixed(2)} NM`],
    ['Duration', `${(v.duration_h||0).toFixed(1)} h`],
    ['Crew', v.crew || '—'],
  ];

  content.innerHTML = `
    <h3>${esc(v.title)}</h3>
    ${rows.map(([l,val]) => `
      <div class="detail-row">
        <span class="lbl">${l}</span>
        <span class="val">${esc(String(val))}</span>
      </div>`).join('')}
    ${v.notes ? `<div class="detail-notes">${esc(v.notes)}</div>` : ''}
  `;
  panel.classList.remove('hidden');
}

function closeDetail() {
  document.getElementById('detail-panel').classList.add('hidden');
  activeVoyageId = null;
  document.querySelectorAll('.voyage-card').forEach(c => c.classList.remove('active'));
  resetTrackStyles();
}

/* ── Delete voyage ──────────────────────────────────────────────── */
async function deleteVoyage(e, id) {
  e.stopPropagation();
  if (!confirm('Delete this voyage entry?')) return;

  const r = await fetch(`/api/voyages/${id}`, { method: 'DELETE' });
  if (r.ok) {
    if (trackLayers[id]) { map.removeLayer(trackLayers[id]); delete trackLayers[id]; }
    voyages = voyages.filter(v => v.id !== id);
    if (activeVoyageId === id) closeDetail();
    renderVoyageList();
    loadStats();
    colorIndex = Math.max(0, colorIndex - 1);
  }
}

/* ── Modal form ─────────────────────────────────────────────────── */
function openForm() {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('f-date').value = new Date().toISOString().slice(0, 10);
}

function closeForm(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.add('hidden');
  resetForm();
}

function resetForm() {
  ['f-title','f-date','f-boat','f-crew','f-start','f-end','f-nm','f-hours','f-notes'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('f-gpx').value = '';
  document.getElementById('gpx-drop-text').textContent = '📂 Click or drag & drop a .gpx file';
  document.getElementById('gpx-drop').classList.remove('has-file');
}

async function handleGpxSelect(input) {
  const file = input.files[0];
  if (!file) return;

  document.getElementById('gpx-drop-text').textContent = `✅ ${file.name}`;
  document.getElementById('gpx-drop').classList.add('has-file');

  // Parse GPX client-side to pre-fill miles & hours
  try {
    const text = await file.text();
    const xml = new DOMParser().parseFromString(text, "application/xml");

    // Collect all lat/lng points from <trkpt> and <rtept>
    const pts = [...xml.querySelectorAll("trkpt, rtept")].map(el => ({
      lat: parseFloat(el.getAttribute("lat")),
      lng: parseFloat(el.getAttribute("lon")),
    }));

    if (pts.length >= 2) {
      const distM = pts.reduce((sum, pt, i) => {
        if (i === 0) return 0;
        return sum + haversineM(pts[i - 1], pt);
      }, 0);
      const nm = (distM / 1852).toFixed(2);
      const nmField = document.getElementById('f-nm');
      nmField.value = nm;
      nmField.classList.add('autofilled');
      setTimeout(() => nmField.classList.remove('autofilled'), 1800);
    }

    // Duration from first/last timestamp
    const times = [...xml.querySelectorAll("trkpt time, rtept time")]
      .map(el => new Date(el.textContent.trim()))
      .filter(d => !isNaN(d));
    if (times.length >= 2) {
      const hours = ((times.at(-1) - times[0]) / 3_600_000).toFixed(2);
      const hField = document.getElementById('f-hours');
      hField.value = hours;
      hField.classList.add('autofilled');
      setTimeout(() => hField.classList.remove('autofilled'), 1800);
    }
  } catch (e) {
    console.warn('GPX client-side parse failed:', e);
  }
}

function haversineM(p1, p2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(p2.lat - p1.lat);
  const dLng = toRad(p2.lng - p1.lng);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(p1.lat)) * Math.cos(toRad(p2.lat)) * Math.sin(dLng/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

async function submitVoyage() {
  const title = document.getElementById('f-title').value.trim();
  const date  = document.getElementById('f-date').value;
  if (!title || !date) { alert('Title and date are required.'); return; }

  const fd = new FormData();
  fd.append('title',       title);
  fd.append('date',        date);
  fd.append('boat',        document.getElementById('f-boat').value);
  fd.append('crew',        document.getElementById('f-crew').value);
  fd.append('start_port',  document.getElementById('f-start').value);
  fd.append('end_port',    document.getElementById('f-end').value);
  fd.append('distance_nm', document.getElementById('f-nm').value || '0');
  fd.append('duration_h',  document.getElementById('f-hours').value || '0');
  fd.append('notes',       document.getElementById('f-notes').value);

  const gpxInput = document.getElementById('f-gpx');
  if (gpxInput.files[0]) fd.append('gpx_file', gpxInput.files[0]);

  const btn = document.querySelector('.btn-save');
  btn.textContent = 'Saving…';
  btn.disabled = true;

  try {
    const r = await fetch('/api/voyages', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();

    // Reload list & add track
    const r2 = await fetch('/api/voyages');
    voyages = await r2.json();
    renderVoyageList();
    loadStats();

    const newVoyage = voyages.find(v => v.id === data.id);
    if (newVoyage) await loadTrack(newVoyage);

    closeForm();
    resetForm();
    if (data.id) selectVoyage(data.id);
  } catch (e) {
    alert('Error saving voyage: ' + e.message);
  } finally {
    btn.textContent = 'Save Voyage';
    btn.disabled = false;
  }
}

/* ── Drag & drop GPX ────────────────────────────────────────────── */
const drop = document.getElementById('gpx-drop');
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.gpx')) {
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById('f-gpx').files = dt.files;
    handleGpxSelect(document.getElementById('f-gpx'));
  }
});

/* ── Helpers ────────────────────────────────────────────────────── */
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

init();