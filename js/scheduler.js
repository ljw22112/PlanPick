// 제약 기반 주간 계획 생성기 (마감 우선 탐욕 배치)
// 시간은 모두 "자정부터의 분"으로 다룬다. day: 0=월 ... 6=일

export const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

export function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function toHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function localDateKey(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function weekStartOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 월=0
  d.setDate(d.getDate() - dow);
  return d;
}

export function dateOfDay(weekStart, day) {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + day);
  return d;
}

// 마감 시각(Date)을 이번 주 기준 (day, minute)로. 주 이전이면 day<0, 이후면 day>6
function deadlinePos(weekStart, date) {
  const diffMs = date - weekStart;
  const day = Math.floor(diffMs / 86400000);
  const minute = Math.round((diffMs - day * 86400000) / 60000);
  return { day, minute };
}

function subtract(intervals, s, e) {
  const out = [];
  for (const [a, b] of intervals) {
    if (e <= a || s >= b) { out.push([a, b]); continue; }
    if (s > a) out.push([a, s]);
    if (e < b) out.push([e, b]);
  }
  return out;
}

// ---------- 헬스케어 융합: 컨디션 계수 ----------
// 수면·스트레스(웨어러블 또는 직접 입력)로 '오늘' 공부량과 블록 길이를 조절한다.
export function conditionEffect(cond) {
  if (!cond) return { factor: 1, blockCap: null, breakMin: 10, label: '기록 없음 · 평소대로' };
  const sleep = cond.sleep ?? 7;
  const stress = cond.stress ?? 2;
  let factor = 1;
  if (sleep < 5) factor = 0.5;
  else if (sleep < 6.5) factor = 0.75;
  else if (sleep >= 7.5 && stress <= 2) factor = 1.15;
  if (stress >= 4) factor *= 0.75;
  factor = Math.round(factor * 100) / 100;
  const tired = factor < 0.8;
  const label = tired ? '피로 · 공부량 줄이고 짧게' : factor > 1 ? '컨디션 좋음 · 조금 더' : '보통 · 평소대로';
  return { factor, blockCap: tired ? 60 : null, breakMin: tired ? 20 : 10, label };
}

// ---------- 모빌리티 융합: 이동 중 학습이 가능한 과제 ----------
export const MOBILE_RE = /퀴즈|암기|단어|복습|스크립트|발표|읽기|리딩|요약|개념|정리/;
export const isMobileTask = t => t.mobile ?? MOBILE_RE.test(t.title);

/**
 * state: { classes, events, blocked, tasks, prefs, condition }
 * opts: { weekStart: Date, now: Date }
 * returns { plan, commutes, warnings, today: { capMin, effect } }
 */
