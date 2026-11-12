// 상태 모델, 데모 데이터, 상태 변경 연산(대화형 수정의 공통 언어)
import { DAY_NAMES, dateOfDay, toMin } from './scheduler.js';

export const PALETTE = ['#4f7cff', '#ff8a3d', '#22b07d', '#c25cf2', '#e5484d', '#0fa3b1', '#d4a017', '#6b7a99'];

let idSeq = Date.now() % 100000;
export const newId = prefix => `${prefix}${(++idSeq).toString(36)}`;

export function defaultPrefs() {
  return { studyStart: '09:00', studyEnd: '23:00', dailyMax: 4, blockMin: 90 };
}

export function localISO(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function demoState(now = new Date()) {
  // 마감은 오늘 기준 상대 날짜로 만든다(언제 열어도 이번 주 계획이 보이도록)
  const rel = (days, hhmm) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    const m = toMin(hhmm);
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    return localISO(d);
  };
  const courses = ['자료구조', '운영체제', '데이터베이스', '확률통계', '영어회화'];
  const color = Object.fromEntries(courses.map((c, i) => [c, PALETTE[i]]));
  return {
    courses: color,
    classes: [
      { id: 'c1', title: '자료구조', day: 0, start: '10:30', end: '12:00' },
      { id: 'c2', title: '자료구조', day: 2, start: '10:30', end: '12:00' },
      { id: 'c3', title: '운영체제', day: 0, start: '13:30', end: '15:00' },
      { id: 'c4', title: '운영체제', day: 2, start: '13:30', end: '15:00' },
      { id: 'c5', title: '데이터베이스', day: 1, start: '09:00', end: '10:30' },
      { id: 'c6', title: '데이터베이스', day: 3, start: '09:00', end: '10:30' },
      { id: 'c7', title: '확률통계', day: 1, start: '15:00', end: '16:30' },
      { id: 'c8', title: '확률통계', day: 3, start: '15:00', end: '16:30' },
      { id: 'c9', title: '영어회화', day: 4, start: '10:00', end: '12:00' },
    ],
    events: [
      { id: 'e1', title: '카페 알바', day: 1, start: '18:00', end: '22:00' },
      { id: 'e2', title: '카페 알바', day: 5, start: '12:00', end: '18:00' },
      { id: 'e3', title: '동아리 모임', day: 3, start: '19:00', end: '21:00' },
    ],
    blocked: [],
    tasks: [
      { id: 't1', title: '자료구조 과제3 (해시테이블 구현)', course: '자료구조', due: rel(2, '23:59'), hours: 5 },
      { id: 't2', title: '운영체제 퀴즈 준비', course: '운영체제', due: rel(1, '13:30'), hours: 2 },
      { id: 't3', title: 'DB 팀플 ERD 설계', course: '데이터베이스', due: rel(3, '23:59'), hours: 4 },
      { id: 't4', title: '확률통계 문제풀이 5장', course: '확률통계', due: rel(4, '23:59'), hours: 3 },
      { id: 't5', title: '영어 발표 스크립트', course: '영어회화', due: rel(6, '10:00'), hours: 2 },
    ],
    prefs: defaultPrefs(),
  };
}

export function emptyState() {
  return { courses: {}, classes: [], events: [], blocked: [], tasks: [], prefs: defaultPrefs() };
}

export function colorFor(state, course) {
  if (!course) return PALETTE[7];
  if (!state.courses[course]) {
    const n = Object.keys(state.courses).length;
    state.courses[course] = PALETTE[n % (PALETTE.length - 1)];
  }
  return state.courses[course];
}

export const clone = s => JSON.parse(JSON.stringify(s));

const okTime = t => /^([01]?\d|2[0-4]):[0-5]\d$/.test(t);
const normTime = t => {
  const [h, m] = t.split(':');
  return `${String(Number(h)).padStart(2, '0')}:${m}`;
};
const dayLabel = d => `${DAY_NAMES[d]}요일`;

function checkRange(day, start, end) {
  if (!(Number.isInteger(day) && day >= 0 && day <= 6)) throw new Error('요일(day)은 0(월)~6(일) 정수여야 해요.');
  if (!okTime(start) || !okTime(end)) throw new Error('시간은 HH:MM 형식이어야 해요.');
  if (toMin(end) <= toMin(start)) throw new Error('끝 시간이 시작 시간보다 늦어야 해요.');
}

/**
 * 상태 변경 연산. 대화(규칙 파서·LLM 모두)는 이 연산들만 호출한다.
 * 성공 시 사람이 읽는 한 줄 설명을 돌려주고, 잘못된 입력이면 Error를 던진다.
 */
