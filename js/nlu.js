// API 키가 없을 때 쓰는 규칙 기반 한국어 파서.
// 결과는 LLM 경로와 똑같이 상태 변경 연산(ops) 목록이다.

const DAY = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };
const PERIOD = {
  아침: ['07:00', '10:00'], 오전: ['09:00', '12:00'], 점심: ['12:00', '13:30'],
  오후: ['13:00', '18:00'], 저녁: ['18:00', '22:00'], 밤: ['21:00', '24:00'],
  하루종일: ['00:00', '24:00'], 종일: ['00:00', '24:00'],
};
const EVENT_WORDS = ['알바', '아르바이트', '약속', '동아리', '운동', '헬스', '병원', '면접', '스터디', '회의', '모임', '데이트', '수업', '세미나', '봉사'];

function parseDays(text, today) {
  const days = new Set();
  for (const m of text.matchAll(/([월화수목금토일])요일/g)) days.add(DAY[m[1]]);
  // "월수금에", "화목" 처럼 요일 글자만 붙여 쓴 경우
  for (const m of text.matchAll(/(?:^|\s)([월화수목금토]{2,4}|[월화수목금토][월화수목금토일]{1,3})(?=에|\s|$|은|는|마다)/g)) {
    for (const ch of m[1]) days.add(DAY[ch]);
  }
  if (/오늘/.test(text)) days.add(today);
  if (/내일/.test(text)) days.add(Math.min(6, today + 1));
  if (/모레/.test(text)) days.add(Math.min(6, today + 2));
  if (/주말/.test(text)) { days.add(5); days.add(6); }
  if (/평일/.test(text)) [0, 1, 2, 3, 4].forEach(d => days.add(d));
  return [...days].sort();
}

