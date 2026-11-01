// 駅データの型と、表示年ごとの状態判定

export const YEAR_MIN = 1950;
export const YEAR_MAX = 2025;

export interface StationRecord {
  src: number; // 元GeoJSONのfeature番号
  name: string;
  line: string;
  op: string;
  kind: string;
  open: number | null; // N05_004 供用開始年（999=不明）
  b: number | null; // N05_005b 原値
  e: number | null; // N05_005e 原値（9999=存続、999=不明、それ以外は変更・廃止年の前年）
  effB: number; // 表示に使う開始年
  effE: number | null; // 表示に使う終了年（両端含む）。null=終了年不明
  rel: string; // N05_006 関係ID
  posNote: string | null;
  yearNote: string | null;
  lon: number;
  lat: number;
  sid: number;
}

export interface Station {
  id: number;
  records: StationRecord[];
  flags: string[];
  /** 最後の年に営業している記録が無い場合の廃止年（最終終了年の翌年）。存続・不明は null */
  closedYear: number | null;
  firstYear: number;
}

export type Status = 'active' | 'past' | 'unknown' | 'hidden';

export interface DataFile {
  meta: {
    source: string;
    sourceUrl: string;
    license: string;
    fetched: string;
    recordFields: string[];
    counts: { records: number; stations: number };
  };
  records: unknown[][];
  stations: { id: number; r: number[]; f: string[] }[];
}

export function parseData(d: DataFile): Station[] {
  const fields = d.meta.recordFields;
  const recs = d.records.map((row) => {
    const o: Record<string, unknown> = {};
    fields.forEach((k, i) => (o[k] = row[i]));
    return o as unknown as StationRecord;
  });
  return d.stations.map((s) => {
    const records = s.r.map((i) => recs[i]);
    const allKnown = records.every((r) => r.effE !== null);
    const anyOngoing = records.some((r) => r.e === 9999);
    const lastEnd = Math.max(...records.map((r) => r.effE ?? -1));
    return {
      id: s.id,
      records,
      flags: s.f,
      closedYear: allKnown && !anyOngoing ? lastEnd + 1 : null,
      firstYear: Math.min(...records.map((r) => r.effB)),
    };
  });
}

/** 表示年に有効なレコード */
export function activeRecords(s: Station, year: number): StationRecord[] {
  return s.records.filter((r) => r.effE !== null && r.effB <= year && year <= r.effE);
}

/**
 * 表示年の駅の状態。
 * - active : その年に有効なレコードがある（どの路線でも）
 * - unknown: 有効なレコードは無いが、終了年不明のレコードが既に始まっている
 * - past   : 既に始まったレコードがすべて終わっている（廃止・休止）
 * - hidden : まだ開業していない
 * 一つの路線のレコードが終わっても、別の路線・改称後のレコードが続いていれば active のまま。
 */
export function statusAt(s: Station, year: number): Status {
  if (activeRecords(s, year).length > 0) return 'active';
  const started = s.records.filter((r) => r.effB <= year);
  if (started.length === 0) return 'hidden';
  if (started.some((r) => r.effE === null)) return 'unknown';
  return 'past';
}

/** 地図に置く位置と表示名。営業中ならその年のレコード、そうでなければ最後のレコード */
export function displayRecord(s: Station, year: number): StationRecord {
  const act = activeRecords(s, year);
  if (act.length) return act[0];
  const started = s.records.filter((r) => r.effB <= year);
  const pool = started.length ? started : s.records;
  return pool.reduce((a, r) => ((r.effE ?? r.effB) >= (a.effE ?? a.effB) ? r : a));
}

export function yearLabel(r: StationRecord): string {
  const b = r.b === 999 || r.b === null ? 'unknown' : String(r.b);
  let e: string;
  if (r.e === 9999) e = 'present (end of 2025)';
  else if (r.e === 999 || r.e === null) e = 'unknown';
  else e = `${r.e}`;
  return `${b}–${e}`;
}