export function applyOp(state, op) {
  switch (op.type) {
    case 'add_event': {
      checkRange(op.day, op.start, op.end);
      state.events.push({ id: newId('e'), title: op.title || '개인 일정', day: op.day, start: normTime(op.start), end: normTime(op.end) });
      return `${dayLabel(op.day)} ${normTime(op.start)}–${normTime(op.end)} '${op.title || '개인 일정'}' 추가`;
    }
    case 'block_time': {
      checkRange(op.day, op.start, op.end);
      state.blocked.push({ id: newId('x'), day: op.day, start: normTime(op.start), end: normTime(op.end), reason: op.reason || '비워둠' });
      return `${dayLabel(op.day)} ${normTime(op.start)}–${normTime(op.end)} 비워둠`;
    }
    case 'remove_item': {
      for (const key of ['events', 'blocked', 'tasks', 'classes']) {
        const i = state[key].findIndex(x => x.id === op.id);
        if (i >= 0) {
          const [x] = state[key].splice(i, 1);
          return `'${x.title || x.reason}' 삭제`;
        }
      }
      throw new Error(`id '${op.id}' 항목을 찾지 못했어요.`);
    }
    case 'set_task_goal': {
      const t = state.tasks.find(x => x.id === op.task_id);
      if (!t) throw new Error(`과제 '${op.task_id}'를 찾지 못했어요.`);
      if (op.finish_by_day == null) { delete t.goalDay; return `'${t.title}' 목표일 해제`; }
      if (!(op.finish_by_day >= 0 && op.finish_by_day <= 6)) throw new Error('finish_by_day는 0~6이어야 해요.');
      t.goalDay = op.finish_by_day;
      return `'${t.title}'를 ${dayLabel(op.finish_by_day)}까지 끝내도록 앞당김`;
    }
    case 'update_task': {
      const t = state.tasks.find(x => x.id === op.task_id);
      if (!t) throw new Error(`과제 '${op.task_id}'를 찾지 못했어요.`);
      const parts = [];
      if (op.hours != null) { t.hours = Math.max(0.5, Number(op.hours)); parts.push(`예상 ${t.hours}시간`); }
      if (op.due) { t.due = op.due; parts.push(`마감 ${op.due.replace('T', ' ')}`); }
      if (op.done != null) { t.done = !!op.done; parts.push(op.done ? '완료 처리' : '미완료로'); }
      return `'${t.title}' ${parts.join(', ')}`;
    }
    case 'add_task': {
      if (!op.title || !op.due) throw new Error('과제 이름과 마감(due)이 필요해요.');
      state.tasks.push({ id: newId('t'), title: op.title, course: op.course || '', due: op.due, hours: Number(op.hours) || 2 });
      if (op.course) colorFor(state, op.course);
      return `과제 '${op.title}' 추가 (마감 ${op.due.replace('T', ' ')})`;
    }
    case 'set_preferences': {
      const p = state.prefs;
      const parts = [];
      if (op.daily_max_hours != null) { p.dailyMax = Math.min(14, Math.max(1, Number(op.daily_max_hours))); parts.push(`하루 최대 ${p.dailyMax}시간`); }
      if (op.study_start && okTime(op.study_start)) { p.studyStart = normTime(op.study_start); parts.push(`${p.studyStart}부터 공부`); }
      if (op.study_end && okTime(op.study_end)) { p.studyEnd = normTime(op.study_end); parts.push(`${p.studyEnd}까지 공부`); }
      if (op.block_minutes != null) { p.blockMin = Math.min(180, Math.max(30, Math.round(op.block_minutes / 30) * 30)); parts.push(`한 번에 ${p.blockMin}분`); }
      if (!parts.length) throw new Error('바꿀 설정이 없어요.');
      return `설정 변경: ${parts.join(', ')}`;
    }
    default:
      throw new Error(`알 수 없는 연산: ${op.type}`);
  }
}

// LLM에 넘길 압축 상태
export function summarizeForLLM(state, weekStart, now) {
  const dates = DAY_NAMES.map((n, i) => {
    const d = dateOfDay(weekStart, i);
    return `${i}=${n}(${d.getMonth() + 1}/${d.getDate()})`;
  });
  const today = (now.getDay() + 6) % 7;
  return JSON.stringify({
    week_days: dates.join(', '),
    today_day: today,
    now: localISO(now),
    classes: state.classes.map(({ id, title, day, start, end }) => ({ id, title, day, start, end })),
    events: state.events,
    blocked: state.blocked,
    tasks: state.tasks.map(({ id, title, course, due, hours, goalDay, done }) => ({ id, title, course, due, hours, goalDay, done })),
    prefs: state.prefs,
  });
}
