import type * as GeoJSON from 'geojson';
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import {
  YEAR_MAX,
  YEAR_MIN,
  activeRecords,
  displayRecord,
  parseData,
  statusAt,
  yearLabel,
  type DataFile,
  type Station,
} from './model';

const REGIONS: Record<string, LngLatBoundsLike> = {
  all: [
    [139.3, 41.3],
    [145.9, 45.6],
  ],
  tokachi: [
    [142.6, 42.25],
    [143.9, 43.6],
  ],
  sapporo: [
    [141.15, 42.95],
    [141.55, 43.2],
  ],
  hakodate: [
    [140.0, 41.4],
    [141.05, 42.15],
  ],
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const slider = $<HTMLInputElement>('slider');
const yearEl = $('year');
const playBtn = $<HTMLButtonElement>('play');
const showPast = $<HTMLInputElement>('show-past');
const showLines = $<HTMLInputElement>('show-lines');
const detail = $('detail');
const detailBody = $('detail-body');

let stations: Station[] = [];
let year = YEAR_MIN;
let selected: number | null = null;
let timer: number | null = null;

const isNarrow = () => window.matchMedia('(max-width: 640px)').matches;
// 操作パネルに隠れないよう、地図の余白をパネル側に広げる
const fitPadding = () =>
  isNarrow()
    ? { top: 60, bottom: 260, left: 10, right: 10 }
    : { top: 40, bottom: 40, left: 420, right: 60 };

const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    // 日本語は端末のフォントで描画される（localIdeographFontFamily）。英数字用のグリフのみ取得
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      blank: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png'],
        tileSize: 256,
        minzoom: 5,
        maxzoom: 14,
        attribution: '地理院タイル',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } },
      {
        id: 'blank',
        type: 'raster',
        source: 'blank',
        // 白地図を反転して暗い背景に海岸線だけを淡く残す
        paint: {
          'raster-saturation': -1,
          'raster-brightness-min': 0.42,
          'raster-brightness-max': 0.06,
          'raster-opacity': 0.9,
        },
      },
    ],
  },
  bounds: REGIONS.all,
  fitBoundsOptions: { padding: fitPadding() },
  minZoom: 5,
  maxZoom: 15,
  attributionControl: false,
});
(window as unknown as { __map: maplibregl.Map }).__map = map; // 動作確認用
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

function lineFilter(y: number): maplibregl.FilterSpecification {
  return ['all', ['<=', ['get', 'b'], y], ['>=', ['get', 'e'], y]];
}
function pastLineFilter(y: number): maplibregl.FilterSpecification {
  return ['all', ['<=', ['get', 'b'], y], ['<', ['get', 'e'], y]];
}

function buildFeatures(y: number): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  let nActive = 0;
  let nPast = 0;
  for (const s of stations) {
    const st = statusAt(s, y);
    if (st === 'hidden') continue;
    if (st === 'active') nActive++;
    else if (st === 'past') nPast++;
    const r = displayRecord(s, y);
    features.push({
      type: 'Feature',
      id: s.id,
      properties: {
        id: s.id,
        name: r.name,
        status: st,
        // その年に開業／廃止した駅を少し強調する
        fresh: st === 'active' && s.firstYear === y && y > YEAR_MIN ? 1 : 0,
        gone: st === 'past' && s.closedYear === y ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: [r.lon, r.lat] },
    });
  }
  $('n-active').textContent = String(nActive);
  $('n-past').textContent = String(nPast);
  return { type: 'FeatureCollection', features };
}

function render() {
  yearEl.textContent = String(year);
  slider.value = String(year);
  const src = map.getSource('stations') as GeoJSONSource | undefined;
  if (!src) return;
  src.setData(buildFeatures(year));
  map.setFilter('lines-active', lineFilter(year));
  map.setFilter('lines-past', pastLineFilter(year));
  if (selected !== null) showDetail(selected);
  $('note-now').textContent =
    year === YEAR_MAX
      ? '2025年はデータ基準時点（2025年末）の状態です。2026年以降の変化は含みません。'
      : '';
}

function setYear(y: number) {
  year = Math.max(YEAR_MIN, Math.min(YEAR_MAX, y));
  render();
}

