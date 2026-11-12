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

/**
 * state: { classes, events, blocked, tasks, prefs }
 * opts: { weekStart: Date, now: Date }
 * returns { plan: [{id, taskId, day, start, end}], warnings: [string] }
 */
export function schedule(state, { weekStart, now }) {
  const p = state.prefs;
  const studyStart = toMin(p.studyStart);
  const studyEnd = toMin(p.studyEnd);
  const blockLen = p.blockMin;
  const minBlock = 30;
  const breakMin = 10;
  const dailyCap = p.dailyMax * 60;

  // 1) 요일별 빈 시간 계산
  const free = [];
  const used = new Array(7).fill(0);
  for (let d = 0; d < 7; d++) {
    let iv = [[studyStart, studyEnd]];
    const busy = [
      ...state.classes.filter(c => c.day === d),
      ...state.events.filter(e => e.day === d),
      ...state.blocked.filter(b => b.day === d),
    ];
    for (const b of busy) iv = subtract(iv, toMin(b.start) - 10, toMin(b.end) + 10);
    // 이미 지난 시간 제외
    const dayDate = dateOfDay(weekStart, d);
    const nowPos = deadlinePos(weekStart, now);
    if (nowPos.day > d) iv = [];
    else if (nowPos.day === d) {
      const cut = Math.ceil(nowPos.minute / 30) * 30;
      iv = subtract(iv, 0, cut);
    }
    void dayDate;
    free.push(iv.filter(([a, b]) => b - a >= minBlock));
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

  const plan = [];
  const warnings = [];
  let seq = 0;

  for (const { t, eff, due } of tasks) {
    let remaining = Math.round(t.hours * 60);
    if (eff.day < 0) { warnings.push(`'${t.title}' 마감이 이미 지났어요.`); continue; }
    const perDay = new Array(7).fill(0);
    const lastDay = Math.min(6, eff.day);

    // 두 바퀴: 첫 바퀴는 하루 2블록까지(분산), 둘째 바퀴는 제한 없이 남은 시간 채우기
    for (const maxPerDay of [2, 99]) {
      for (let d = 0; d <= lastDay && remaining > 0; d++) {
        const limitEnd = d === eff.day ? eff.minute : 24 * 60;
        let i = 0;
        while (remaining > 0 && i < free[d].length && perDay[d] < maxPerDay) {
          const [a, b] = free[d][i];
          const end = Math.min(b, limitEnd);
          const room = Math.min(end - a, dailyCap - used[d]);
          let len = Math.min(blockLen, remaining, room);
          if (len < remaining) len = Math.floor(len / 30) * 30;
          if (len <= 0 || len < Math.min(minBlock, remaining)) { i++; continue; }
          plan.push({ id: `b${++seq}`, taskId: t.id, day: d, start: toHMM(a), end: toHMM(a + len) });
          remaining -= len;
          used[d] += len;
          perDay[d]++;
          const na = a + len + breakMin;
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
  return { plan, warnings };
}

function toHMM(m) { return toHHMM(m); }

// 두 계획의 차이를 사람이 읽을 수 있게
export function diffPlans(oldPlan, newPlan, tasks) {
  const key = b => `${b.taskId}|${b.day}|${b.start}|${b.end}`;
  const oldSet = new Set(oldPlan.map(key));
  const newSet = new Set(newPlan.map(key));
  const added = newPlan.filter(b => !oldSet.has(key(b)));
  const removed = oldPlan.filter(b => !newSet.has(key(b)));
  const title = id => (tasks.find(t => t.id === id) || {}).title || '과제';
  const lines = [];
  for (const b of removed.slice(0, 4)) lines.push(`− ${DAY_NAMES[b.day]} ${b.start}–${b.end} ${title(b.taskId)}`);
  for (const b of added.slice(0, 4)) lines.push(`+ ${DAY_NAMES[b.day]} ${b.start}–${b.end} ${title(b.taskId)}`);
  const more = added.length + removed.length - lines.length;
  if (more > 0) lines.push(`… 외 ${more}건`);
  return { added: added.length, removed: removed.length, lines };
}
