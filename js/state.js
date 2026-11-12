// 상태 모델, 데모 데이터, 상태 변경 연산(대화형 수정의 공통 언어)
import { DAY_NAMES, dateOfDay, toMin, localDateKey } from './scheduler.js';

export const PALETTE = ['#4f7cff', '#ff8a3d', '#22b07d', '#c25cf2', '#e5484d', '#0fa3b1', '#d4a017', '#6b7a99'];

// 생활 일정 종류: 학교 밖 일정도 같은 계획표에서 다룬다
export const EVENT_KINDS = {
  알바: { color: '#ff8a3d', bg: '#ffe9d6', ink: '#9a4a0b' },
  대외활동: { color: '#8b5cf6', bg: '#efe7ff', ink: '#5b2bb5' },
  운동: { color: '#16a34a', bg: '#dcf5e4', ink: '#146c34' },
  기타: { color: '#64748b', bg: '#e9edf3', ink: '#3c4656' },
};
export function kindOf(title = '') {
  if (/알바|아르바이트|근무|과외|편의점|카페 ?근무/.test(title)) return '알바';
  if (/헬스|운동|러닝|달리기|요가|수영|필라테스|축구|농구|클라이밍|PT|산책/.test(title)) return '운동';
  if (/동아리|서포터즈|대외|공모전|봉사|학회|스터디|해커톤|기자단|인턴|멘토|프로젝트/.test(title)) return '대외활동';
  return '기타';
}

// 희망 분야(대외활동 추천용)
export const INTEREST_FIELDS = ['AI·데이터', '개발', '창업', '마케팅', '디자인', '기획', '금융', '환경·ESG', '봉사', '글로벌', '취업'];

let idSeq = Date.now() % 100000;
export const newId = prefix => `${prefix}${(++idSeq).toString(36)}`;

export function defaultPrefs() {
  return { studyStart: '09:00', studyEnd: '23:00', dailyMax: 4, blockMin: 90, commuteMin: 50, commuteMode: '지하철' };
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
      { id: 'e1', title: '카페 알바', kind: '알바', day: 1, start: '18:00', end: '22:00' },
      { id: 'e2', title: '카페 알바', kind: '알바', day: 5, start: '12:00', end: '18:00' },
      { id: 'e3', title: 'AI 학회 정기 세션', kind: '대외활동', day: 3, start: '19:00', end: '21:00' },
    ],
    // 운동 목표: 시각을 고정하지 않고 주 N회만 정하면 빈 시간에 배치
    habits: [
      { id: 'h1', title: '헬스', kind: '운동', perWeek: 3, minutes: 60, windowStart: '17:00', windowEnd: '22:00' },
    ],
    interests: ['AI·데이터', '창업'],
    modules: ['study', 'alba', 'exercise', 'health', 'commute', 'activities'],
    saved: [],
    blocked: [],
    tasks: [
      { id: 't1', title: '자료구조 과제3 (해시테이블 구현)', course: '자료구조', due: rel(2, '23:59'), hours: 5 },
      { id: 't2', title: '운영체제 퀴즈 준비', course: '운영체제', due: rel(1, '13:30'), hours: 2 },
      { id: 't3', title: 'DB 팀플 ERD 설계', course: '데이터베이스', due: rel(3, '23:59'), hours: 4 },
      { id: 't4', title: '확률통계 문제풀이 5장', course: '확률통계', due: rel(4, '23:59'), hours: 3 },
      { id: 't5', title: '영어 발표 스크립트', course: '영어회화', due: rel(6, '10:00'), hours: 2 },
    ],
    prefs: defaultPrefs(),
    condition: null,
  };
}

