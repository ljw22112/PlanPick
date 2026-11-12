// Claude API 함수호출(tool use)로 대화형 수정.
// LLM은 시간을 직접 배치하지 않고, 아래 도구로 '제약'만 바꾼다. 실제 배치는 scheduler.js가 한다.
import { applyOp, summarizeForLLM } from './state.js';

const API = 'https://api.anthropic.com/v1/messages';

const timeProp = { type: 'string', description: 'HH:MM (24시간제, 24:00 허용)' };
const dayProp = { type: 'integer', minimum: 0, maximum: 6, description: '0=월 1=화 2=수 3=목 4=금 5=토 6=일 (이번 주)' };

export const TOOLS = [
  {
    name: 'add_event',
    description: '이번 주에 고정 일정(알바, 대외활동, 운동 수업, 약속 등)을 추가한다. 공부 블록은 이 시간을 피해 다시 배치된다.',
    input_schema: { type: 'object', properties: { day: dayProp, start: timeProp, end: timeProp, title: { type: 'string' }, kind: { type: 'string', enum: ['알바', '대외활동', '운동', '기타'] } }, required: ['day', 'start', 'end', 'title'] },
  },
  {
    name: 'block_time',
    description: '공부를 넣지 않을 시간(휴식, 비워두기)을 지정한다. 하루 전체는 00:00–24:00.',
    input_schema: { type: 'object', properties: { day: dayProp, start: timeProp, end: timeProp, reason: { type: 'string' } }, required: ['day', 'start', 'end'] },
  },
  {
    name: 'remove_item',
    description: 'id로 일정·비워둔 시간·과제·수업을 삭제한다.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'set_task_goal',
    description: '과제를 실제 마감보다 앞당겨 특정 요일까지 끝내도록 목표일을 정한다. finish_by_day를 null로 주면 해제.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' }, finish_by_day: { type: ['integer', 'null'], minimum: 0, maximum: 6 } }, required: ['task_id', 'finish_by_day'] },
  },
  {
    name: 'update_task',
    description: '과제의 예상 소요시간(hours), 마감(due, YYYY-MM-DDTHH:MM), 완료 여부를 바꾼다.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' }, hours: { type: 'number' }, due: { type: 'string' }, done: { type: 'boolean' } }, required: ['task_id'] },
  },
  {
    name: 'add_task',
    description: '새 과제·시험공부를 추가한다. hours는 예상 소요시간.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, course: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DDTHH:MM' }, hours: { type: 'number' } }, required: ['title', 'due', 'hours'] },
  },
  {
    name: 'set_preferences',
    description: '공부 선호를 바꾼다: 하루 최대 공부시간, 공부 가능 시작/끝 시각, 한 블록 길이(분).',
    input_schema: { type: 'object', properties: { daily_max_hours: { type: 'number' }, study_start: timeProp, study_end: timeProp, block_minutes: { type: 'integer' } } },
  },
  {
    name: 'set_condition',
    description: '[헬스케어 융합] 오늘의 수면 시간과 스트레스(1~5)를 기록한다. 피로하면 스케줄러가 오늘 공부량을 줄이고 블록을 짧게, 컨디션이 좋으면 조금 늘린다. "피곤해"는 stress 4, "밤샜어"는 sleep_hours 2 정도로 해석.',
    input_schema: { type: 'object', properties: { sleep_hours: { type: 'number' }, stress: { type: 'integer', minimum: 1, maximum: 5 } } },
  },
  {
    name: 'set_commute',
    description: '[모빌리티 융합] 편도 통학 시간(분)과 수단(지하철·버스·자차·도보)을 바꾼다. 대중교통이면 통학 시간에 퀴즈·암기·복습처럼 가벼운 과제를 "이동 중 학습"으로 배치하고, 자차면 넣지 않는다.',
    input_schema: { type: 'object', properties: { minutes: { type: 'integer', minimum: 0 }, mode: { type: 'string', enum: ['지하철', '버스', '자차', '도보'] } } },
  },
  {
    name: 'set_habit',
    description: '운동·어학처럼 시각 대신 "주 N회 × M분"만 정하는 반복 목표를 만들거나 고친다. 같은 title이 있으면 수정, per_week 0이면 삭제. window는 배치 가능한 시간대.',
    input_schema: { type: 'object', properties: { title: { type: 'string' }, per_week: { type: 'integer', minimum: 0, maximum: 7 }, minutes: { type: 'integer' }, window_start: timeProp, window_end: timeProp, kind: { type: 'string', enum: ['운동', '어학'] } }, required: ['title'] },
  },
  {
    name: 'set_interests',
    description: '대외활동 추천에 쓰는 희망 분야를 정한다. 분야: AI·데이터, 개발, 창업, 마케팅, 디자인, 기획, 금융, 환경·ESG, 봉사, 글로벌, 취업. mode add면 기존에 추가.',
    input_schema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['set', 'add'] } }, required: ['fields'] },
  },
];

