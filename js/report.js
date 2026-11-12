// 주간 리포트·학기 회고
import { toMin, learnStats } from './scheduler.js';

const h = m => Math.round((m / 60) * 10) / 10;

export function weeklyReport(state, sched) {
  const sum = arr => arr.reduce((a, x) => a + toMin(x.end) - toMin(x.start), 0);
  const byKind = k => state.events.filter(e => (e.kind || '기타') === k);
  const split = [
    { label: '수업', min: sum(state.classes), color: '#94a3b8' },
    { label: '공부(계획)', min: sum(sched.plan.filter(b => !b.habit && !b.mobile)), color: '#3b5bfd' },
    { label: '이동 중 학습', min: sum(sched.plan.filter(b => b.mobile)), color: '#93c5fd' },
    { label: '알바', min: sum(byKind('알바')), color: '#ff8a3d' },
    { label: '대외활동', min: sum(byKind('대외활동')), color: '#8b5cf6' },
    { label: '운동·어학', min: sum(sched.plan.filter(b => b.habit)) + sum(byKind('운동')), color: '#16a34a' },
    { label: '통학', min: sum(sched.commutes), color: '#cbd5e1' },
  ].filter(x => x.min > 0);
  const log = state.log || [];
  const done = log.filter(l => l.done);
  const rate = log.length ? Math.round((done.length / log.length) * 100) : null;
  const L = learnStats(log);
  const courses = Object.entries(L.byCourse).map(([k, v]) => ({ course: k, actualH: h(v.actual), plannedH: h(v.planned), ratio: Math.round((v.actual / v.planned) * 100) / 100 })).sort((a, b) => b.actualH - a.actualH);
  const hourBars = L.hours.map((x, i) => ({ hour: i, n: x.n, rate: x.n ? x.ok / x.n : 0 })).filter(x => x.hour >= 7);
  const tips = [];
  for (const c of courses) {
    if (c.ratio >= 1.25) tips.push(`${c.course}: 예상보다 ${Math.round((c.ratio - 1) * 100)}% 더 걸려요. 다음 과제는 예상 시간을 늘려 잡았어요.`);
    if (c.ratio <= 0.8) tips.push(`${c.course}: 예상보다 빨리 끝내요. 남는 시간을 약한 과목에 돌려보세요.`);
  }
  if (L.focus.length) tips.push(`집중이 잘 되는 시간대는 ${L.focus.map(x => `${x}시`).join(', ')}예요. 어려운 과제를 이때 배치해요.`);
  if (rate != null && rate < 60) tips.push('계획 달성률이 60% 아래예요. 블록 길이를 줄이면 달성률이 올라가는 경우가 많아요.');
  return { split, rate, logged: log.length, courses, hourBars, focus: L.focus, tips };
}
