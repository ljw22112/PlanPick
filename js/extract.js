// 붙여넣은 글·강의계획서·근무표에서 일정을 뽑는다(규칙 기반, API 키가 있으면 LLM 사용)
import { parseKorean } from './nlu.js';
import { localISO } from './state.js';
import { dateOfDay } from './scheduler.js';

const DAY = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };

// "11/20", "11월 20일" → Date (올해, 지났으면 내년)
function parseDate(text, now) {
  const m = text.match(/(\d{1,2})\s*[/.월]\s*(\d{1,2})\s*일?/);
  if (!m) return null;
  const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]), 23, 59);
  if (d < new Date(now.getTime() - 60 * 86400000)) d.setFullYear(d.getFullYear() + 1);
  return d;
}

/**
 * 카톡·문자·LMS 공지 붙여넣기 → 상태 변경 연산
 * - "목요일 7시 회의" → add_event
 * - "금요일까지 제출", "11/20 마감" → add_task
 * - "과제 마감이 11/22로 연기" → update_task due
 */
export function extractOps(text, state, { today, now, weekStart }) {
  const ops = [];
  const notes = [];
  const lines = text.split(/\n+/).map(l => l.replace(/^\[[^\]]*\]\s*/, '').replace(/^[^:]{1,12}:\s*/, '').trim()).filter(Boolean);
  for (const line of lines) {
    // 1) 공지: 마감 연기·변경
    if (/연기|변경|미뤄|늦춰/.test(line) && /마감|제출|과제|시험|퀴즈/.test(line)) {
      const d = parseDate(line, now);
      const t = state.tasks.find(x => !x.done && (line.includes(x.course) || x.title.split(/\s+/).some(w => w.length >= 2 && line.includes(w))));
      if (d && t) { ops.push({ type: 'update_task', task_id: t.id, due: localISO(d) }); notes.push(`공지: '${t.title}' 마감 변경`); continue; }
    }
    // 2) 마감 있는 할 일
    if (/까지|마감|제출|due/i.test(line)) {
      let d = parseDate(line, now);
      const dm = line.match(/([월화수목금토일])요일/);
      if (!d && dm) { d = dateOfDay(weekStart, DAY[dm[1]]); d.setHours(23, 59, 0, 0); if (DAY[dm[1]] < today) d.setDate(d.getDate() + 7); }
      if (!d && /오늘/.test(line)) { d = new Date(now); d.setHours(23, 59, 0, 0); }
      if (!d && /내일/.test(line)) { d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(23, 59, 0, 0); }
      if (d) {
        const title = line
          .replace(/(\d{1,2}\s*[/.월]\s*\d{1,2}\s*일?|[월화수목금토일]요일|오늘|내일)\s*(까지|마감)?/g, '')
          .replace(/^(그럼|그러면|일단|우리|다들|저희)\s*/, '')
          .replace(/\s*(각자|모두|다)\s*/g, ' ')
          .replace(/\s*((끝내|하|내|마치)는 ?걸로|하자|합시다|해주세요|해요|부탁해요?)\s*[.!~]*$/, '')
          .replace(/([가-힣]+)(은|는)\s*$/, '$1')
          .replace(/[.!~]+$/, '').trim().slice(0, 40) || '할 일';
        const hrs = (line.match(/(\d+(?:\.\d+)?)\s*시간/) || [])[1];
        ops.push({ type: 'add_task', title, course: '', due: localISO(d), hours: hrs ? Number(hrs) : 2 });
        notes.push(`할 일: ${title}`);
        continue;
      }
    }
    // 3) 시각 있는 약속 → 기존 대화 파서 재사용
    const r = parseKorean(line, state, today);
    const ev = (r.ops || []).filter(o => o.type === 'add_event');
    if (ev.length) {
      for (const o of ev) {
        if (o.title === '개인 일정' || o.title === '회의' || o.title === '모임') o.title = /회의|미팅/.test(line) ? '팀플 회의' : o.title === '개인 일정' ? line.slice(0, 20) : o.title;
        ops.push(o);
      }
      notes.push(`일정: ${line.slice(0, 30)}`);
    }
  }
  return { ops, notes };
}

// 학기 시작일(월요일): 8월 이후면 9월 첫 월요일, 아니면 3월 첫 월요일
export function semesterStart(now) {
  const y = now.getFullYear();
  const d = now.getMonth() >= 7 ? new Date(y, 8, 1) : new Date(y, 2, 1);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * 강의계획서 텍스트 → 시험·과제 연산
 * "8주차 중간고사", "15주차 기말고사", "과제2 10/24", "퀴즈 6주차"
 */
export function extractSyllabus(text, course, now) {
  const start = semesterStart(now);
  const ops = [];
  const seen = new Set();
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    const kind = (line.match(/중간고사|기말고사|중간시험|기말시험|과제\s*\d*|퀴즈\s*\d*|프로젝트|발표|보고서/) || [])[0];
    if (!kind) continue;
    let d = parseDate(line, now);
    const wk = line.match(/(\d{1,2})\s*주차/);
    if (!d && wk) { d = new Date(start); d.setDate(d.getDate() + (Number(wk[1]) - 1) * 7 + 2); d.setHours(10, 0, 0, 0); }
    if (!d || d < now) continue;
    const key = `${kind}|${d.toDateString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (/고사|시험/.test(kind)) ops.push({ type: 'add_exam', course, date: localISO(d), hours: /기말/.test(kind) ? 10 : 8 });
    else ops.push({ type: 'add_task', title: `${course} ${kind.replace(/\s+/g, '')}`, course, due: localISO(d), hours: /프로젝트/.test(kind) ? 10 : /퀴즈/.test(kind) ? 2 : 4 });
  }
  return ops;
}

// pdf.js로 PDF 텍스트 추출 (CDN에서 필요할 때만 불러옴)
export async function pdfText(file) {
  if (!window.pdfjsLib) {
    await new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = ok;
      s.onerror = () => fail(new Error('pdf.js를 불러오지 못했어요'));
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(pdf.numPages, 15); i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    // 같은 줄(y 좌표)끼리 묶어 줄바꿈 복원
    const rows = {};
    for (const it of c.items) { const y = Math.round(it.transform[5]); rows[y] = (rows[y] || '') + it.str + ' '; }
    pages.push(Object.keys(rows).sort((a, b) => b - a).map(y => rows[y].trim()).join('\n'));
  }
  return pages.join('\n');
}

// 시연용 예시 강의계획서·단톡방 메시지
export const SAMPLE_SYLLABUS = `운영체제 강의계획서
1주차 오리엔테이션
6주차 퀴즈1 (프로세스·스레드)
8주차 중간고사
10주차 과제2 제출 (스케줄링 시뮬레이터 구현)
13주차 팀 프로젝트 발표
15주차 기말고사`;

export const SAMPLE_CHAT = (dayName) => `[DB 팀플방]
민수: 우리 ${dayName}요일 7시에 회의하자
지은: 그럼 자료조사는 ${dayName}요일까지 각자 끝내는 걸로
[학과 공지] 데이터베이스 과제 마감이 다음주로 연기되었습니다. 11/24까지 제출`;
