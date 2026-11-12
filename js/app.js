import { schedule, diffPlans, DAY_NAMES, weekStartOf, dateOfDay, toMin, isMobileTask, localDateKey } from './scheduler.js';
import { demoState, emptyState, applyOp, clone, colorFor, localISO, newId, defaultPrefs, EVENT_KINDS, INTEREST_FIELDS } from './state.js';
import { TILES, MIN_PICKS, applyPicks } from './onboarding.js';
import { recommend, sampleFeed, incomingPost } from './opportunities.js';
import { parseKorean } from './nlu.js';
import { runLLM, readTimetableImage } from './llm.js';
import { parseICS, SAMPLE_ICS } from './ics.js';

const START_H = 7;
const END_H = 24;
const STORE = 'planpick:v3';
const DEFAULT_MODEL = 'claude-haiku-5-5';

const $ = s => document.querySelector(s);
const now = new Date();
const weekStart = weekStartOf(now);
const today = (now.getDay() + 6) % 7;

// ---------- 저장 ----------
function load() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.weekStart === weekStart.toISOString()) return s;
      // 주가 바뀌면 데모 데이터를 이번 주 기준으로 새로 만든다
      return { ...s, state: s.demo ? demoState(now) : s.state, weekStart: weekStart.toISOString() };
    }
  } catch { /* 저장소 사용 불가 */ }
  return { state: demoState(now), demo: true, apiKey: '', model: DEFAULT_MODEL, weekStart: weekStart.toISOString() };
}
const app = load();
let state = app.state;
state.prefs = { ...defaultPrefs(), ...state.prefs };
state.habits = state.habits || [];
state.interests = state.interests || [];
state.modules = state.modules || ['study', 'activities'];
app.extraFeed = app.extraFeed || [];
const hasMod = m => (state.modules || []).includes(m);
const feed = () => [...app.extraFeed, ...sampleFeed(now)];
let plan = [];
let commutes = [];
let todayInfo = null;
let warnings = [];
let preview = null; // { draft, plan, commutes, today, warnings, diff }
const undoStack = [];
const history = []; // LLM 대화 기록 (텍스트만)

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ ...app, state })); } catch { /* 무시 */ }
}

