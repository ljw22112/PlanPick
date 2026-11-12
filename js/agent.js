// 에이전트 판단 모듈: 먼저 챙겨주는 브리핑·회고·위험 예보·번아웃·공강 활용·배치 이유
import { DAY_NAMES, toMin, toHHMM, dateOfDay, isMobileTask, localDateKey } from './scheduler.js';

const hours = m => (m / 60).toFixed(1).replace(/\.0$/, '');
const titleOf = (state, id) => ((state.tasks.find(t => t.id === id) || (state.habits || []).find(h => h.id === id) || {}).title) || '';

// 수업 사이 50분~3시간 공강 → 할 일 추천
export function gapsFor(state, sched, day) {
  const cs = state.classes.filter(c => c.day === day).sort((a, b) => toMin(a.start) - toMin(b.start));
  const out = [];
  for (let i = 0; i + 1 < cs.length; i++) {
    const a = toMin(cs[i].end);
    const b = toMin(cs[i + 1].start);
    const len = b - a;
    if (len < 50 || len > 180) continue;
    const open = state.tasks.filter(t => !t.done).sort((x, y) => x.due.localeCompare(y.due));
    const pick = open.find(t => isMobileTask(t)) || open[0];
    out.push({ day, start: toHHMM(a), end: toHHMM(b), len, suggestion: pick ? pick.title : null, place: len >= 90 ? '도서관 열람실' : '강의동 라운지' });
  }
  return out;
}

// 마감 3일 이내 과제 중 계획 시간이 필요한 시간보다 적거나 여유가 없는 것
export function deadlineRisks(state, sched, { weekStart, now }) {
  const out = [];
  for (const t of state.tasks.filter(x => !x.done)) {
    const due = new Date(t.due);
    const daysLeft = (due - now) / 86400000;
    if (daysLeft > 3 || daysLeft < 0) continue;
    const ratio = (sched.learned && sched.learned.ratio[t.course]) || 1;
    const need = Math.max(0, t.hours * 60 * ratio - (t.doneMin || 0));
    const placed = sched.plan.filter(b => b.taskId === t.id).reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0);
    if (need <= 0) continue;
    if (placed + 10 < need) out.push({ task: t, level: 'high', text: `'${t.title}' ${hours(need - placed)}시간이 모자라요 (마감 ${Math.ceil(daysLeft * 24)}시간 전)` });
    else if (daysLeft < 1 && need > 120) out.push({ task: t, level: 'mid', text: `'${t.title}' 오늘 ${hours(need)}시간을 끝내야 해요` });
  }
  return out;
}

// 주간·일간 부하로 번아웃 위험 판정
export function burnout(state, sched) {
  const load = new Array(7).fill(0);
  const add = (d, s, e) => { load[d] += toMin(e) - toMin(s); };
  for (const c of state.classes) add(c.day, c.start, c.end);
  for (const e of state.events) add(e.day, e.start, e.end);
  for (const b of sched.plan) add(b.day, b.start, b.end);
  for (const c of sched.commutes) add(c.day, c.start, c.end);
  const total = load.reduce((a, b) => a + b, 0);
  const peak = Math.max(...load);
  const peakDay = load.indexOf(peak);
  const restDays = load.filter(m => m < 120).length;
  let level = 'ok';
  if (total > 60 * 60 || peak > 12 * 60 || restDays === 0) level = 'high';
  else if (total > 50 * 60 || peak > 10 * 60) level = 'mid';
  return { level, totalH: hours(total), peakH: hours(peak), peakDay, restDays, load };
}

// 최근 7일 중 스트레스 4 이상이 3일 이상이면 학교 상담 안내
export function counselingNote(state, now) {
  const h = state.condHistory || {};
  let n = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const r = h[localDateKey(d)];
    if (r && r.stress >= 4) n++;
  }
  return n >= 3 ? `최근 7일 중 ${n}일 스트레스가 높았어요. 공부량을 줄여 두었고, 힘들면 학교 학생상담센터에 이야기해 보는 것도 방법이에요.` : null;
}

