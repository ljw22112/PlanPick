// 팀플 공통 빈 시간·스터디 계획 공유: 서버 없이 '공유 코드'(base64 JSON)를 주고받는다
import { toMin, toHHMM, DAY_NAMES } from './scheduler.js';

const enc = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
const dec = code => JSON.parse(decodeURIComponent(escape(atob(code.trim()))));

// 내 바쁜 시간(수업·고정 일정·계획된 블록)만 담는다. 일정 제목은 넣지 않는다(개인정보 최소화)
export function myBusyCode(name, state, plan) {
  const busy = [
    ...state.classes.map(c => [c.day, c.start, c.end]),
    ...state.events.map(e => [e.day, e.start, e.end]),
    ...plan.filter(b => !b.mobile).map(b => [b.day, b.start, b.end]),
  ];
  return enc({ v: 1, t: 'busy', name: name || '나', busy });
}

export function parseCodes(text) {
  const out = [];
  const errors = [];
  for (const line of text.split(/\s+/).filter(Boolean)) {
    try {
      const o = dec(line);
      if (o.t === 'busy' && Array.isArray(o.busy)) out.push(o);
      else if (o.t === 'study') out.push(o);
      else errors.push('알 수 없는 코드');
    } catch { errors.push('코드를 읽지 못함'); }
  }
  return { members: out, errors };
}

// 모든 사람이 비어 있는 60분 이상 구간 (09~22시, 오늘 이후)
export function commonFree(members, { fromDay = 0, nowMin = 0, startH = 9, endH = 22, minLen = 60 } = {}) {
  const slots = [];
  for (let d = Math.max(0, fromDay); d < 7; d++) {
    let iv = [[d === fromDay ? Math.max(startH * 60, Math.ceil(nowMin / 30) * 30) : startH * 60, endH * 60]].filter(([a, b]) => b > a);
    for (const m of members) {
      for (const [day, s, e] of m.busy) {
        if (day !== d) continue;
        const a = toMin(s) - 10;
        const b = toMin(e) + 10;
        iv = iv.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y]] : [...(a > x ? [[x, a]] : []), ...(b < y ? [[b, y]] : [])]));
      }
    }
    for (const [a, b] of iv) if (b - a >= minLen) slots.push({ day: d, start: toHHMM(a), end: toHHMM(Math.min(b, a + 120)), len: b - a });
  }
  // 저녁 7시 전후·긴 구간 우선
  return slots.sort((x, y) => (y.len >= 90) - (x.len >= 90) || Math.abs(toMin(x.start) - 19 * 60) - Math.abs(toMin(y.start) - 19 * 60)).slice(0, 6)
    .map(s => ({ ...s, label: `${DAY_NAMES[s.day]} ${s.start}–${s.end}` }));
}

// 시연용 팀원 2명
export function demoTeammates() {
  return [
    { v: 1, t: 'busy', name: '민수', busy: [[0, '09:00', '13:00'], [1, '13:00', '18:00'], [2, '10:00', '15:00'], [3, '18:00', '22:00'], [4, '09:00', '12:00'], [5, '10:00', '16:00']] },
    { v: 1, t: 'busy', name: '지은', busy: [[0, '15:00', '18:00'], [1, '09:00', '12:00'], [2, '16:00', '21:00'], [3, '09:00', '11:00'], [4, '13:00', '19:00'], [6, '12:00', '18:00']] },
  ];
}

// 스터디 계획 공유: 시험 복습 회차를 그대로 넘긴다
export function studyCode(name, state) {
  const tasks = state.tasks.filter(t => t.exam && !t.done).map(({ title, course, due, hours }) => ({ title, course, due, hours }));
  return enc({ v: 1, t: 'study', name: name || '나', exams: state.exams || [], tasks });
}
