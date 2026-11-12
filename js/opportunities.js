// 대외활동 추천: 희망 분야 + 내 시간표 적합도 + 지원 준비 가능 여부로 점수를 매긴다.
// 데모 피드는 '가상' 공고다. 실제 서비스는 대외활동 플랫폼·학교 비교과 시스템의 공고를 수집해 같은 방식으로 점수화한다.
import { schedule, toMin, DAY_NAMES } from './scheduler.js';
import { clone, applyOp, localISO } from './state.js';

const rel = (now, days, hhmm = '23:59') => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  const [h, m] = hhmm.split(':').map(Number);
  d.setHours(h, m, 0, 0);
  return localISO(d);
};

// type: fixed(정해진 요일·시간에 활동) | flex(주당 시간만 정해짐)
export function sampleFeed(now = new Date()) {
  return [
    { id: 'o1', title: '대학생 AI 서비스 아이디어 공모전', org: '(가상) 한빛AI재단', category: '공모전', fields: ['AI·데이터', '창업', '기획', '취업'], deadline: rel(now, 9), prepHours: 6, schedule: { type: 'flex', hoursPerWeek: 3 }, benefit: '상금, 우수팀 인턴 연계', posted: 0 },
    { id: 'o2', title: '데이터 분석 서포터즈 3기', org: '(가상) 데이터온', category: '서포터즈', fields: ['AI·데이터', '마케팅'], deadline: rel(now, 4), prepHours: 2, schedule: { type: 'fixed', day: 2, start: '19:00', end: '21:00' }, benefit: '활동비, 수료증', posted: 1 },
    { id: 'o3', title: '청년 창업 주말 부트캠프', org: '(가상) 스타트업캠퍼스', category: '교육', fields: ['창업', '기획'], deadline: rel(now, 6), prepHours: 3, schedule: { type: 'fixed', day: 5, start: '10:00', end: '17:00' }, benefit: '멘토링, 시드 지원 연계', posted: 3 },
    { id: 'o4', title: '핀테크 해커톤', org: '(가상) 미래금융랩', category: '해커톤', fields: ['개발', '금융', 'AI·데이터'], deadline: rel(now, 2), prepHours: 2, schedule: { type: 'fixed', day: 6, start: '10:00', end: '20:00' }, benefit: '상금, 채용 연계', posted: 5 },
    { id: 'o5', title: '브랜드 마케팅 대학생 기자단', org: '(가상) 브랜드앤유', category: '기자단', fields: ['마케팅', '디자인'], deadline: rel(now, 12), prepHours: 2, schedule: { type: 'flex', hoursPerWeek: 4 }, benefit: '활동비', posted: 2 },
    { id: 'o6', title: 'UX 디자인 챌린지', org: '(가상) 디자인하우스랩', category: '공모전', fields: ['디자인', '기획'], deadline: rel(now, 8), prepHours: 5, schedule: { type: 'flex', hoursPerWeek: 3 }, benefit: '상금', posted: 4 },
    { id: 'o7', title: '아동 코딩교육 봉사단', org: '(가상) 코드나눔', category: '봉사', fields: ['봉사', '개발'], deadline: rel(now, 5), prepHours: 1, schedule: { type: 'fixed', day: 3, start: '16:00', end: '18:00' }, benefit: '봉사시간 인정', posted: 1 },
    { id: 'o8', title: '글로벌 대학생 교류 프로그램', org: '(가상) 아시아청년네트워크', category: '교류', fields: ['글로벌'], deadline: rel(now, 15), prepHours: 4, schedule: { type: 'flex', hoursPerWeek: 2 }, benefit: '해외 연수', posted: 6 },
    { id: 'o9', title: '캠퍼스 ESG 아이디어 공모전', org: '(가상) 그린내일', category: '공모전', fields: ['환경·ESG', '기획', '창업'], deadline: rel(now, 10), prepHours: 5, schedule: { type: 'flex', hoursPerWeek: 2 }, benefit: '상금', posted: 2 },
    { id: 'o12', title: 'IT 기업 겨울방학 체험형 인턴', org: '(가상) 테크브릿지', category: '인턴', fields: ['취업', '개발', 'AI·데이터'], deadline: rel(now, 11), prepHours: 4, schedule: { type: 'flex', hoursPerWeek: 1 }, benefit: '방학 4주 인턴, 수료증', posted: 1 },
    { id: 'o10', title: '온디바이스 AI 경량화 챌린지', org: '(가상) 엣지AI연구회', category: '챌린지', fields: ['AI·데이터', '개발'], deadline: rel(now, 3), prepHours: 3, schedule: { type: 'flex', hoursPerWeek: 5 }, benefit: '상금, 연구실 인턴', posted: 0 },
  ];
}