// ---------- 유틸 ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), 2200);
}
const fmtDue = iso => {
  const d = new Date(iso);
  const dd = Math.floor((weekStartOf(d) - weekStart) / 86400000 / 7);
  const wk = dd === 0 ? '' : dd === 1 ? '다음 주 ' : `${d.getMonth() + 1}/${d.getDate()} `;
  return `${wk}${DAY_NAMES[(d.getDay() + 6) % 7]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const taskOf = (s, id) => s.tasks.find(t => t.id === id);
const habitOf = (s, id) => (s.habits || []).find(h => h.id === id);

// ---------- 계산 ----------
function recompute() {
  const r = schedule(state, { weekStart, now });
  plan = r.plan;
  commutes = r.commutes;
  todayInfo = r.today;
  warnings = r.warnings;
  render();
  save();
}

function commit(newState, label) {
  undoStack.push(clone(state));
  if (undoStack.length > 30) undoStack.shift();
  state = newState;
  app.demo = false;
  recompute();
  if (label) toast(label);
}

function undo() {
  if (!undoStack.length) { addBot('되돌릴 변경이 없어요.'); return; }
  state = undoStack.pop();
  preview = null;
  recompute();
  addBot('마지막 변경을 되돌렸어요.');
}

// ---------- 렌더 ----------
function render() {
  renderWeek();
  renderCalendar();
  renderLists();
  renderStats();
  renderMode();
  renderCondition();
  renderModules();
  renderRecs();
}

// 관심사(모듈)에 따라 화면 구성 바꾸기
function renderModules() {
  $('#condBar').classList.toggle('hidden-mod', !hasMod('health'));
  $('#recsTab').classList.toggle('hidden-mod', !hasMod('activities'));
  if (!hasMod('activities') && $('#tab-recs').classList.contains('active')) document.querySelector('.tab[data-tab=tasks]').click();
}

function renderRecs() {
  if (!hasMod('activities')) { $('#recBadge').textContent = ''; return; }
  $('#interestChips').innerHTML = INTEREST_FIELDS.map(f => `<button type="button" data-field="${esc(f)}" class="${state.interests.includes(f) ? 'on' : ''}">${esc(f)}</button>`).join('');
  const recs = recommend(state, feed(), { weekStart, now });
  const fresh = recs.filter(r => r.opp.posted === 0);
  $('#recBadge').textContent = fresh.length ? String(fresh.length) : '';
  const saved = new Set(state.saved || []);
  $('#recList').innerHTML = recs.length ? recs.slice(0, 8).map(r => {
    const o = r.opp;
    const fitTag = r.fit === 'ok' ? '<span class="tag ok">시간표 OK</span>' : r.fit === 'clash' ? `<span class="tag clash">겹침: ${esc(r.clashWith)}</span>` : '<span class="tag tight">시간 빠듯</span>';
    const sched = o.schedule.type === 'fixed' ? `매주 ${DAY_NAMES[o.schedule.day]} ${o.schedule.start}–${o.schedule.end}` : `주 ${o.schedule.hoursPerWeek}시간(자유)`;
    const added = saved.has(o.id);
    return `<div class="rec ${o.posted === 0 ? 'new' : ''}">
      <div class="r1"><div><div class="rt">${esc(o.title)}${o.posted === 0 ? '<span class="newpill">NEW</span>' : ''}</div><div class="ro">${esc(o.org)} · ${esc(o.category)} · ${esc(sched)} · ${esc(o.benefit)}</div></div><div class="score">${r.score}</div></div>
      <div class="bar"><i style="width:${r.score}%"></i></div>
      <div class="tags"><span class="tag dday">D-${Math.max(0, r.daysLeft)}</span>${fitTag}${r.match.map(m => `<span class="tag">${esc(m)}</span>`).join('')}</div>
      <ul>${r.reasons.slice(0, 3).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      <div class="acts"><button class="small" data-rec="prep" data-id="${o.id}" ${added ? 'disabled' : ''}>${added ? '준비 일정 추가됨' : `지원 준비 ${o.prepHours}h 계획에 넣기`}</button>${o.schedule.type === 'fixed' ? `<button class="small ghost" data-rec="fixed" data-id="${o.id}">활동 시간도 넣기</button>` : ''}</div>
    </div>`;
  }).join('') : '<div class="hint">희망 분야를 고르면 맞는 공고를 보여드려요.</div>';
}

function renderCondition() {
  const s = preview ? preview.draft : state;
  const info = preview ? preview.today : todayInfo;
  const c = s.condition && s.condition.date === localDateKey(now) ? s.condition : null;
  const sl = $('#condSleep');
  const st = $('#condStress');
  if (document.activeElement !== sl) sl.value = c && c.sleep != null ? c.sleep : 7;
  if (document.activeElement !== st) st.value = c && c.stress != null ? c.stress : 2;
  $('#condSleepVal').textContent = `${c && c.sleep != null ? c.sleep : sl.value}h`;
  const src = c ? (c.source === 'wearable' ? '웨어러블(모의)' : c.source === 'chat' ? '대화' : '직접 입력') : '';
  const cap = info && info.capMin != null ? `오늘 최대 ${(info.capMin / 60).toFixed(1).replace(/\.0$/, '')}시간` : '';
  const blk = info && info.effect.blockCap ? ` · 블록 ${info.effect.blockCap}분 · 휴식 ${info.effect.breakMin}분` : '';
  $('#condEffect').innerHTML = `<b>${esc(info ? info.effect.label : '')}</b> ${cap}${blk}${src ? ` <span class="src">${src}</span>` : ''}`;
  $('#condBar').classList.toggle('tired', !!(info && info.effect.factor < 0.8));
  $('#condBar').classList.toggle('good', !!(info && info.effect.factor > 1));
}

function renderWeek() {
  const end = dateOfDay(weekStart, 6);
  $('#weekLabel').textContent = `${weekStart.getMonth() + 1}월 ${weekStart.getDate()}일 – ${end.getMonth() + 1}월 ${end.getDate()}일`;
}

function renderMode() {
  const b = $('#modeBadge');
  if (app.apiKey) { b.textContent = 'AI 모드 · Claude'; b.className = 'mode ai'; }
  else { b.textContent = '기본 모드 · 규칙 파서'; b.className = 'mode'; }
  $('#ttLabel').classList.toggle('disabled', !app.apiKey);
}

function renderStats() {
  const s = preview ? preview.draft : state;
  const p = preview ? preview.plan : plan;
  const study = p.filter(b => !b.habit);
  const mins = study.reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0);
  const habitN = p.filter(b => b.habit).length;
  const mob = p.filter(b => b.mobile).reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0);
  const open = s.tasks.filter(t => !t.done).length;
  const h = m => (m / 60).toFixed(1).replace(/\.0$/, '');
  $('#stats').innerHTML = `<span>이번 주 공부 <b>${h(mins)}시간</b></span><span>이동 중 학습 <b>${h(mob)}시간</b></span><span>남은 과제 <b>${open}개</b></span>${habitN ? `<span>운동·어학 <b>${habitN}회</b></span>` : ''}`;
  const w = preview ? preview.warnings : warnings;
  $('#warnings').innerHTML = w.map(x => `<div>${esc(x)}</div>`).join('');
}

function pos(start, end) {
  const top = (toMin(start) - START_H * 60) / 60;
  const h = (toMin(end) - toMin(start)) / 60;
  return `top:calc(var(--hour) * ${Math.max(0, top)});height:calc(var(--hour) * ${h} - 2px)`;
}

function renderCalendar() {
  const s = preview ? preview.draft : state;
  const p = preview ? preview.plan : plan;
  const cm = preview ? preview.commutes : commutes;
  const newKeys = preview ? new Set(p.filter(b => !plan.some(o => o.taskId === b.taskId && o.day === b.day && o.start === b.start && o.end === b.end)).map(b => b.id)) : new Set();
  const ghosts = preview ? plan.filter(o => !p.some(b => o.taskId === b.taskId && o.day === b.day && o.start === b.start && o.end === b.end)) : [];

  let html = '<div class="grid"><div class="corner"></div>';
  for (let d = 0; d < 7; d++) {
    const date = dateOfDay(weekStart, d);
    html += `<div class="dayhead ${d === today ? 'today' : ''}">${DAY_NAMES[d]}<small>${date.getMonth() + 1}/${date.getDate()}</small></div>`;
  }
  html += '<div class="hours">';
  for (let h = START_H; h < END_H; h++) html += `<div>${h}</div>`;
  html += '</div>';

  for (let d = 0; d < 7; d++) {
    html += `<div class="col ${d === today ? 'today' : ''}">`;
    for (let h = START_H; h < END_H; h++) html += '<div class="hline"></div>';
    const vis = x => toMin(x.end) > START_H * 60;
    for (const b of s.blocked.filter(x => x.day === d && vis(x))) {
      html += `<div class="ev blocked" style="${pos(b.start < '07:00' ? '07:00' : b.start, b.end)}" title="${esc(b.reason)}"><span class="tt">${esc(b.reason)}</span></div>`;
    }
    for (const c of cm.filter(x => x.day === d && vis(x))) {
      html += `<div class="ev commute" style="${pos(c.start < '07:00' ? '07:00' : c.start, c.end)}" title="${c.dir} · ${esc(s.prefs.commuteMode)} ${s.prefs.commuteMin}분"><span class="tm">${c.dir} · ${esc(s.prefs.commuteMode)}</span></div>`;
    }
    for (const c of s.classes.filter(x => x.day === d && vis(x))) {
      html += `<div class="ev class" style="${pos(c.start, c.end)};border-left:3px solid ${colorFor(s, c.title)}"><span class="tt">${esc(c.title)}</span><span class="tm">${c.start}–${c.end}</span></div>`;
    }
    for (const e of s.events.filter(x => x.day === d && vis(x))) {
      html += `<div class="ev event k-${esc(e.kind || '기타')}" style="${pos(e.start, e.end)}" title="${esc(e.kind || '기타')}"><span class="tt">${esc(e.title)}</span><span class="tm">${e.start}–${e.end}</span></div>`;
    }
    for (const b of ghosts.filter(x => x.day === d)) {
      const t = taskOf(state, b.taskId) || habitOf(state, b.taskId) || {};
      html += `<div class="ev study ghost" style="${pos(b.start, b.end)};background:${colorFor(s, t.course)}"><span class="tt">${esc(t.title || '')}</span></div>`;
    }
    for (const b of p.filter(x => x.day === d && x.habit)) {
      const h = habitOf(s, b.taskId) || {};
      html += `<div class="ev habit k-${esc(h.kind || '운동')} ${newKeys.has(b.id) ? 'new' : ''}" style="${pos(b.start, b.end)}" title="${esc(h.title)} · 주 ${h.perWeek}회 목표"><span class="tt">${esc(h.title)}</span><span class="tm">${b.start}–${b.end}</span></div>`;
    }
    for (const b of p.filter(x => x.day === d && !x.habit)) {
      const t = taskOf(s, b.taskId) || {};
      const mob = b.mobile ? ' mobile' : '';
      const style = b.mobile ? `border-color:${colorFor(s, t.course)};color:${colorFor(s, t.course)}` : `background:${colorFor(s, t.course)}`;
      html += `<div class="ev study${mob} ${newKeys.has(b.id) ? 'new' : ''}" data-task="${t.id}" style="${pos(b.start, b.end)};${style}" title="${b.mobile ? '이동 중 학습 · ' : ''}${esc(t.title)} · 마감 ${fmtDue(t.due)}"><span class="tt">${b.mobile ? '이동 중 · ' : ''}${esc(t.title)}</span><span class="tm">${b.start}–${b.end}</span></div>`;
    }
    if (d === today) {
      const m = now.getHours() * 60 + now.getMinutes();
      if (m >= START_H * 60) html += `<div class="nowline" style="top:calc(var(--hour) * ${(m - START_H * 60) / 60})"></div>`;
    }
    html += '</div>';
  }
  html += '</div>';
  const cal = $('#calendar');
  const keep = cal.scrollTop;
  cal.innerHTML = html;
  cal.scrollTop = keep || (2 * 44);
}

function itemRow({ color, title, meta, acts, cls = '' }) {
  return `<li class="${cls}"><span class="dot" style="background:${color}"></span><div class="body"><div class="t">${esc(title)}</div><div class="m">${meta}</div></div><div class="acts">${acts}</div></li>`;
}

function renderLists() {
  const s = state;
  const tasks = [...s.tasks].sort((a, b) => (a.done - b.done) || a.due.localeCompare(b.due));
  $('#taskList').innerHTML = tasks.length ? tasks.map(t => {
    const placed = plan.filter(b => b.taskId === t.id).reduce((a, b) => a + toMin(b.end) - toMin(b.start), 0) / 60;
    const goal = t.goalDay != null ? ` · <span class="goal">${DAY_NAMES[t.goalDay]}요일까지</span>` : '';
    const mobTag = isMobileTask(t) ? ' · <span class="mobtag">이동 중 가능</span>' : '';
    const meta = `${esc(t.course || '기타')} · 마감 ${fmtDue(t.due)}${goal}<br>예상 ${t.hours}h · 이번 주 배치 ${placed.toFixed(1).replace(/\.0$/, '')}h${mobTag}`;
    return itemRow({ color: colorFor(s, t.course), title: t.title, meta, cls: t.done ? 'done' : '', acts: `<button data-act="done" data-id="${t.id}" title="완료">✓</button><button data-act="del" data-id="${t.id}" title="삭제">✕</button>` });
  }).join('') : '<li class="empty">과제가 없어요</li>';

  $('#classList').innerHTML = s.classes.length ? [...s.classes].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start)).map(c =>
    itemRow({ color: colorFor(s, c.title), title: c.title, meta: `${DAY_NAMES[c.day]} ${c.start}–${c.end}`, acts: `<button data-act="del" data-id="${c.id}" title="삭제">✕</button>` })).join('') : '<li class="empty">수업이 없어요</li>';

  const evs = [...s.events.map(e => ({ ...e, kind: e.kind || '기타' })), ...s.blocked.map(b => ({ ...b, title: `비워둠 · ${b.reason}`, kind: '비워둠' }))]
    .sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  $('#eventList').innerHTML = evs.length ? evs.map(e => {
    const k = EVENT_KINDS[e.kind];
    const tag = k ? `<span class="kindtag" style="background:${k.bg};color:${k.ink}">${esc(e.kind)}</span>` : '';
    return itemRow({ color: k ? k.color : '#c3c8d6', title: e.title, meta: `${tag}${DAY_NAMES[e.day]} ${e.start}–${e.end}`, acts: `<button data-act="del" data-id="${e.id}" title="삭제">✕</button>` });
  }).join('') : '<li class="empty">고정 일정이 없어요</li>';

  $('#habitList').innerHTML = (s.habits || []).length ? s.habits.map(h => {
    const placed = plan.filter(b => b.taskId === h.id).length;
    const color = h.kind === '어학' ? '#0ea5e9' : '#16a34a';
    return itemRow({ color, title: `${h.title} · 주 ${h.perWeek}회 × ${h.minutes}분`, meta: `${h.windowStart}–${h.windowEnd} 사이 · 이번 주 ${placed}회 배치`, acts: `<button data-act="del" data-id="${h.id}" title="삭제">✕</button>` });
  }).join('') : '<li class="empty">반복 목표가 없어요</li>';
}

// ---------- 대화 ----------
function addMsg(html, cls) {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.innerHTML = html;
  $('#messages').appendChild(el);
  $('#messages').scrollTop = 1e9;
  return el;
}
const addUser = t => addMsg(esc(t), 'user');
const addBot = (t, ops = [], err = false) => addMsg(esc(t) + (ops.length ? `<ul class="ops">${ops.map(o => `<li>${esc(o)}</li>`).join('')}</ul>` : ''), `bot${err ? ' err' : ''}`);

function showPreview(draft, summary, applied) {
  const r = schedule(draft, { weekStart, now });
  const diff = diffPlans(plan, r.plan, draft.tasks, draft.habits);
  preview = { draft, plan: r.plan, commutes: r.commutes, today: r.today, warnings: r.warnings, diff };
  render();
  const el = document.createElement('div');
  el.className = 'preview';
  const changeLine = diff.added + diff.removed ? `공부 블록 ${diff.removed}개 빠지고 ${diff.added}개 새로 배치` : '공부 블록 위치는 그대로예요';
  el.innerHTML = `<h4>변경안 미리보기</h4>${summary ? `<div>${esc(summary)}</div>` : ''}${applied.length ? `<ul class="ops">${applied.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}<pre>${esc(changeLine)}${diff.lines.length ? '\n' + diff.lines.map(esc).join('\n') : ''}</pre><div class="acts"><button class="small" data-pv="apply">적용</button><button class="small ghost" data-pv="cancel">취소</button></div>`;
  $('#messages').appendChild(el);
  $('#messages').scrollTop = 1e9;
  el.addEventListener('click', e => {
    const a = e.target.dataset.pv;
    if (!a) return;
    el.querySelectorAll('button').forEach(b => { b.disabled = true; });
    if (a === 'apply') {
      const d = preview.draft;
      preview = null;
      commit(d, '계획에 반영했어요');
      el.querySelector('h4').textContent = '적용됨';
    } else {
      preview = null;
      render();
      el.querySelector('h4').textContent = '취소됨';
    }
  });
}

const tmr = DAY_NAMES[Math.min(6, today + 1)];
const later = DAY_NAMES[Math.min(6, today + 2)];
// 관심사(모듈)에 맞춘 예시 문장
function examples() {
  const ex = [`${tmr}요일 저녁은 비워줘`, `자료구조 과제 ${tmr}요일까지 끝낼래`, '하루 최대 3시간만 공부할래'];
  if (hasMod('alba')) ex.push(`${later}요일 7시부터 10시까지 편의점 알바`);
  if (hasMod('exercise')) ex.push('헬스 주 4회 1시간으로 바꿔줘');
  if (hasMod('lang')) ex.push('영어 단어 매일 30분');
  if (hasMod('health')) ex.push('어제 4시간밖에 못 잤어');
  if (hasMod('commute')) ex.push('통학 버스로 1시간 걸려');
  if (hasMod('activities')) ex.push('대외활동 추천해줘', '관심 분야에 마케팅 추가');
  ex.push('되돌려줘');
  return ex;
}
const helpText = () => `이렇게 말해보세요:\n${examples().map(e => `· "${e}"`).join('\n')}`;

function renderChips() {
  const pick = examples().filter(e => !/하루 최대|되돌려/.test(e)).slice(-4);
  $('#chips').innerHTML = [...pick, '되돌려줘'].map(c => `<button type="button">${esc(c)}</button>`).join('');
}

function showRecsInChat() {
  if (!hasMod('activities')) { addBot("대외활동 추천이 꺼져 있어요. 상단 '관심사'에서 대외활동이나 희망 분야를 골라주세요."); return; }
  const recs = recommend(state, feed(), { weekStart, now }).filter(r => r.fit !== 'clash').slice(0, 3);
  if (!recs.length) { addBot('지금 시간표와 희망 분야에 맞는 공고가 없어요.'); return; }
  addBot(`희망 분야(${state.interests.join(', ') || '전체'})와 이번 주 시간표에 맞는 공고예요. '추천' 탭에서 준비 일정을 바로 넣을 수 있어요.`, recs.map(r => `${r.opp.title} · ${r.score}점 · D-${r.daysLeft} · ${r.reasons[1] || ''}`));
  document.querySelector('.tab[data-tab=recs]').click();
}

async function handle(text) {
  if (preview) { preview = null; render(); }
  addUser(text);
  if (app.apiKey) {
    const typing = addMsg('생각 중…', 'typing');
    const draft = clone(state);
    try {
      const r = await runLLM({ apiKey: app.apiKey, model: app.model || DEFAULT_MODEL, history, userText: text, draft, weekStart, now });
      typing.remove();
      history.push({ role: 'user', content: text }, { role: 'assistant', content: r.text || '(변경)' });
      if (r.errors.length && !r.applied.length) addBot(r.text || '요청을 처리하지 못했어요.', r.errors, true);
      if (r.applied.length) showPreview(draft, r.text, r.applied);
      else if (!r.errors.length) addBot(r.text || '바꿀 내용이 없었어요.');
    } catch (e) {
      typing.remove();
      addBot(`${e.message}\n규칙 파서로 다시 시도할게요.`, [], true);
      ruleBased(text);
    }
    return;
  }
  ruleBased(text);
}

function ruleBased(text) {
  const r = parseKorean(text, state, today);
  if (r.special === 'undo') { undo(); return; }
  if (r.special === 'recommend') { showRecsInChat(); return; }
  if (r.help) { addBot(`이해하지 못했어요. ${helpText()}`); return; }
  if (r.special === 'reschedule' && !r.ops.length) { recompute(); addBot('남은 과제로 계획을 다시 짰어요.'); return; }
  const draft = clone(state);
  const applied = [];
  const errors = [];
  for (const op of r.ops) {
    try { applied.push(applyOp(draft, op)); } catch (e) { errors.push(e.message); }
  }
  if (!applied.length) { addBot('요청을 반영하지 못했어요.', errors, true); return; }
  showPreview(draft, '', applied);
}

// ---------- 이벤트 ----------
function fillDaySelects() {
  for (const sel of document.querySelectorAll('select[name=day]')) {
    sel.innerHTML = DAY_NAMES.map((n, i) => `<option value="${i}">${n}요일</option>`).join('');
  }
}

function bind() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`));
  }));

  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('#input').value.trim();
    if (!v) return;
    $('#input').value = '';
    handle(v);
  });
  $('#input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#chips').addEventListener('click', e => { if (e.target.tagName === 'BUTTON') handle(e.target.textContent); });
  $('#btnUndo').addEventListener('click', undo);

  $('.side').addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const s = clone(state);
    if (b.dataset.act === 'del') commit(s, applyOp(s, { type: 'remove_item', id: b.dataset.id }));
    if (b.dataset.act === 'done') {
      const t = taskOf(s, b.dataset.id);
      commit(s, applyOp(s, { type: 'update_task', task_id: t.id, done: !t.done }));
    }
  });

  $('#calendar').addEventListener('click', e => {
    const el = e.target.closest('.ev.study[data-task]');
    if (!el || preview) return;
    const t = taskOf(state, el.dataset.task);
    if (t) { $('#input').value = `${t.title} `; $('#input').focus(); }
  });

  $('#taskForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const s = clone(state);
    commit(s, applyOp(s, { type: 'add_task', title: f.get('title'), course: f.get('course'), hours: Number(f.get('hours')), due: f.get('due') }));
    e.target.reset();
    e.target.elements.hours.value = 2;
  });
  $('#classForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const s = clone(state);
    try {
      if (f.get('end') <= f.get('start')) throw new Error('끝 시간이 더 늦어야 해요');
      s.classes.push({ id: newId('c'), title: f.get('title'), day: Number(f.get('day')), start: f.get('start'), end: f.get('end') });
      colorFor(s, f.get('title'));
      commit(s, '수업을 추가했어요');
      e.target.elements.title.value = '';
    } catch (err) { toast(err.message); }
  });
  $('#eventForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const s = clone(state);
    try {
      commit(s, applyOp(s, { type: 'add_event', title: f.get('title'), kind: f.get('kind') || undefined, day: Number(f.get('day')), start: f.get('start'), end: f.get('end') }));
      e.target.elements.title.value = '';
    } catch (err) { toast(err.message); }
  });

  $('#habitForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const s = clone(state);
    try {
      commit(s, applyOp(s, { type: 'set_habit', title: f.get('title'), per_week: Number(f.get('perWeek')), minutes: Number(f.get('minutes')), window_start: f.get('windowStart'), window_end: f.get('windowEnd') }));
      e.target.elements.title.value = '';
    } catch (err) { toast(err.message); }
  });

  // 대외활동 추천
  $('#interestChips').addEventListener('click', e => {
    const f = e.target.dataset.field;
    if (!f) return;
    const s = clone(state);
    const next = s.interests.includes(f) ? s.interests.filter(x => x !== f) : [...s.interests, f];
    s.interests = next;
    commit(s, `희망 분야: ${next.join(', ') || '없음'}`);
  });
  $('#recList').addEventListener('click', e => {
    const b = e.target.closest('button[data-rec]');
    if (!b) return;
    const o = feed().find(x => x.id === b.dataset.id);
    const s = clone(state);
    if (b.dataset.rec === 'prep') {
      applyOp(s, { type: 'add_task', title: `${o.title} 지원서 작성`, course: '대외활동', due: o.deadline, hours: o.prepHours });
      s.saved = [...new Set([...(s.saved || []), o.id])];
      commit(s, '지원 준비 일정을 넣었어요');
      addBot(`'${o.title}' 지원서 작성 ${o.prepHours}시간을 마감(${fmtDue(o.deadline)}) 전 빈 시간에 배치했어요.`);
    } else {
      try {
        const { day, start, end } = o.schedule;
        commit(s, applyOp(s, { type: 'add_event', title: o.title, kind: '대외활동', day, start, end }));
      } catch (err) { toast(err.message); }
    }
  });
  $('#btnNewPost').addEventListener('click', () => {
    const p = incomingPost(now);
    if (app.extraFeed.some(x => x.id === p.id)) { toast('이미 도착한 공고예요'); return; }
    app.extraFeed.unshift(p);
    save();
    renderRecs();
    const r = recommend(state, [p], { weekStart, now })[0];
    if (r) addBot(`새 공고 알림: 희망 분야(${r.match.join(', ')})에 맞는 '${p.title}'가 올라왔어요. ${r.score}점 · D-${r.daysLeft} · ${r.reasons[1]}`);
    else addBot(`새 공고 '${p.title}'가 올라왔지만 희망 분야와 맞지 않아 알리지 않았어요.`);
  });

  $('#btnInterests').addEventListener('click', () => openOnboarding(true));

  $('#btnDemo').addEventListener('click', () => { undoStack.push(clone(state)); state = demoState(now); app.demo = true; preview = null; recompute(); toast('데모 데이터를 불러왔어요'); });
  $('#btnClear').addEventListener('click', () => { commit(emptyState(), '모두 비웠어요'); });

  // 가져오기
  const importICS = text => {
    const items = parseICS(text);
    if (!items.length) { toast('가져올 일정이 없어요'); return; }
    const s = clone(state);
    let n = 0;
    for (const it of items) {
      if (s.tasks.some(t => t.title === it.title && t.due === it.due)) continue;
      applyOp(s, { type: 'add_task', ...it });
      n++;
    }
    commit(s, `과제 ${n}개를 가져왔어요`);
    addBot(`LMS에서 과제 ${n}개를 가져와 계획에 넣었어요.`, items.map(i => `${i.title} (${i.course || '기타'}) · 마감 ${fmtDue(i.due)}`));
  };
  $('#icsFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) importICS(await f.text());
    e.target.value = '';
  });
  $('#btnSampleIcs').addEventListener('click', () => importICS(SAMPLE_ICS(weekStart)));

  $('#ttFile').addEventListener('click', e => {
    if (!app.apiKey) { e.preventDefault(); toast('설정에서 Claude API 키를 먼저 넣어주세요'); }
  });
  $('#ttFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const typing = addMsg('시간표 이미지를 읽는 중…', 'typing');
    try {
      const rows = await readTimetableImage({ apiKey: app.apiKey, model: app.model || DEFAULT_MODEL, file: f });
      typing.remove();
      const s = clone(state);
      s.classes = [];
      for (const r of rows) {
        if (!(r.day >= 0 && r.day <= 6) || !r.start || !r.end) continue;
        s.classes.push({ id: newId('c'), title: r.title, day: r.day, start: r.start.padStart(5, '0'), end: r.end.padStart(5, '0') });
        colorFor(s, r.title);
      }
      commit(s, `수업 ${s.classes.length}개를 읽었어요`);
      addBot(`시간표에서 수업 ${s.classes.length}개를 읽어 기존 수업을 바꿨어요. 틀린 칸은 '수업' 탭에서 고쳐주세요.`);
    } catch (err) {
      typing.remove();
      addBot(`시간표를 읽지 못했어요: ${err.message}`, [], true);
    }
  });

  $('#btnExport').addEventListener('click', async () => {
    const p = n => String(n).padStart(2, '0');
    const stamp = (day, hhmm) => {
      const d = dateOfDay(weekStart, day);
      const [h, m] = hhmm.split(':');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(h)}${p(m)}00`;
    };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PlanPick//KO'];
    for (const b of plan) {
      const t = taskOf(state, b.taskId);
      lines.push('BEGIN:VEVENT', `UID:${b.id}-${stamp(b.day, b.start)}@planpick`, `SUMMARY:[공부] ${t.title}`, `DTSTART:${stamp(b.day, b.start)}`, `DTEND:${stamp(b.day, b.end)}`, 'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    try { await navigator.clipboard.writeText(lines.join('\r\n')); toast('.ics 텍스트를 복사했어요'); }
    catch { toast('복사하지 못했어요'); }
  });

  // 컨디션 바 (헬스케어 융합)
  const setCond = (vals, source) => {
    const s = clone(state);
    const msg = applyOp(s, { type: 'set_condition', ...vals, source, now });
    commit(s, msg);
    return msg;
  };
  $('#condSleep').addEventListener('input', e => { $('#condSleepVal').textContent = `${e.target.value}h`; });
  $('#condSleep').addEventListener('change', e => setCond({ sleep_hours: Number(e.target.value), stress: Number($('#condStress').value) }, 'manual'));
  $('#condStress').addEventListener('change', e => setCond({ sleep_hours: Number($('#condSleep').value), stress: Number(e.target.value) }, 'manual'));
  $('#btnWearable').addEventListener('click', () => {
    // 실제 서비스에서는 Health Connect·HealthKit에서 지난밤 수면과 HRV 기반 스트레스를 읽는다
    const sleep = 5.2;
    const stress = 4;
    const before = todayInfo ? todayInfo.capMin : null;
    setCond({ sleep_hours: sleep, stress }, 'wearable');
    addBot(`웨어러블(모의 데이터)에서 지난밤 수면 ${sleep}시간, 스트레스 ${stress}/5를 불러왔어요. 오늘 공부량을 ${before != null ? `${before / 60}시간 → ` : ''}${todayInfo.capMin / 60}시간으로 줄이고, 블록을 ${todayInfo.effect.blockCap}분으로 짧게 나눴어요. 남은 분량은 내일 이후로 옮겼어요.`);
  });

  // 설정
  const dlg = $('#settings');
  $('#btnSettings').addEventListener('click', () => {
    const f = dlg.querySelector('form').elements;
    f.studyStart.value = state.prefs.studyStart === '24:00' ? '23:59' : state.prefs.studyStart;
    f.studyEnd.value = state.prefs.studyEnd === '24:00' ? '23:59' : state.prefs.studyEnd;
    f.dailyMax.value = state.prefs.dailyMax;
    f.blockMin.value = state.prefs.blockMin;
    f.commuteMin.value = state.prefs.commuteMin;
    f.commuteMode.value = state.prefs.commuteMode;
    f.apiKey.value = app.apiKey || '';
    f.model.value = app.model || DEFAULT_MODEL;
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    const f = dlg.querySelector('form').elements;
    app.apiKey = f.apiKey.value.trim();
    app.model = f.model.value.trim() || DEFAULT_MODEL;
    const s = clone(state);
    const end = f.studyEnd.value === '23:59' ? '24:00' : f.studyEnd.value;
    try {
      applyOp(s, { type: 'set_preferences', study_start: f.studyStart.value, study_end: end, daily_max_hours: Number(f.dailyMax.value), block_minutes: Number(f.blockMin.value) });
      applyOp(s, { type: 'set_commute', minutes: Number(f.commuteMin.value), mode: f.commuteMode.value });
      commit(s, '설정을 저장했어요');
    } catch { save(); render(); }
  });
}

