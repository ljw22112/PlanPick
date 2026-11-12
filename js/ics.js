// LMS 캘린더 내보내기(.ics) → 과제 목록
// Canvas(LearningX), Moodle(e-클래스), 블랙보드 모두 iCal 형식으로 일정을 내보낸다.
import { localISO } from './state.js';

function unfold(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function parseDate(value, params) {
  // 20261115T235900Z | 20261115T235900 | 20261115
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '23', mi = '59', , z] = m;
  if (z) return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi));
  if (/VALUE=DATE/.test(params) && !m[4]) return new Date(+y, +mo - 1, +d, 23, 59);
  return new Date(+y, +mo - 1, +d, +h, +mi); // TZID는 브라우저 현지 시간으로 간주
}

const unescape = s => s.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

export function parseICS(text) {
  const out = [];
  const lines = unfold(text).split(/\r?\n/);
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT') || line.startsWith('BEGIN:VTODO')) { cur = {}; continue; }
    if (line.startsWith('END:VEVENT') || line.startsWith('END:VTODO')) {
      if (cur && cur.summary && (cur.date || cur.end || cur.start)) out.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i);
    const value = line.slice(i + 1).trim();
    const [name, ...params] = head.split(';');
    const p = params.join(';');
    if (name === 'SUMMARY') cur.summary = unescape(value);
    else if (name === 'CATEGORIES') cur.category = unescape(value);
    else if (name === 'DUE') cur.date = parseDate(value, p);
    else if (name === 'DTEND' && !cur.date) cur.end = parseDate(value, p);
    else if (name === 'DTSTART' && !cur.date) cur.start = parseDate(value, p);
  }
  return out
    .map(e => ({ ...e, date: e.date || e.end || e.start }))
    .filter(e => e.date)
    .map(e => {
      // Canvas: "과제명 [과목명]" 형식
      const br = e.summary.match(/\[([^\]]+)\]\s*$/);
      const course = (br && br[1]) || e.category || '';
      const title = br ? e.summary.replace(br[0], '').trim() : e.summary;
      const quiz = /퀴즈|quiz|시험|exam/i.test(title);
      return { title, course, due: localISO(e.date), hours: quiz ? 2 : 3 };
    });
}

export const SAMPLE_ICS = (weekStart) => {
  const d = n => {
    const x = new Date(weekStart);
    x.setDate(x.getDate() + n);
    const p = v => String(v).padStart(2, '0');
    return `${x.getFullYear()}${p(x.getMonth() + 1)}${p(x.getDate())}`;
  };
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//LMS//Calendar//KO
BEGIN:VEVENT
UID:a1
SUMMARY:중간 보고서 제출 [캡스톤디자인]
DTSTART:${d(5)}T235900
DTEND:${d(5)}T235900
END:VEVENT
BEGIN:VEVENT
UID:a2
SUMMARY:6주차 온라인 퀴즈 [확률통계]
DTSTART:${d(4)}T180000
DTEND:${d(4)}T180000
END:VEVENT
END:VCALENDAR`;
};