// '새 공고 도착' 시연용
export function incomingPost(now = new Date()) {
  return { id: 'o11', title: '생성형 AI 캠퍼스 앰배서더', org: '(가상) 넥스트AI', category: '서포터즈', fields: ['AI·데이터', '마케팅'], deadline: rel(now, 7), prepHours: 2, schedule: { type: 'flex', hoursPerWeek: 2 }, benefit: '활동비, AI 도구 이용권', posted: 0 };
}

const overlap = (a1, a2, b1, b2) => toMin(a1) < toMin(b2) && toMin(b1) < toMin(a2);

/**
 * returns [{ opp, score, match, reasons:[], fit: 'ok'|'clash'|'tight', clashWith }]
 */
export function recommend(state, feed, { weekStart, now }) {
  const interests = state.interests || [];
  const base = schedule(state, { weekStart, now });
  const spare = base.spareMin;
  const out = [];
  for (const opp of feed) {
    const match = opp.fields.filter(f => interests.includes(f));
    if (interests.length && !match.length) continue;
    const reasons = [];
    let score = interests.length ? Math.round((45 * match.length) / Math.min(interests.length, opp.fields.length)) : 20;
    score = Math.min(45, score);
    if (match.length) reasons.push(`희망 분야 일치: ${match.join(', ')}`);

    // 시간 적합도
    let fit = 'ok';
    let clashWith = null;
    if (opp.schedule.type === 'fixed') {
      const { day, start, end } = opp.schedule;
      const busy = [
        ...state.classes.filter(c => c.day === day).map(c => ({ ...c, label: `${c.title} 수업` })),
        ...state.events.filter(e => e.day === day).map(e => ({ ...e, label: e.title })),
      ];
      const hit = busy.find(b => overlap(start, end, b.start, b.end));
      if (hit) { fit = 'clash'; clashWith = hit.label; reasons.push(`${DAY_NAMES[day]} ${start}–${end}이 '${hit.label}'와 겹침`); }
      else { score += 30; reasons.push(`${DAY_NAMES[day]} ${start}–${end} 활동이 시간표와 안 겹침`); }
    } else {
      const need = opp.schedule.hoursPerWeek * 60;
      if (spare >= need * 1.5) { score += 30; reasons.push(`주 ${opp.schedule.hoursPerWeek}시간, 이번 주 여유 ${Math.floor(spare / 60)}시간으로 충분`); }
      else if (spare >= need) { score += 15; fit = 'tight'; reasons.push(`주 ${opp.schedule.hoursPerWeek}시간, 여유가 빠듯함`); }
      else { fit = 'tight'; reasons.push(`주 ${opp.schedule.hoursPerWeek}시간이 필요한데 이번 주 여유가 부족`); }
    }

    // 지원서 준비 시간이 마감 전에 들어가는지 (실제 스케줄러로 시뮬레이션)
    const draft = clone(state);
    applyOp(draft, { type: 'add_task', title: `__probe_${opp.id}`, course: '대외활동', due: opp.deadline, hours: opp.prepHours });
    const sim = schedule(draft, { weekStart, now });
    const probeWarn = sim.warnings.some(w => w.includes(`__probe_${opp.id}`));
    const daysLeft = Math.ceil((new Date(opp.deadline) - now) / 86400000);
    if (probeWarn) { reasons.push(`지원서 준비 ${opp.prepHours}시간을 마감 전에 넣기 어려움`); if (fit === 'ok') fit = 'tight'; }
    else { score += 15; reasons.push(`지원서 준비 ${opp.prepHours}시간을 마감 전에 배치 가능`); }
    if (daysLeft <= 7) score += 10;

    out.push({ opp, score: Math.min(100, score), match, reasons, fit, clashWith, daysLeft });
  }
  return out.sort((a, b) => b.score - a.score || a.daysLeft - b.daysLeft);
}
