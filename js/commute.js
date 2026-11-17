// 오늘의 통학길: 추천 카드 3종(빠른·여유로운·걷는 길) + 변수 경고(막차 역산·비·지연) + 학생 제보
// 혼잡은 '수업 시작 시각 분포'로 예측한다. 실제 서비스: 서울시 실시간 도착정보·역별 승하차 공공데이터 + 학생 제보.
import { DAY_NAMES, toMin, toHHMM, localDateKey } from './scheduler.js';

// 대학가 공통 수업 시작 시각(시연값). 실제로는 대학별 시간표 분포를 쓴다.
const COMMON_STARTS = ['09:00', '10:30', '12:00', '13:30', '15:00', '16:30'].map(toMin);
// 막차(시연값). 실제로는 버스 도착정보·지하철 시간표 API로 노선별 조회.
export const LAST = { 버스: '23:20', 지하철: '23:40' };
const LV = ['여유', '보통', '혼잡', '만차'];

function crowdAt(arrive, starts) {
  // 수업 시작 25분 전~시작 사이에 도착하면 혼잡, 25~45분 전이면 보통
  let lv = 0;
  for (const s of starts) {
    const gap = s - arrive;
    if (gap >= 0 && gap <= 25) lv = Math.max(lv, 2);
    else if (gap > 25 && gap <= 45) lv = Math.max(lv, 1);
  }
  return lv;
}

export function sampleReports(now) {
  const k = localDateKey(now);
  const ago = m => toHHMM(Math.max(0, now.getHours() * 60 + now.getMinutes() - m));
  return [
    { id: 'r1', date: k, time: ago(95), kind: '요령', text: '군자역은 맨 앞칸 쪽 계단이 덜 붐벼요', fake: true },
    { id: 'r2', date: k, time: ago(40), kind: '여유', text: '721번 버스 앞 정류장에서 타면 자리 있음', fake: true },
    { id: 'r3', date: k, time: ago(12), kind: '만차', text: '어린이대공원역 7호선 상행 만차, 두 대 보냄', fake: true },
  ];
}

export function lastRide(state, day) {
  const items = [...state.classes, ...state.events].filter(x => x.day === day);
  if (!items.length) return null;
  const last = items.reduce((a, b) => (toMin(b.end) > toMin(a.end) ? b : a));
  const leave = toMin(last.end) + 10;
  const mode = state.prefs.commuteMode === '버스' ? '버스' : '지하철';
  let lastMin = toMin(LAST[mode]);
  if (lastMin < 6 * 60) lastMin += 24 * 60;
  const ride = Number(state.prefs.rideMin || state.prefs.commuteMin) || 50;
  const mustLeave = lastMin - 10; // 막차 10분 전에는 정류장 도착
  const margin = mustLeave - leave;
  return { item: last, leave: toHHMM(leave), mode, last: LAST[mode], mustLeave: toHHMM(mustLeave % (24 * 60)), margin, ride };
}

export function commuteCards(state, { day, rain = false, now }) {
  const p = state.prefs;
  const base = Number(p.rideMin || p.commuteMin) || 50;
  const first = state.classes.filter(c => c.day === day).sort((a, b) => toMin(a.start) - toMin(b.start))[0];
  const starts = [...new Set([...COMMON_STARTS, ...state.classes.map(c => toMin(c.start))])];
  const target = first ? toMin(first.start) - 10 : 9 * 60;
  const cond = state.condition && state.condition.date === localDateKey(now) ? state.condition : null;
  const tired = !!(cond && ((cond.sleep != null && cond.sleep < 6) || (cond.stress != null && cond.stress >= 4)));
  const nowM = now.getHours() * 60 + now.getMinutes();
  const reports = (state.reports || []).filter(r => r.date === localDateKey(now) && nowM - toMin(r.time) >= 0 && nowM - toMin(r.time) <= 30);
  const fullNow = reports.some(r => r.kind === '만차');
  const rainAdd = rain ? 10 : 0;

  const mk = (id, name, sub, ride, walk, early, crowdShift) => {
    const arrive = target - early;
    let crowd = Math.min(3, Math.max(0, crowdAt(arrive, starts) + crowdShift + (rain ? 1 : 0)));
    if (id === 'fast' && fullNow && crowd >= 2) crowd = 3;
    const depart = arrive - ride - walk - rainAdd;
    return { id, name, sub, ride, walk, early, crowd, crowdLabel: LV[crowd], depart: toHHMM(depart), arrive: toHHMM(arrive), total: ride + walk };
  };
  const cards = [
    mk('fast', '빠른 길', '가장 늦게 출발, 수업 직전 도착', base, 6, 0, 0),
    mk('relaxed', '여유로운 길', '20분 일찍 출발 · 앞 정류장에서 탑승', base + 4, 9, 20, -1),
    mk('walk', '걷는 길', '한 정거장 걸어 혼잡 구간 회피', base - 3, 16, 5, -1),
  ];
  // 추천 순서: 시간 + 혼잡 + 피로·비를 함께 본다
  const score = c => -c.total - c.early * 0.4 - c.crowd * 14 - (c.id === 'walk' && (rain || tired) ? 30 : 0) + (c.id === 'walk' && !rain && !tired ? 4 : 0);
  cards.forEach(c => {
    c.score = score(c);
    c.why = [];
    if (c.id === 'fast') c.why.push(c.crowd >= 2 ? `수업 직전 도착이라 ${c.crowdLabel} 예상${fullNow ? ' (방금 만차 제보)' : ''}` : '이 시간대는 비교적 한산');
    if (c.id === 'relaxed') c.why.push('수업 시작 몰림을 피해 앉아 갈 확률↑', '도착 후 20분은 가벼운 공부·준비 시간');
    if (c.id === 'walk') c.why.push(rain ? '비 오는 날엔 비추천' : tired ? '피로도가 높아 오늘은 비추천' : '혼잡 구간을 걸어서 건너뜀 · 걸음 수 +1,200');
  });
  const ranked = [...cards].sort((a, b) => b.score - a.score);
  return { cards, best: ranked[0], first, day, tired, rain, reports };
}

export function warnings(state, { day, rain, now }) {
  const out = [];
  const lr = lastRide(state, day);
  if (lr && toMin(lr.item.end) >= 20 * 60) {
    out.push(lr.margin < 15
      ? { lv: 'bad', text: `막차 위험: '${lr.item.title}' 끝나고 ${lr.leave} 출발하면 ${lr.mode} 막차(환승 기준 ${lr.last}, 시연값)가 빠듯해요. 늦어도 ${lr.mustLeave}에는 정류장에 있어야 해요.` }
      : { lv: 'ok', text: `막차 역산: '${lr.item.title}' 끝나고 ${lr.leave} 출발 → ${lr.mode} 막차(환승 기준 ${lr.last}, 시연값)까지 ${lr.margin}분 여유. 늦어도 ${lr.mustLeave}까지는 역에 도착하세요.` });
  }
  if (rain) out.push({ lv: 'warn', text: '비 예보: 정류장이 더 붐벼요. 출발을 10분 앞당겨 계산했어요.' });
  const d = state.commuteDelay && state.commuteDelay.date === localDateKey(now) && state.commuteDelay.min;
  if (d && day === (now.getDay() + 6) % 7) out.push({ lv: 'warn', text: `지연 감지: ${state.commuteDelay.line || '지하철'} ${d}분 지연이 반영돼 있어요. 오늘 남은 일정은 이미 다시 짰어요.` });
  return out;
}
