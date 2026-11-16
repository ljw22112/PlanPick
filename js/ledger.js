// 시간 가계부: 남는 시간을 예산(비율)처럼 쓰고, 계획·실제 사용·잔액을 보여준다.
import { DAY_NAMES, toMin, toHHMM, localDateKey, dateOfDay, BUDGET_CATS, isMobileTask } from './scheduler.js';

export const CAT_COLORS = { 공부: '#4f6bed', 운동: '#16a34a', 자기계발: '#d97706', 휴식: '#db2777' };
export const CAT_ICONS = { 공부: '책', 운동: '몸', 자기계발: '성장', 휴식: '쉼' };

// 실행 기록 하나가 어느 '지출' 항목인지
export function catOfLog(state, l) {
  if (l.taskId === 'rest') return '휴식';
  const h = (state.habits || []).find(x => x.id === l.taskId);
  if (h) return h.kind === '어학' ? '자기계발' : '운동';
  const t = state.tasks.find(x => x.id === l.taskId);
  if (t && t.course === '대외활동') return '자기계발';
  if (l.course === '어학') return '자기계발';
  if (l.course === '운동') return '운동';
  return '공부';
}

// 이번 주 실제 사용(기록 기준)
export function actuals(state, weekStart) {
  const from = localDateKey(weekStart);
  const to = localDateKey(dateOfDay(weekStart, 6));
  const out = Object.fromEntries(BUDGET_CATS.map(c => [c, 0]));
  const items = [];
  for (const l of state.log || []) {
    if (!l.date || l.date < from || l.date > to || !l.done) continue;
    const c = catOfLog(state, l);
    out[c] += l.actual || 0;
    items.push({ ...l, cat: c });
  }
  return { spent: out, items: items.reverse() };
}

// 가계부 요약: 예산·계획·사용·잔액
export function ledgerView(state, sched, weekStart) {
  const L = sched.ledger;
  const { spent, items } = actuals(state, weekStart);
  const rows = BUDGET_CATS.map(c => ({
    cat: c, pct: L.budget[c], target: L.target[c], planned: L.planned[c], spent: spent[c],
    left: Math.max(0, L.target[c] - spent[c]), color: CAT_COLORS[c],
  }));
  return { baseMin: L.baseMin, mobileMin: L.mobileMin, rows, items };
}

const r5 = x => Math.round(x / 5) * 5;

// AI 비율 제안: 이번 주 마감 부담·운동 목표·컨디션을 보고 예산을 다시 나눈다
export function suggestBudget(state, sched, now) {
  const L = sched.ledger;
  const base = Math.max(1, L.baseMin);
  const week = new Date(now.getTime() + 7 * 864e5);
  const due = state.tasks.filter(t => !t.done && new Date(t.due) <= week && t.course !== '대외활동');
  const need = due.reduce((a, t) => a + Math.max(0, t.hours * 60 - (t.doneMin || 0)), 0) * 1.15;
  const ex = (state.habits || []).filter(h => h.kind !== '어학').reduce((a, h) => a + h.perWeek * h.minutes, 0);
  const dev = (state.habits || []).filter(h => h.kind === '어학').reduce((a, h) => a + h.perWeek * h.minutes, 0)
    + state.tasks.filter(t => !t.done && t.course === '대외활동').reduce((a, t) => a + t.hours * 60, 0);
  const tired = sched.today && sched.today.effect && sched.today.effect.factor < 0.8;
  let study = Math.min(70, Math.max(30, r5((need / base) * 100 + 5)));
  let exercise = Math.min(25, Math.max(10, r5((ex / base) * 100 + 2)));
  let growth = Math.min(20, Math.max(5, r5((dev / base) * 100 + 2)));
  let rest = 100 - study - exercise - growth;
  const minRest = tired ? 25 : 15;
  const maxRest = tired ? 35 : 30;
  if (rest < minRest) { const cut = minRest - rest; study -= cut; rest = minRest; }
  let surplus = 0;
  if (rest > maxRest) { surplus = rest - maxRest; rest = maxRest; } // 남는 몫은 공부 여유분으로
  const needPct = study;
  study += surplus;
  const reasons = [];
  reasons.push(due.length ? `7일 안 마감 ${due.length}개, 여유 15% 포함 약 ${Math.round(need / 60)}시간 필요 → 공부 ${needPct}%` : `급한 마감이 없어 공부 ${needPct}%`);
  if (surplus) reasons.push(`남는 ${surplus}%는 밀릴 때를 대비한 공부 여유분으로 → 공부 ${study}%`);
  reasons.push(`운동 목표 주 ${Math.round(ex / 60 * 10) / 10}시간 → 운동 ${exercise}%`);
  if (dev) reasons.push(`어학·대외활동 준비 → 자기계발 ${growth}%`);
  reasons.push(tired ? `컨디션이 낮아 휴식을 ${rest}%로 넉넉히` : `번아웃 예방용 휴식 ${rest}% 확보`);
  if (study >= 60) reasons.push('마감 주간이 지나면 다음 주에 휴식 비율을 돌려드릴게요.');
  return { budget: { 공부: study, 운동: exercise, 자기계발: growth, 휴식: rest }, reasons };
}