// "오후 2시 반", "19시", "7시30분" → "HH:MM"
function parseClock(qual, h, rest, prevQual) {
  let hour = Number(h);
  let min = 0;
  if (rest) {
    if (rest.includes('반')) min = 30;
    const mm = rest.match(/(\d{1,2})\s*분/);
    if (mm) min = Number(mm[1]);
  }
  const q = qual || prevQual;
  if ((q === '오후' || q === '저녁' || q === '밤') && hour < 12) hour += 12;
  else if (!q && hour >= 1 && hour <= 7) hour += 12; // "2시" → 오후 2시
  if (q === '밤' && hour === 24) hour = 24;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseTimeRange(text) {
  const re = /(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시\s*(반|\d{1,2}\s*분)?/g;
  const found = [...text.matchAll(re)];
  if (found.length >= 2) {
    const a = parseClock(found[0][1], found[0][2], found[0][3]);
    let b = parseClock(found[1][1], found[1][2], found[1][3], found[0][1]);
    if (b <= a && Number(b.slice(0, 2)) < 12) b = `${Number(b.slice(0, 2)) + 12}${b.slice(2)}`;
    if (b > a) return [a, b];
  }
  const hm = [...text.matchAll(/(\d{1,2}):(\d{2})/g)];
  if (hm.length >= 2) return [hm[0][0].padStart(5, '0'), hm[1][0].padStart(5, '0')];
  if (found.length === 1) {
    const a = parseClock(found[0][1], found[0][2], found[0][3]);
    const dur = text.match(/(\d+(?:\.\d+)?)\s*시간\s*(?:동안|정도)?/);
    const len = dur ? Math.round(Number(dur[1]) * 60) : 120;
    const [h, m] = a.split(':').map(Number);
    const end = Math.min(24 * 60, h * 60 + m + len);
    return [a, `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`];
  }
  for (const [word, range] of Object.entries(PERIOD)) if (text.includes(word)) return range;
  return null;
}

function findTask(text, tasks) {
  let best = null;
  let bestScore = 0;
  for (const t of tasks) {
    const tokens = new Set([t.course, ...t.title.split(/[\s()\[\]·,]+/)].filter(w => w && w.length >= 2));
    let score = 0;
    for (const w of tokens) if (text.includes(w)) score += w.length;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

export function parseKorean(text, state, today) {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return { help: true };

  if (/되돌|원래대로|취소해|없던 ?일/.test(t)) return { special: 'undo' };
  if (/다시 ?짜|재계획|새로 ?짜|계획 ?(세워|만들)/.test(t)) return { ops: [], special: 'reschedule' };

  const ops = [];
  const days = parseDays(t, today);
  const range = parseTimeRange(t);
  const task = findTask(t, state.tasks);

  // 설정: 하루 최대 공부량
  const daily = t.match(/하루(?:에)?\s*(?:최대|많아야|최대한)?\s*(\d+(?:\.\d+)?)\s*시간/);
  if (daily && !task) ops.push({ type: 'set_preferences', daily_max_hours: Number(daily[1]) });

  // 설정: 블록 길이
  const blk = t.match(/한 ?번에\s*(\d+)\s*(분|시간)/);
  if (blk) ops.push({ type: 'set_preferences', block_minutes: Number(blk[1]) * (blk[2] === '시간' ? 60 : 1) });

  // 설정: 공부 시작/끝 시각
  const startPref = t.match(/(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시\s*(반)?\s*(?:부터|이후에?|넘어서)\s*공부/);
  if (startPref && !days.length) ops.push({ type: 'set_preferences', study_start: parseClock(startPref[1], startPref[2], startPref[3]) });
  const endPref = t.match(/(오전|오후|아침|저녁|밤)?\s*(\d{1,2})\s*시\s*(반)?\s*(?:까지만|전까지만?|이전에만)\s*공부/);
  if (endPref && !days.length) ops.push({ type: 'set_preferences', study_end: parseClock(endPref[1], endPref[2], endPref[3]) });
  if (/아침형|일찍 공부/.test(t)) ops.push({ type: 'set_preferences', study_start: '07:00', study_end: '21:00' });
  if (/밤에 공부|야행성|올빼미/.test(t)) ops.push({ type: 'set_preferences', study_start: '12:00', study_end: '24:00' });

  // 헬스케어 융합: 컨디션
  const slept = t.match(/(\d+(?:\.\d+)?)\s*시간\s*(?:밖에|만|정도|쯤)?\s*(?:못\s*)?잤/);
  const cond = {};
  if (slept) cond.sleep_hours = Number(slept[1]);
  if (/밤샜|밤새|한숨도 못/.test(t)) cond.sleep_hours = 2;
  if (/푹 ?잤|컨디션 ?(좋|최고|굿)/.test(t)) { cond.sleep_hours = cond.sleep_hours ?? 8; cond.stress = 1; }
  if (/피곤|지쳤|힘들|컨디션 ?(안 ?좋|별로|나빠|최악)|아파/.test(t)) cond.stress = 4;
  if (/스트레스 ?(심|많|폭발|최고)|멘붕/.test(t)) cond.stress = 5;
  if (Object.keys(cond).length) ops.push({ type: 'set_condition', ...cond });

  // 모빌리티 융합: 통학
  if (/통학|등교|하교|출퇴근|통근/.test(t)) {
    const op = { type: 'set_commute' };
    const mins = t.match(/(\d+)\s*시간\s*(\d+)\s*분|(\d+(?:\.\d+)?)\s*(분|시간)/);
    if (mins) op.minutes = mins[1] ? Number(mins[1]) * 60 + Number(mins[2]) : Number(mins[3]) * (mins[4] === '시간' ? 60 : 1);
    if (/자차|운전|차로|차 ?끌/.test(t)) op.mode = '자차';
    else if (/버스/.test(t)) op.mode = '버스';
    else if (/지하철|전철/.test(t)) op.mode = '지하철';
    else if (/걸어|도보|자취/.test(t)) op.mode = '도보';
    if (/통학 ?(안|없)/.test(t)) op.minutes = 0;
    if (op.minutes != null || op.mode) return { ops: [...ops, op] };
  }
  if (ops.some(o => o.type === 'set_condition')) return { ops };

  // 과제 관련
  if (task) {
    if (/끝|마무리|완성|해치우|미리/.test(t) && days.length) {
      ops.push({ type: 'set_task_goal', task_id: task.id, finish_by_day: Math.max(...days) });
    }
    const hrs = t.match(/(\d+(?:\.\d+)?)\s*시간\s*(?:걸|정도|이면|필요|더)/);
    if (hrs) {
      const add = /더/.test(t.slice(hrs.index, hrs.index + hrs[0].length + 2));
      ops.push({ type: 'update_task', task_id: task.id, hours: add ? task.hours + Number(hrs[1]) : Number(hrs[1]) });
    }
    if (/다 ?했|완료|제출했|끝냈/.test(t)) ops.push({ type: 'update_task', task_id: task.id, done: true });
    if (ops.length) return { ops };
  }

  // 시간 비우기 / 일정 추가
  if (days.length && range) {
    const free = /비워|비우|쉬|쉴|빼줘|빼 ?줘|공부 ?(안|말)|놀|휴식/.test(t);
    const word = EVENT_WORDS.find(w => t.includes(w));
    for (const d of days) {
      if (free && !word) ops.push({ type: 'block_time', day: d, start: range[0], end: range[1], reason: '휴식' });
      else ops.push({ type: 'add_event', day: d, title: word || (free ? '휴식' : '개인 일정'), start: range[0], end: range[1] });
    }
  } else if (days.length && !range && /비워|쉬|쉴|휴식|놀/.test(t)) {
    for (const d of days) ops.push({ type: 'block_time', day: d, start: '00:00', end: '24:00', reason: '휴식' });
  }

  if (ops.length) return { ops };
  return { help: true };
}