// 블록 배치 이유를 문장으로
export function explainBlock(state, b) {
  const t = titleOf(state, b.taskId);
  const why = (b.why || []).join(', ');
  return `'${t}'을 ${DAY_NAMES[b.day]}요일 ${b.start}–${b.end}에 둔 이유: ${why || '빈 시간 중 가장 이른 시간'}.`;
}

// 배치 못 한 과제가 있을 때 고를 수 있는 선택지
export function feasibilityOptions(state, sched) {
  const opts = [];
  const iss = sched.issues || [];
  if (!iss.length) return opts;
  if (state.prefs.dailyMax < 8) opts.push({ label: `하루 최대 ${state.prefs.dailyMax + 1}시간으로 늘리기`, ops: [{ type: 'set_preferences', daily_max_hours: state.prefs.dailyMax + 1 }] });
  const goalIss = iss.find(i => i.goal);
  if (goalIss) opts.push({ label: '앞당긴 목표일 풀기', ops: [{ type: 'set_task_goal', task_id: goalIss.taskId, finish_by_day: null }] });
  const blocked = state.blocked.filter(b => !b.recurring);
  if (blocked.length) opts.push({ label: `비워둔 시간 하나 풀기 (${DAY_NAMES[blocked[0].day]} ${blocked[0].start})`, ops: [{ type: 'remove_item', id: blocked[0].id }] });
  const t = state.tasks.find(x => x.id === iss[0].taskId);
  if (t && t.hours > 1) opts.push({ label: `'${t.title.slice(0, 12)}…' 목표를 ${Math.max(1, t.hours - 1)}시간으로 줄이기`, ops: [{ type: 'update_task', task_id: t.id, hours: Math.max(1, t.hours - 1) }] });
  return opts;
}

// 지난 계획 중 기록 없이 지나간 블록 → 자동 재배치 안내
export function missedSince(lastPlan, state, { weekStart, now }) {
  if (!lastPlan || !lastPlan.blocks) return null;
  const logged = new Set((state.log || []).map(l => `${l.taskId}|${l.date}`));
  const missed = lastPlan.blocks.filter(b => {
    if (b.habit) return false;
    const d = dateOfDay(weekStart, b.day);
    const [h, m] = b.end.split(':').map(Number);
    d.setHours(h, m, 0, 0);
    return d < now && d > new Date(lastPlan.at) && !logged.has(`${b.taskId}|${localDateKey(dateOfDay(weekStart, b.day))}`) && state.tasks.some(t => t.id === b.taskId && !t.done);
  });
  if (!missed.length) return null;
  const min = missed.reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0);
  return { count: missed.length, min, titles: [...new Set(missed.map(b => titleOf(state, b.taskId)))] };
}

// 아침 브리핑 / 저녁 회고 데이터
export function briefing(state, sched, ctx, feedRecs = []) {
  const { now, weekStart } = ctx;
  const today = (now.getDay() + 6) % 7;
  const hour = now.getHours();
  const kind = hour >= 20 ? 'evening' : hour < 12 ? 'morning' : 'day';
  const todayBlocks = sched.plan.filter(b => b.day === today);
  const nowMin = hour * 60 + now.getMinutes();
  const upcoming = todayBlocks.filter(b => toMin(b.end) > nowMin);
  const tomorrow = sched.plan.filter(b => b.day === today + 1);
  const saved = (state.saved || []);
  const actDeadlines = feedRecs.filter(r => saved.includes(r.opp.id) && r.daysLeft <= 5);
  return {
    kind,
    upcoming,
    tomorrow,
    gaps: gapsFor(state, sched, today).filter(g => toMin(g.end) > nowMin),
    risks: deadlineRisks(state, sched, ctx),
    burn: burnout(state, sched),
    counsel: counselingNote(state, now),
    actDeadlines,
    weekStart,
  };
}