// 계획과 연결된 통학 경로(시연 데이터). 실제 서비스: 카카오맵 대중교통·도보 경로 API + 서울시 실시간 지하철 도착정보
export function routeOptions(state, sched, now, dayIdx) {
  const p = state.prefs;
  const delay = state.commuteDelay && state.commuteDelay.date === localDateKey(now) ? state.commuteDelay.minutes : 0;
  const first = state.classes.filter(c => c.day === dayIdx).sort((a, b) => toMin(a.start) - toMin(b.start))[0];
  const base = p.commuteMin || 50;
  const opts = [
    { id: 'r1', name: '지하철 직행', mode: '지하철', min: base + delay, transfers: 0, seat: '혼잡 · 서서 이동', studyMin: 0, walk: 8, note: delay ? `실시간 지연 +${delay}분 반영` : '평소 경로' },
    { id: 'r2', name: '광역버스 1회', mode: '버스', min: base + 10, transfers: 0, seat: '좌석 확보 가능', studyMin: Math.max(0, base - 5), walk: 6, note: '앉아서 단어·강의 복습 가능' },
    { id: 'r3', name: '지하철+버스 환승', mode: '지하철', min: base - 5 + Math.round(delay / 2), transfers: 1, seat: '환승 1회 · 짧게 끊김', studyMin: 20, walk: 12, note: delay ? '지연 구간 일부 우회' : '가장 빠름' },
  ];
  const pickStudy = (state.tasks || []).some(t => !t.done && isMobileTask(t)) || (state.habits || []).some(h => h.kind === '어학');
  // 추천: 수업에 늦지 않는 경로 중, 이동 중 공부할 거리가 있으면 앉아 갈 수 있는 경로 우선
  const deadline = first ? toMin(first.start) - 10 : null;
  for (const o of opts) {
    o.depart = deadline != null ? toHHMM(deadline - o.min - o.walk) : null;
    o.score = -o.min + (pickStudy ? o.studyMin * 0.8 : 0) - o.transfers * 5;
  }
  const best = [...opts].sort((a, b) => b.score - a.score)[0];
  const why = [];
  if (first) why.push(`${DAY_NAMES[dayIdx]}요일 첫 수업 ${first.title} ${first.start} — 10분 여유 두고 도착`);
  if (delay) why.push(`지하철 지연 ${delay}분을 반영했어요`);
  if (pickStudy && best.studyMin) why.push(`이동 중 할 수 있는 과제가 있어 앉아 가는 경로로 ${best.studyMin}분 학습 확보`);
  else why.push('가장 빨리 도착하는 경로');
  return { options: opts, best, first, why, delay };
}