// ---------- 온보딩 (첫 방문 관심사 선택) ----------
let picks = [];
function openOnboarding(again = false) {
  picks = again ? [...new Set([...(state.modules || []), ...(state.interests || []).filter(f => f !== '취업'), ...((state.interests || []).includes('취업') ? ['career'] : [])])] : ['study'];
  const grid = $('#obGrid');
  grid.innerHTML = TILES.map(t => `<button type="button" class="tile${t.fixed ? ' fixed' : ''}" data-id="${esc(t.id)}" style="height:${t.h}px;background:linear-gradient(150deg, ${t.c1}, ${t.c2})">
      <span class="deco"></span><span class="deco2"></span>
      <span class="tk">${t.kind === 'mod' ? '생활 기능' : '대외활동 분야'}</span>
      <span class="check">✓</span>
      <span class="tt">${esc(t.title)}</span><span class="ts">${esc(t.sub)}</span>
    </button>`).join('');
  const sync = () => {
    grid.querySelectorAll('.tile').forEach(el => el.classList.toggle('on', picks.includes(el.dataset.id)));
    $('#obCount').textContent = `${picks.length}개 선택${picks.length < MIN_PICKS ? ` · ${MIN_PICKS - picks.length}개 더` : ''}`;
    $('#obDone').disabled = picks.length < MIN_PICKS;
  };
  grid.onclick = e => {
    const el = e.target.closest('.tile');
    if (!el) return;
    const id = el.dataset.id;
    if (TILES.find(t => t.id === id).fixed) return;
    picks = picks.includes(id) ? picks.filter(x => x !== id) : [...picks, id];
    sync();
  };
  sync();
  $('#onboard').hidden = false;
}
function closeOnboarding(apply) {
  $('#onboard').hidden = true;
  app.onboarded = true;
  if (!apply) { save(); return; }
  const r = applyPicks(state, picks);
  commit(r.state, '관심사에 맞춰 계획표를 바꿨어요');
  renderChips();
  const top = hasMod('activities') ? recommend(state, feed(), { weekStart, now }).filter(x => x.fit !== 'clash')[0] : null;
  addBot(`관심사에 맞춰 계획표를 꾸렸어요.${top ? `\n오늘의 추천 공고: '${top.opp.title}' (${top.score}점, D-${top.daysLeft})` : ''}\n${helpText()}`, r.lines);
}

// ---------- 시작 ----------
fillDaySelects();
bind();
$('#obDone').addEventListener('click', () => closeOnboarding(true));
$('#obSkip').addEventListener('click', () => closeOnboarding(false));
recompute();
renderChips();
const tdue = new Date(now.getTime() + 3 * 86400000);
tdue.setHours(23, 59, 0, 0);
$('#taskForm').elements.due.value = localISO(tdue);
if (!app.onboarded) openOnboarding(false);
else {
  addBot(`다시 오셨네요! 이번 주 계획을 최신 상태로 다시 짰어요.\n${helpText()}`);
  const fresh = hasMod('activities') ? recommend(state, feed(), { weekStart, now }).filter(r => r.opp.posted === 0) : [];
  if (fresh.length) addBot(`희망 분야 새 공고 ${fresh.length}건이 올라왔어요.`, fresh.map(r => `${r.opp.title} · ${r.score}점 · D-${r.daysLeft}`));
}
