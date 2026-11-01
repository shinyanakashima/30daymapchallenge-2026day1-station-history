import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseData, statusAt, displayRecord, type DataFile, type Station } from './model';

const data = JSON.parse(
  readFileSync(new URL('../public/data/stations.json', import.meta.url), 'utf-8'),
) as DataFile;
const stations = parseData(data);

function find(name: string, line?: string): Station[] {
  return stations.filter((s) =>
    s.records.some((r) => r.name === name && (!line || r.line === line)),
  );
}

describe('北海道抽出', () => {
  it('本州側の駅を含まない', () => {
    for (const n of ['大畑', '竜飛海底', '三厩', '大湊', '中小国']) {
      expect(find(n)).toHaveLength(0);
    }
  });
  it('道南・海峡線の北海道側を含む', () => {
    for (const n of ['松前', '吉岡海底', '木古内', '函館', '稚内', '根室']) {
      expect(find(n).length).toBeGreaterThan(0);
    }
  });
});

describe('幸福駅（広尾線）', () => {
  const [s] = find('幸福', '広尾線');
  it('1956年開業、1986年まで営業、1987年から過去の駅', () => {
    expect(statusAt(s, 1955)).toBe('hidden');
    expect(statusAt(s, 1956)).toBe('active');
    expect(statusAt(s, 1986)).toBe('active');
    expect(statusAt(s, 1987)).toBe('past');
    expect(statusAt(s, 2025)).toBe('past');
  });
  it('廃止年は記録終了年(1986)の翌年', () => {
    expect(s.closedYear).toBe(1987);
  });
});

describe('帯広駅（複数路線）', () => {
  const ss = find('帯広', '根室線');
  it('根室線・士幌線・広尾線のレコードが一つの駅にまとまる', () => {
    expect(ss).toHaveLength(1);
    const lines = new Set(ss[0].records.map((r) => r.line));
    expect(lines.has('士幌線')).toBe(true);
    expect(lines.has('広尾線')).toBe(true);
  });
  it('広尾線・士幌線の廃止後も営業中', () => {
    for (const y of [1950, 1986, 1987, 2025]) expect(statusAt(ss[0], y)).toBe('active');
    expect(ss[0].closedYear).toBeNull();
  });
  it('十勝鉄道の帯広は別の駅として1959年から過去の駅', () => {
    const tk = find('帯広', '帯広部線');
    expect(tk).toHaveLength(1);
    expect(tk[0]).not.toBe(ss[0]);
    expect(statusAt(tk[0], 1958)).toBe('active');
    expect(statusAt(tk[0], 1959)).toBe('past');
  });
});

describe('改称・会社変更を廃止と混同しない', () => {
  it('狩太→ニセコ（1968改称）は継続して営業中', () => {
    const [s] = find('ニセコ', '函館線');
    expect(s.records.some((r) => r.name === '狩太')).toBe(true);
    expect(statusAt(s, 1967)).toBe('active');
    expect(statusAt(s, 1968)).toBe('active');
    expect(displayRecord(s, 1960).name).toBe('狩太');
    expect(displayRecord(s, 2000).name).toBe('ニセコ');
  });
  it('江差線→道南いさりび鉄道（2016移管）は継続して営業中', () => {
    const [s] = find('上磯', '道南いさりび鉄道線');
    for (const y of [2015, 2016, 2025]) expect(statusAt(s, y)).toBe('active');
  });
});

describe('999・9999の扱い', () => {
  it('9999は2025年まで営業として扱い、廃止年を持たない', () => {
    const [s] = find('旭川', '函館線');
    expect(statusAt(s, 2025)).toBe('active');
    expect(s.closedYear).toBeNull();
  });
  it('終了年不明のレコードは unknown として扱う', () => {
    const s = find('鷲ノ巣線路班')[0];
    expect(statusAt(s, 1953)).toBe('hidden');
    expect(statusAt(s, 1960)).toBe('unknown');
  });
});