export function schedule(state, { weekStart, now }) {
  const p = state.prefs;
  const studyStart = toMin(p.studyStart);
  const studyEnd = toMin(p.studyEnd);
  const minBlock = 30;
  const nowPos = deadlinePos(weekStart, now);
  const today = nowPos.day;

  // 오늘 컨디션 반영 (기록 날짜가 오늘일 때만)
  const todayKey = localDateKey(now);
  const cond = state.condition && state.condition.date === todayKey ? state.condition : null;
  const effect = conditionEffect(cond);
  const capOf = d => {
    const base = p.dailyMax * 60;
    return d === today ? Math.round((base * effect.factor) / 30) * 30 : base;
  };
  const blockOf = d => (d === today && effect.blockCap ? Math.min(p.blockMin, effect.blockCap) : p.blockMin);
  const breakOf = d => (d === today ? effect.breakMin : 10);

  // 통학 구간: 수업이 있는 날, 첫 수업 전·마지막 수업 후
  const commuteMin = Number(p.commuteMin) || 0;
  const commutes = [];
  if (commuteMin > 0) {
    for (let d = 0; d < 7; d++) {
      const cs = state.classes.filter(c => c.day === d).sort((a, b) => toMin(a.start) - toMin(b.start));
      if (!cs.length) continue;
      const first = toMin(cs[0].start);
      const last = Math.max(...cs.map(c => toMin(c.end)));
      commutes.push({ day: d, start: toHHMM(Math.max(0, first - 10 - commuteMin)), end: toHHMM(first - 10), dir: '등교' });
      commutes.push({ day: d, start: toHHMM(last + 10), end: toHHMM(Math.min(24 * 60, last + 10 + commuteMin)), dir: '하교' });
    }
  }

  // 1) 요일별 빈 시간(책상 공부용)과 이동 시간(이동 중 학습용)
  const free = [];
  const moving = [];
  const used = new Array(7).fill(0);
  const pastCut = (iv, d) => {
    if (today > d) return [];
    if (today === d) return subtract(iv, 0, Math.ceil(nowPos.minute / 30) * 30);
    return iv;
  };
  for (let d = 0; d < 7; d++) {
    let iv = [[studyStart, studyEnd]];
    const busy = [
      ...state.classes.filter(c => c.day === d),
      ...state.events.filter(e => e.day === d),
      ...state.blocked.filter(b => b.day === d),
    ];
    for (const b of busy) iv = subtract(iv, toMin(b.start) - 10, toMin(b.end) + 10);
    for (const c of commutes.filter(x => x.day === d)) iv = subtract(iv, toMin(c.start), toMin(c.end));
    free.push(pastCut(iv, d).filter(([a, b]) => b - a >= minBlock));

    // 이동 중 학습: 대중교통일 때만, 비워둔 시간과 겹치지 않는 통학 구간
    let mv = [];
    if (p.commuteMode !== '자차') {
      for (const c of commutes.filter(x => x.day === d)) mv.push([toMin(c.start), toMin(c.end)]);
      for (const b of state.blocked.filter(x => x.day === d)) mv = subtract(mv, toMin(b.start), toMin(b.end));
    }
    moving.push(pastCut(mv, d).filter(([a, b]) => b - a >= 20));
  }

  // 1-b) 운동 등 반복 목표: 주 N회를 남은 요일에 고르게(되도록 하루씩 띄워) 배치
  const plan = [];
  const warnings = [];
  let seq = 0;
  for (const h of state.habits || []) {
    const ws = toMin(h.windowStart);
    const we = toMin(h.windowEnd);
    const fits = d => free[d].some(([a, b]) => Math.min(b, we) - Math.max(a, ws) >= h.minutes);
    const days = [];
    for (const gap of [2, 1, 0]) {
      for (let d = Math.max(0, today); d < 7 && days.length < h.perWeek; d++) {
        if (days.includes(d) || !fits(d)) continue;
        if (days.every(x => Math.abs(x - d) >= gap)) days.push(d);
      }
    }
    for (const d of days.sort((a, b) => a - b)) {
      const i = free[d].findIndex(([a, b]) => Math.min(b, we) - Math.max(a, ws) >= h.minutes);
      const [a, b] = free[d][i];
      const s = Math.max(a, ws);
      plan.push({ id: `b${++seq}`, taskId: h.id, day: d, start: toHHMM(s), end: toHHMM(s + h.minutes), habit: true });
      const rest = [];
      if (s - a >= minBlock) rest.push([a, s - 10]);
      if (b - (s + h.minutes + 10) >= minBlock) rest.push([s + h.minutes + 10, b]);
      free[d].splice(i, 1, ...rest);
    }
    if (days.length < h.perWeek) {
      const left = 7 - Math.max(0, today);
      warnings.push(`'${h.title}' 주 ${h.perWeek}회 중 ${days.length}회만 넣을 수 있었어요${left < h.perWeek ? ` (이번 주 남은 날 ${left}일)` : ''}.`);
    }
  }

  // 2) 과제를 실질 마감(목표일과 실제 마감 중 이른 것) 순으로 정렬
  const tasks = state.tasks
    .filter(t => !t.done)
    .map(t => {
      const due = deadlinePos(weekStart, new Date(t.due));
      let eff = due;
      if (t.goalDay != null) {
        const goal = { day: t.goalDay, minute: 24 * 60 };
        if (goal.day < eff.day || (goal.day === eff.day && goal.minute < eff.minute)) eff = goal;
      }
      return { t, eff, due };
    })
    .sort((a, b) => a.eff.day - b.eff.day || a.eff.minute - b.eff.minute);

  for (const { t, eff } of tasks) {
    let remaining = Math.round(t.hours * 60);
    if (eff.day < 0) { warnings.push(`'${t.title}' 마감이 이미 지났어요.`); continue; }
    const lastDay = Math.min(6, eff.day);

    // 2-a) 이동 중에 할 수 있는 과제는 통학 시간부터 채운다(공부량 상한에 넣지 않음)
    if (isMobileTask(t)) {
      for (let d = 0; d <= lastDay && remaining > 0; d++) {
        const limitEnd = d === eff.day ? eff.minute : 24 * 60;
        for (let i = 0; i < moving[d].length && remaining > 0; i++) {
          const [a, b] = moving[d][i];
          const len = Math.floor(Math.min(b, limitEnd, a + remaining) / 10) * 10 - a;
          if (len < 20) continue;
          plan.push({ id: `b${++seq}`, taskId: t.id, day: d, start: toHHMM(a), end: toHHMM(a + len), mobile: true });
          remaining -= len;
          moving[d][i] = [a + len, b];
        }
        moving[d] = moving[d].filter(([a, b]) => b - a >= 20);
      }
    }

    // 2-b) 책상 공부: 첫 바퀴는 하루 2블록까지(분산), 둘째 바퀴는 남은 시간 채우기
    const perDay = new Array(7).fill(0);
    for (const maxPerDay of [2, 99]) {
      for (let d = 0; d <= lastDay && remaining > 0; d++) {
        const limitEnd = d === eff.day ? eff.minute : 24 * 60;
        let i = 0;
        while (remaining > 0 && i < free[d].length && perDay[d] < maxPerDay) {
          const [a, b] = free[d][i];
          const end = Math.min(b, limitEnd);
          const room = Math.min(end - a, capOf(d) - used[d]);
          let len = Math.min(blockOf(d), remaining, room);
          if (len < remaining) len = Math.floor(len / 30) * 30;
          if (len <= 0 || len < Math.min(minBlock, remaining)) { i++; continue; }
          plan.push({ id: `b${++seq}`, taskId: t.id, day: d, start: toHHMM(a), end: toHHMM(a + len) });
          remaining -= len;
          used[d] += len;
          perDay[d]++;
          const na = a + len + breakOf(d);
          if (b - na >= minBlock) free[d][i] = [na, b];
          else free[d].splice(i, 1);
        }
      }
    }
    // 마감이 다음 주 이후인 과제는 남은 시간을 다음 주로 넘기면 되므로 경고하지 않는다
    if (remaining > 0 && eff.day <= 6) {
      const h = (remaining / 60).toFixed(1).replace(/\.0$/, '');
      const why = t.goalDay != null && eff.day === t.goalDay ? '목표일 전까지' : '마감 전까지';
      warnings.push(`'${t.title}' ${h}시간을 ${why} 배치하지 못했어요. 일정을 비우거나 하루 최대 공부시간을 늘려보세요.`);
    }
  }

  plan.sort((a, b) => a.day - b.day || toMin(a.start) - toMin(b.start));
  const spareMin = free.reduce((acc, iv) => acc + iv.reduce((x, [a, b]) => x + (b - a), 0), 0);
  return { plan, commutes, warnings, spareMin, today: { day: today, capMin: today >= 0 && today <= 6 ? capOf(today) : null, effect, recorded: !!cond } };
}

// 두 계획의 차이를 사람이 읽을 수 있게
export function diffPlans(oldPlan, newPlan, tasks, habits = []) {
  const key = b => `${b.taskId}|${b.day}|${b.start}|${b.end}`;
  const oldSet = new Set(oldPlan.map(key));
  const newSet = new Set(newPlan.map(key));
  const added = newPlan.filter(b => !oldSet.has(key(b)));
  const removed = oldPlan.filter(b => !newSet.has(key(b)));
  const title = id => (tasks.find(t => t.id === id) || habits.find(h => h.id === id) || {}).title || '과제';
  const lines = [];
  for (const b of removed.slice(0, 4)) lines.push(`− ${DAY_NAMES[b.day]} ${b.start}–${b.end} ${title(b.taskId)}`);
  for (const b of added.slice(0, 4)) lines.push(`+ ${DAY_NAMES[b.day]} ${b.start}–${b.end} ${title(b.taskId)}`);
  const more = added.length + removed.length - lines.length;
  if (more > 0) lines.push(`… 외 ${more}건`);
  return { added: added.length, removed: removed.length, lines };
}
