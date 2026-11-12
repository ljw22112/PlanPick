// 첫 방문 관심사 선택(핀터레스트형 카드) → 기능 모듈과 희망 분야를 정해 화면을 맞춤화한다
import { applyOp, clone } from './state.js';

// kind: mod(생활 기능) | field(대외활동 희망 분야)
export const TILES = [
  { id: 'study', kind: 'mod', title: '학점 관리', sub: '과제·시험 공부를 빈 시간에 자동 배치', h: 210, c1: '#4f7cff', c2: '#8aa6ff', fixed: true },
  { id: 'AI·데이터', kind: 'field', title: 'AI·데이터', sub: '공모전·서포터즈·챌린지', h: 160, c1: '#0fa3b1', c2: '#5fd3db' },
  { id: 'alba', kind: 'mod', title: '알바', sub: '근무 시간은 피해서 계획', h: 150, c1: '#ff8a3d', c2: '#ffbb85' },
  { id: 'exercise', kind: 'mod', title: '운동', sub: '주 3회 목표만 정하면 빈 시간에', h: 230, c1: '#16a34a', c2: '#6fd496' },
  { id: '창업', kind: 'field', title: '창업', sub: '아이디어 공모전·부트캠프', h: 170, c1: '#e5484d', c2: '#ff9a9d' },
  { id: 'health', kind: 'mod', title: '컨디션 관리', sub: '수면·스트레스 따라 공부량 조절', h: 190, c1: '#c25cf2', c2: '#e1a6ff' },
  { id: '개발', kind: 'field', title: '개발', sub: '해커톤·오픈소스·코딩 봉사', h: 140, c1: '#1f2937', c2: '#5b6474' },
  { id: 'commute', kind: 'mod', title: '통학', sub: '지하철·버스 시간에 가벼운 공부', h: 180, c1: '#3b82f6', c2: '#93c5fd' },
  { id: 'activities', kind: 'mod', title: '대외활동', sub: '내 시간표에 맞는 공고 추천', h: 220, c1: '#8b5cf6', c2: '#c4b5fd' },
  { id: '마케팅', kind: 'field', title: '마케팅', sub: '기자단·서포터즈', h: 150, c1: '#f59e0b', c2: '#fcd34d' },
  { id: 'lang', kind: 'mod', title: '어학', sub: '매일 단어 30분, 통학 중에도', h: 170, c1: '#0ea5e9', c2: '#7dd3fc' },
  { id: '디자인', kind: 'field', title: '디자인', sub: 'UX·브랜딩 챌린지', h: 200, c1: '#ec4899', c2: '#f9a8d4' },
  { id: 'career', kind: 'mod', title: '취업·인턴', sub: '체험형 인턴·채용 연계 공고', h: 160, c1: '#334155', c2: '#94a3b8' },
  { id: '기획', kind: 'field', title: '기획', sub: '서비스 기획 공모전', h: 140, c1: '#14b8a6', c2: '#5eead4' },
  { id: '금융', kind: 'field', title: '금융', sub: '핀테크 해커톤', h: 180, c1: '#0f766e', c2: '#2dd4bf' },
  { id: '환경·ESG', kind: 'field', title: '환경·ESG', sub: 'ESG 아이디어 공모전', h: 150, c1: '#65a30d', c2: '#bef264' },
  { id: '봉사', kind: 'field', title: '봉사', sub: '교육·지역 봉사', h: 170, c1: '#d97706', c2: '#fdba74' },
  { id: '글로벌', kind: 'field', title: '글로벌', sub: '교류·해외 연수', h: 140, c1: '#2563eb', c2: '#a5b4fc' },
];

export const MIN_PICKS = 3;

/** 고른 카드로 상태를 바꾼다. returns { state, lines: [바뀐 점] } */
export function applyPicks(base, picks) {
  const s = clone(base);
  const has = id => picks.includes(id);
  const lines = [];
  const fields = picks.filter(p => TILES.find(t => t.id === p && t.kind === 'field'));
  if (has('career')) fields.push('취업');
  const modules = ['study', ...picks.filter(p => TILES.find(t => t.id === p && t.kind === 'mod') && p !== 'study')];
  if (fields.length && !modules.includes('activities')) modules.push('activities');
  s.modules = modules;

  if (!has('alba')) s.events = s.events.filter(e => e.kind !== '알바');
  else lines.push('알바 시간은 계획에서 피해요');

  s.habits = (s.habits || []).filter(h => (h.kind === '운동' ? has('exercise') : h.kind === '어학' ? has('lang') : true));
  if (has('exercise')) {
    if (!s.habits.some(h => h.kind === '운동')) applyOp(s, { type: 'set_habit', title: '헬스', per_week: 3, minutes: 60, window_start: '17:00', window_end: '22:00' });
    lines.push('운동: 주 3회 60분을 저녁 빈 시간에 배치');
  }
  if (has('lang')) {
    applyOp(s, { type: 'set_habit', title: '영어 단어', kind: '어학', per_week: 5, minutes: 30, window_start: '07:00', window_end: '23:00' });
    lines.push('어학: 영어 단어 주 5회 30분');
  }
  if (has('commute')) { if (!s.prefs.commuteMin) s.prefs.commuteMin = 50; lines.push(`통학: ${s.prefs.commuteMode} 편도 ${s.prefs.commuteMin}분, 이동 중 학습 켬`); }
  else s.prefs.commuteMin = 0;
  if (has('health')) lines.push('컨디션: 수면·스트레스로 오늘 공부량 조절');
  else s.condition = null;

  s.interests = [...new Set(fields)];
  if (modules.includes('activities')) lines.push(`대외활동 추천: ${s.interests.length ? s.interests.join(', ') : '전체 분야'}`);
  return { state: s, lines };
}