export function emptyState() {
  return { courses: {}, classes: [], events: [], blocked: [], tasks: [], habits: [], interests: [], saved: [], modules: ['study'], prefs: defaultPrefs(), condition: null };
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
      const kind = EVENT_KINDS[op.kind] ? op.kind : kindOf(op.title);
      state.events.push({ id: newId('e'), title: op.title || '개인 일정', kind, day: op.day, start: normTime(op.start), end: normTime(op.end) });
      return `${dayLabel(op.day)} ${normTime(op.start)}–${normTime(op.end)} '${op.title || '개인 일정'}'(${kind}) 추가`;
    }
    case 'block_time': {
      checkRange(op.day, op.start, op.end);
      state.blocked.push({ id: newId('x'), day: op.day, start: normTime(op.start), end: normTime(op.end), reason: op.reason || '비워둠', recurring: !!op.recurring });
      return `${op.recurring ? '매주 ' : ''}${dayLabel(op.day)} ${normTime(op.start)}–${normTime(op.end)} ${op.recurring ? '공부 안 함(규칙으로 기억)' : '비워둠'}`;
    }
    case 'remove_item': {
      for (const key of ['events', 'blocked', 'tasks', 'classes', 'habits']) {
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
    case 'set_condition': {
      // 헬스케어 융합: 오늘의 수면·스트레스 (웨어러블 또는 직접 입력)
      const c = { ...(state.condition && state.condition.date === localDateKey(op.now || new Date()) ? state.condition : {}) };
      c.date = localDateKey(op.now || new Date());
      const parts = [];
      if (op.sleep_hours != null) { c.sleep = Math.min(12, Math.max(0, Number(op.sleep_hours))); parts.push(`수면 ${c.sleep}시간`); }
      if (op.stress != null) { c.stress = Math.min(5, Math.max(1, Math.round(op.stress))); parts.push(`스트레스 ${c.stress}/5`); }
      if (!parts.length) throw new Error('수면 시간이나 스트레스 중 하나는 필요해요.');
      c.source = op.source || 'chat';
      state.condition = c;
      state.condHistory = { ...(state.condHistory || {}), [c.date]: { sleep: c.sleep, stress: c.stress } };
      return `오늘 컨디션 기록: ${parts.join(', ')}`;
    }
    case 'set_commute': {
      // 모빌리티 융합: 통학 시간과 수단
      const p = state.prefs;
      const parts = [];
      if (op.minutes != null) { p.commuteMin = Math.min(180, Math.max(0, Math.round(op.minutes / 5) * 5)); parts.push(p.commuteMin ? `편도 ${p.commuteMin}분` : '통학 없음'); }
      if (op.mode) {
        if (!['지하철', '버스', '자차', '도보'].includes(op.mode)) throw new Error('수단은 지하철·버스·자차·도보 중 하나예요.');
        p.commuteMode = op.mode; parts.push(op.mode);
      }
      if (!parts.length) throw new Error('바꿀 통학 정보가 없어요.');
      return `통학 설정: ${parts.join(', ')}${p.commuteMode === '자차' ? ' (운전 중엔 학습 블록을 넣지 않아요)' : ''}`;
    }
    case 'set_habit': {
      // 운동 등 반복 목표: 같은 이름이 있으면 고친다
      state.habits = state.habits || [];
      const title = op.title || '운동';
      let h = state.habits.find(x => x.title === title);
      if (!h) { h = { id: newId('h'), title, kind: '운동', perWeek: 3, minutes: 60, windowStart: '17:00', windowEnd: '22:00' }; state.habits.push(h); }
      if (op.kind) h.kind = op.kind;
      else if (/영어|단어|토익|어학|일본어|중국어|회화/.test(title)) h.kind = '어학';
      if (op.per_week != null) h.perWeek = Math.min(7, Math.max(0, Math.round(op.per_week)));
      if (op.minutes != null) h.minutes = Math.min(240, Math.max(15, Math.round(op.minutes / 15) * 15));
      if (op.window_start && okTime(op.window_start)) h.windowStart = normTime(op.window_start);
      if (op.window_end && okTime(op.window_end)) h.windowEnd = normTime(op.window_end);
      if (h.perWeek === 0) { state.habits = state.habits.filter(x => x !== h); return `'${title}' 목표 삭제`; }
      return `'${h.title}' 주 ${h.perWeek}회 × ${h.minutes}분 (${h.windowStart}–${h.windowEnd} 사이)`;
    }
    case 'set_interests': {
      const fields = (op.fields || []).map(f => INTEREST_FIELDS.find(x => x.replace(/[·\s]/g, '').toLowerCase().includes(String(f).replace(/[·\s]/g, '').toLowerCase())) || null).filter(Boolean);
      if (!fields.length) throw new Error(`분야는 ${INTEREST_FIELDS.join(', ')} 중에서 골라주세요.`);
      state.interests = op.mode === 'add' ? [...new Set([...(state.interests || []), ...fields])] : [...new Set(fields)];
      return `희망 분야: ${state.interests.join(', ')}`;
    }
    case 'split_task': {
      // 큰 과제를 단계로 쪼개고 단계별 중간 마감을 둔다
      const t = state.tasks.find(x => x.id === op.task_id);
      if (!t) throw new Error(`과제 '${op.task_id}'를 찾지 못했어요.`);
      const steps = (op.steps && op.steps.length ? op.steps : templateSteps(t)).map(x => (typeof x === 'string' ? { name: x } : x));
      const total = steps.reduce((a, x) => a + (x.share || 1), 0);
      const now = op.now ? new Date(op.now) : new Date();
      const due = new Date(t.due);
      const span = Math.max(0, due - now);
      let cum = 0;
      const subs = steps.map((x, i) => {
        cum += (x.share || 1) / total;
        const d = i === steps.length - 1 ? due : new Date(now.getTime() + span * cum);
        if (i < steps.length - 1) d.setHours(23, 59, 0, 0);
        return { id: newId('t'), title: `${t.title} · ${i + 1}. ${x.name}`, course: t.course, due: localISO(d), hours: Math.max(0.5, Math.round((t.hours * (x.share || 1) / total) * 2) / 2), parent: t.id };
      });
      state.tasks = state.tasks.filter(x => x.id !== t.id).concat(subs);
      return `'${t.title}'를 ${subs.length}단계로 나눔: ${subs.map(x => `${x.title.split(' · ')[1]}(~${x.due.slice(5, 10).replace('-', '/')}, ${x.hours}h)`).join(' → ')}`;
    }
    case 'add_exam': {
      // 시험기간 모드: 시험일 기준 D-7, D-4, D-2, D-1 복습 회차(간격 반복)
      if (!op.course || !op.date) throw new Error('과목(course)과 시험일(date)이 필요해요.');
      const exam = new Date(op.date);
      const now = op.now ? new Date(op.now) : new Date();
      const total = Number(op.hours) || 8;
      const plan = [[7, 0.2], [4, 0.25], [2, 0.25], [1, 0.3]].filter(([dd]) => new Date(exam.getTime() - dd * 86400000) > now);
      if (!plan.length) throw new Error('시험까지 남은 날이 너무 적어요.');
      const sum = plan.reduce((a, [, w]) => a + w, 0);
      const made = plan.map(([dd, w], i) => {
        const d = new Date(exam.getTime() - dd * 86400000);
        d.setHours(23, 59, 0, 0);
        const task = { id: newId('t'), title: `${op.course} 시험 복습 ${i + 1}회차 (D-${dd})`, course: op.course, due: localISO(d), hours: Math.max(0.5, Math.round((total * w / sum) * 2) / 2), exam: true };
        state.tasks.push(task);
        return task;
      });
      state.exams = [...(state.exams || []), { course: op.course, date: op.date }];
      colorFor(state, op.course);
      return `${op.course} 시험(${op.date.slice(5, 10).replace('-', '/')}) 대비 복습 ${made.length}회 배치: ${made.map(x => `D-${x.title.match(/D-(\d+)/)[1]} ${x.hours}h`).join(', ')}`;
    }
    case 'log_block': {
      // 실행 기록: 실제 소요시간을 남겨 다음 예측과 집중 시간대 학습에 쓴다
      const t = state.tasks.find(x => x.id === op.task_id);
      const h = (state.habits || []).find(x => x.id === op.task_id);
      state.log = [...(state.log || []), { taskId: op.task_id, course: t ? t.course : h ? h.kind : '', planned: op.planned, actual: op.actual, hour: op.hour, done: !!op.done, date: op.date }];
      if (t && op.done) {
        t.doneMin = (t.doneMin || 0) + op.actual;
        if (op.finished) t.done = true;
      }
      if (!op.done) return `'${(t || h || {}).title}' 이번 블록은 못 함 → 남은 시간에 다시 배치`;
      return `'${(t || h || {}).title}' ${op.actual}분 기록${op.finished ? ' · 과제 완료' : ''}`;
    }
    case 'set_commute_delay': {
      const now = op.now ? new Date(op.now) : new Date();
      state.commuteDelay = { date: localDateKey(now), min: Math.max(0, Math.round(op.minutes || 0)) };
      return state.commuteDelay.min ? `오늘 통학 ${state.commuteDelay.min}분 지연 반영` : '통학 지연 해제';
    }
    case 'set_checklist': {
      const t = state.tasks.find(x => x.id === op.task_id);
      if (!t) throw new Error('과제를 찾지 못했어요.');
      t.checklist = { ...(t.checklist || {}), [op.item]: !!op.checked };
      return '체크리스트 저장';
    }
    default:
      throw new Error(`알 수 없는 연산: ${op.type}`);
  }
}

// 과제 유형별 기본 단계(비율)
export function templateSteps(t) {
  if (/구현|코딩|프로그래밍|과제\d|알고리즘|실습/.test(t.title)) return [{ name: '문제 분석·설계', share: 2 }, { name: '구현', share: 5 }, { name: '테스트·제출', share: 3 }];
  if (/보고서|레포트|팀플|발표|ERD|기획|논문/.test(t.title)) return [{ name: '자료 조사', share: 3 }, { name: '초안 작성', share: 4 }, { name: '검토·제출', share: 3 }];
  return [{ name: '내용 이해', share: 3 }, { name: '본 작업', share: 5 }, { name: '마무리', share: 2 }];
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
    exams: state.exams || [],
    habits: state.habits || [],
    interests: state.interests || [],
    blocked: state.blocked,
    tasks: state.tasks.map(({ id, title, course, due, hours, goalDay, done }) => ({ id, title, course, due, hours, goalDay, done })),
    prefs: state.prefs,
    condition_today: state.condition && state.condition.date === localDateKey(now) ? state.condition : null,
  });
}