function systemPrompt(state, weekStart, now) {
  return `너는 한국 대학생의 주간 생활계획표를 관리하는 비서 '플랜픽'이다.
사용자의 한국어 요청을 도구 호출로 바꿔 상태를 수정한다. 공부 블록 자체는 직접 만들지 않는다: 도구로 제약을 바꾸면 앱의 스케줄러가 다시 배치한다.
규칙:
- 요일은 0=월 … 6=일. '오늘'은 today_day, '내일'은 today_day+1.
- 시간 표현: '2시'처럼 오전/오후가 없고 1~7시면 오후로 본다. '저녁'은 18–22시, '밤'은 21–24시, '오전'은 9–12시, '오후'는 13–18시.
- 과제는 이름·과목으로 tasks에서 찾아 id를 쓴다. 애매하면 도구를 부르지 말고 짧게 되묻는다.
- 필요한 만큼 여러 도구를 한 번에 호출해도 된다.
- 피곤·수면 부족·스트레스 이야기는 set_condition, 통학 시간·수단 이야기는 set_commute로 반영한다.
- 도구를 다 부른 뒤 무엇을 바꿨는지 한두 문장 반말이 아닌 친근한 존댓말로 요약한다. 일정과 무관한 질문엔 짧게 답한다.
현재 상태(JSON):
${summarizeForLLM(state, weekStart, now)}`;
}

/**
 * draft: 수정할 상태 복사본(직접 변경됨)
 * returns { text, applied: [설명], errors: [string] }
 */
export async function runLLM({ apiKey, model, history, userText, draft, weekStart, now }) {
  const messages = [...history.slice(-8), { role: 'user', content: userText }];
  const applied = [];
  const errors = [];
  for (let turn = 0; turn < 5; turn++) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 1024, system: systemPrompt(draft, weekStart, now), tools: TOOLS, messages }),
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = body;
      try { msg = JSON.parse(body).error.message; } catch { /* keep raw */ }
      throw new Error(`API 오류 ${res.status}: ${msg}`);
    }
    const data = await res.json();
    messages.push({ role: 'assistant', content: data.content });
    const uses = data.content.filter(b => b.type === 'tool_use');
    if (data.stop_reason !== 'tool_use' || !uses.length) {
      const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      return { text, applied, errors };
    }
    const results = uses.map(u => {
      try {
        const desc = applyOp(draft, { type: u.name, ...u.input });
        applied.push(desc);
        return { type: 'tool_result', tool_use_id: u.id, content: `완료: ${desc}` };
      } catch (e) {
        errors.push(e.message);
        return { type: 'tool_result', tool_use_id: u.id, content: `실패: ${e.message}`, is_error: true };
      }
    });
    messages.push({ role: 'user', content: results });
  }
  return { text: applied.length ? '요청을 반영했어요.' : '', applied, errors };
}

// 시간표 이미지 → 수업 목록 (비전)
export async function readTimetableImage({ apiKey, model, file }) {
  const b64 = await new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = fail;
    r.readAsDataURL(file);
  });
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: file.type || 'image/png', data: b64 } },
          { type: 'text', text: '이 대학 시간표 이미지에서 수업을 모두 읽어 JSON 배열만 출력해. 형식: [{"title":"과목명","day":0,"start":"HH:MM","end":"HH:MM"}] day는 0=월…6=일. 같은 과목이 여러 요일이면 각각 따로. 다른 말은 쓰지 마.' },
        ],
      }],
    }),
  });
  if (!res.ok) throw new Error(`API 오류 ${res.status}`);
  const data = await res.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
  return JSON.parse(json);
}