function stop() {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  playBtn.textContent = '▶';
  playBtn.setAttribute('aria-label', '再生');
}
function play() {
  if (year >= YEAR_MAX) setYear(YEAR_MIN);
  playBtn.textContent = '❚❚';
  playBtn.setAttribute('aria-label', '一時停止');
  timer = window.setInterval(() => {
    if (year >= YEAR_MAX) return stop();
    setYear(year + 1);
  }, 450);
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function showDetail(id: number) {
  const s = stations[id];
  selected = id;
  const st = statusAt(s, year);
  const r = displayRecord(s, year);
  const names = [...new Set(s.records.map((x) => x.name))];
  const lines = [...new Set(s.records.map((x) => x.line))];
  const act = activeRecords(s, year);
  let state = '';
  if (st === 'active') state = `${year}年：営業中（${[...new Set(act.map((x) => x.line))].join('・')}）`;
  else if (st === 'past')
    state = s.closedYear !== null && s.closedYear <= year ? `${year}年：廃止済み（${s.closedYear}年に廃止）` : `${year}年：記録なし`;
  else if (st === 'unknown') state = `${year}年：存続期間不明`;
  else state = `${year}年：開業前`;

  let summary: string;
  if (s.closedYear !== null) summary = `データ上の最終年 ${s.closedYear - 1}年 → 廃止 ${s.closedYear}年`;
  else if (s.records.some((x) => x.e === 9999)) summary = '2025年末時点で営業中';
  else summary = '終了年不明のレコードを含む';

  const rows = s.records
    .map(
      (x) => `<tr>
        <td>${esc(x.name)}</td>
        <td>${esc(x.line)}<br><span class="op">${esc(x.op)}</span></td>
        <td>${esc(yearLabel(x))}</td>
        <td>${x.open === null || x.open === 999 ? '不明' : x.open}</td>
      </tr>${
        x.yearNote || x.posNote
          ? `<tr class="sub"><td colspan="4">${esc([x.posNote, x.yearNote].filter(Boolean).join('；'))}</td></tr>`
          : ''
      }`,
    )
    .join('');

  detailBody.innerHTML = `
    <h2>${esc(r.name)}<span class="status ${st}"></span></h2>
    ${names.length > 1 ? `<p class="aka">記録上の駅名：${names.map(esc).join(' → ')}</p>` : ''}
    <p class="state">${esc(state)}</p>
    <p class="summary">${esc(summary)}　/ 路線：${lines.map(esc).join('・')}</p>
    <table>
      <thead><tr><th>駅名</th><th>路線・事業者</th><th>設置期間</th><th>供用開始</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="fine">設置期間の終わりの年は「変更・廃止の前年」です（例：1986 → 1987年に廃止または変更）。
    路線別・期間別のレコードを、関係IDと位置・駅名から一つの駅にまとめています。</p>
    ${s.flags.length ? `<p class="fine warn">確認事項：${s.flags.map(esc).join('；')}</p>` : ''}
  `;
  detail.hidden = false;
}

function closeDetail() {
  detail.hidden = true;
  selected = null;
}

map.on('load', async () => {
  const res = await fetch(`${import.meta.env.BASE_URL}data/stations.json`);
  stations = parseData((await res.json()) as DataFile);

  map.addSource('lines', { type: 'geojson', data: `${import.meta.env.BASE_URL}data/lines.geojson` });
  map.addLayer({
    id: 'lines-past',
    type: 'line',
    source: 'lines',
    filter: pastLineFilter(year),
    paint: { 'line-color': '#5b6b80', 'line-width': 0.8, 'line-opacity': 0.35, 'line-dasharray': [2, 2] },
  });
  map.addLayer({
    id: 'lines-active',
    type: 'line',
    source: 'lines',
    filter: lineFilter(year),
    paint: { 'line-color': '#c9a86a', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 2], 'line-opacity': 0.45 },
  });

  map.addSource('stations', { type: 'geojson', data: buildFeatures(year) });
  const radius = (base: number): maplibregl.ExpressionSpecification =>
    ['interpolate', ['linear'], ['zoom'], 5, base, 9, base * 2, 13, base * 3.5];
  map.addLayer({
    id: 'st-past',
    type: 'circle',
    source: 'stations',
    filter: ['==', ['get', 'status'], 'past'],
    paint: {
      'circle-radius': radius(1.4),
      'circle-color': ['case', ['==', ['get', 'gone'], 1], '#e0735a', '#8297b3'],
      'circle-opacity': ['case', ['==', ['get', 'gone'], 1], 0.9, 0.5],
    },
  });
  map.addLayer({
    id: 'st-unknown',
    type: 'circle',
    source: 'stations',
    filter: ['==', ['get', 'status'], 'unknown'],
    paint: {
      'circle-radius': radius(1.4),
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-color': '#7f93ad',
      'circle-stroke-width': 0.8,
      'circle-stroke-opacity': 0.6,
    },
  });
  map.addLayer({
    id: 'st-glow',
    type: 'circle',
    source: 'stations',
    filter: ['==', ['get', 'status'], 'active'],
    paint: { 'circle-radius': radius(4), 'circle-color': '#ffc861', 'circle-opacity': 0.12, 'circle-blur': 1 },
  });
  map.addLayer({
    id: 'st-active',
    type: 'circle',
    source: 'stations',
    filter: ['==', ['get', 'status'], 'active'],
    paint: {
      // zoom の補間は最上位に置く必要があるため、各段で開業年の強調を切り替える
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        5, ['case', ['==', ['get', 'fresh'], 1], 3, 1.6],
        9, ['case', ['==', ['get', 'fresh'], 1], 5.5, 3.2],
        13, ['case', ['==', ['get', 'fresh'], 1], 9, 5.6],
      ],
      'circle-color': ['case', ['==', ['get', 'fresh'], 1], '#ffffff', '#ffd27a'],
      'circle-opacity': 0.95,
    },
  });
  map.addLayer({
    id: 'st-selected',
    type: 'circle',
    source: 'stations',
    filter: ['==', ['get', 'id'], -1],
    paint: { 'circle-radius': radius(4), 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
  });
  map.addLayer({
    id: 'st-label',
    type: 'symbol',
    source: 'stations',
    minzoom: 10,
    filter: ['!=', ['get', 'status'], 'hidden'],
    layout: {
      'text-field': ['get', 'name'],
      'text-size': 11,
      'text-offset': [0, 1],
      'text-anchor': 'top',
      'text-font': ['Noto Sans Regular'],
    },
    paint: { 'text-color': '#cfd6df', 'text-halo-color': '#0d1117', 'text-halo-width': 1.2 },
  });

  const clickable = ['st-active', 'st-past', 'st-unknown'];
  map.on('click', (e) => {
    // スマートフォンでも押しやすいよう、点の周囲を広めに拾う
    const pad = isNarrow() ? 14 : 8;
    const hits = map.queryRenderedFeatures(
      [
        [e.point.x - pad, e.point.y - pad],
        [e.point.x + pad, e.point.y + pad],
      ],
      { layers: clickable.filter((l) => map.getLayer(l) && map.getLayoutProperty(l, 'visibility') !== 'none') },
    );
    if (!hits.length) return closeDetail();
    // 営業中の点を優先し、その中で最も近い点を選ぶ（過去の駅はズームすると選びやすくなる）
    const act = hits.filter((h) => h.properties!.status === 'active');
    const pool = act.length ? act : hits;
    let best = pool[0];
    let bd = Infinity;
    for (const h of pool) {
      const c = (h.geometry as GeoJSON.Point).coordinates as [number, number];
      const p = map.project(c);
      const d = (p.x - e.point.x) ** 2 + (p.y - e.point.y) ** 2;
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    const id = best.properties!.id as number;
    map.setFilter('st-selected', ['==', ['get', 'id'], id]);
    showDetail(id);
  });
  for (const l of clickable) {
    map.on('mouseenter', l, () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', l, () => (map.getCanvas().style.cursor = ''));
  }

  render();
});

slider.addEventListener('input', () => {
  stop();
  setYear(Number(slider.value));
});
playBtn.addEventListener('click', () => (timer === null ? play() : stop()));
showPast.addEventListener('change', () => {
  const v = showPast.checked ? 'visible' : 'none';
  for (const l of ['st-past', 'st-unknown']) map.setLayoutProperty(l, 'visibility', v);
});
showLines.addEventListener('change', () => {
  const v = showLines.checked ? 'visible' : 'none';
  for (const l of ['lines-active', 'lines-past']) map.setLayoutProperty(l, 'visibility', v);
});
document.querySelectorAll<HTMLButtonElement>('[data-region]').forEach((b) =>
  b.addEventListener('click', () =>
    map.fitBounds(REGIONS[b.dataset.region!], { padding: fitPadding(), duration: 800 }),
  ),
);
$('detail-close').addEventListener('click', () => {
  closeDetail();
  map.setFilter('st-selected', ['==', ['get', 'id'], -1]);
});
document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'checkbox') return;
  if (e.key === 'ArrowRight') setYear(year + 1);
  else if (e.key === 'ArrowLeft') setYear(year - 1);
  else if (e.key === ' ') {
    e.preventDefault();
    timer === null ? play() : stop();
  }
});
