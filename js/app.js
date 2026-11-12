import { schedule, diffPlans, DAY_NAMES, weekStartOf, dateOfDay, toMin, toHHMM, isMobileTask, localDateKey } from './scheduler.js';
import { demoState, emptyState, applyOp, clone, colorFor, localISO, newId, defaultPrefs, EVENT_KINDS, INTEREST_FIELDS } from './state.js';
import { TILES, MIN_PICKS, applyPicks } from './onboarding.js';
import { recommend, sampleFeed, incomingPost } from './opportunities.js';
import { briefing, explainBlock, feasibilityOptions, missedSince, gapsFor } from './agent.js';
import { extractOps, extractSyllabus, pdfText, SAMPLE_SYLLABUS, SAMPLE_CHAT, semesterStart } from './extract.js';
import { myBusyCode, parseCodes, commonFree, demoTeammates, studyCode } from './share.js';
import { weeklyReport } from './report.js';
import { SHIFT_PROMPT, extractWithLLM, startHelper } from './llm.js';
import { parseICSEvents } from './ics.js';
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
      if (!s.demo && s.state) s.state.blocked = (s.state.blocked || []).filter(b => b.recurring);
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
let sched = null;
app.agentMode = app.agentMode || 'confirm';
app.proactive = app.proactive || 'on';
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
  sched = r;
  plan = r.plan;
  commutes = r.commutes;
  todayInfo = r.today;
  warnings = r.warnings;
  render();
  app.lastPlan = { at: new Date().toISOString(), blocks: plan.map(({ taskId, day, start, end, habit }) => ({ taskId, day, start, end, habit })) };
  save();
  scheduleNotifs();
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
  renderNow();
  renderFixOpts();
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
      html += `<div class="ev habit k-${esc(h.kind || '운동')} ${newKeys.has(b.id) ? 'new' : ''}" data-block="${b.id}" style="${pos(b.start, b.end)}" title="${esc(h.title)} · 주 ${h.perWeek}회 목표"><span class="tt">${esc(h.title)}</span><span class="tm">${b.start}–${b.end}</span></div>`;
    }
    for (const b of p.filter(x => x.day === d && !x.habit)) {
      const t = taskOf(s, b.taskId) || {};
      const mob = b.mobile ? ' mobile' : '';
      const style = b.mobile ? `border-color:${colorFor(s, t.course)};color:${colorFor(s, t.course)}` : `background:${colorFor(s, t.course)}`;
      html += `<div class="ev study${mob} ${newKeys.has(b.id) ? 'new' : ''}" data-task="${t.id}" data-block="${b.id}" style="${pos(b.start, b.end)};${style}" title="${b.mobile ? '이동 중 학습 · ' : ''}${esc(t.title)} · 마감 ${fmtDue(t.due)}\n왜 여기? ${esc((b.why || []).join(', '))}"><span class="tt">${b.mobile ? '이동 중 · ' : ''}${esc(t.title)}</span><span class="tm">${b.start}–${b.end}</span></div>`;
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

function showPreview(draft, summary, applied, opts = {}) {
  if (app.agentMode === 'auto' && !opts.simulate) {
    const before = plan;
    commit(draft, '바로 적용했어요');
    const d = diffPlans(before, plan, state.tasks, state.habits);
    const el = document.createElement('div');
    el.className = 'auto-card';
    el.innerHTML = `<b>바로 적용했어요</b>${summary ? `<div>${esc(summary)}</div>` : ''}<ul class="ops">${applied.map(a => `<li>${esc(a)}</li>`).join('')}</ul><div>블록 ${d.removed}개 빠지고 ${d.added}개 새로 배치</div><button class="small ghost" data-undo>되돌리기</button>`;
    el.querySelector('[data-undo]').onclick = e => { e.target.disabled = true; undo(); };
    $('#messages').appendChild(el);
    $('#messages').scrollTop = 1e9;
    return;
  }
  const r = schedule(draft, { weekStart, now });
  const diff = diffPlans(plan, r.plan, draft.tasks, draft.habits);
  preview = { draft, plan: r.plan, commutes: r.commutes, today: r.today, warnings: r.warnings, diff };
  render();
  const el = document.createElement('div');
  el.className = 'preview';
  const changeLine = diff.added + diff.removed ? `공부 블록 ${diff.removed}개 빠지고 ${diff.added}개 새로 배치` : '공부 블록 위치는 그대로예요';
  el.innerHTML = `<h4>${opts.simulate ? '만약에 시뮬레이션 (아직 적용 안 됨)' : '변경안 미리보기'}</h4>${summary ? `<div>${esc(summary)}</div>` : ''}${applied.length ? `<ul class="ops">${applied.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}<pre>${esc(changeLine)}${diff.lines.length ? '\n' + diff.lines.map(esc).join('\n') : ''}</pre><div class="acts"><button class="small" data-pv="apply">적용</button><button class="small ghost" data-pv="cancel">취소</button></div>`;
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
  if (r.special === 'briefing') { openBriefing(); return; }
  if (r.special === 'report') { openReport(); return; }
  if (r.special === 'team') { openTeam(); return; }
  if (r.special === 'gaps') { explainGaps(); return; }
  if (r.special === 'explain') { explainFromChat(r.query); return; }
  if (r.help) { addBot(`이해하지 못했어요. ${helpText()}`); return; }
  if (r.special === 'reschedule' && !r.ops.length) { recompute(); addBot('남은 과제로 계획을 다시 짰어요.'); return; }
  const draft = clone(state);
  const applied = [];
  const errors = [];
  for (const op of r.ops) {
    try { applied.push(applyOp(draft, op)); } catch (e) { errors.push(e.message); }
  }
  if (!applied.length) { addBot('요청을 반영하지 못했어요.', errors, true); return; }
  showPreview(draft, '', applied, { simulate: !!r.simulate });
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
    const el = e.target.closest('.ev[data-block]');
    if (!el || preview) return;
    const b = plan.find(x => x.id === el.dataset.block);
    if (b) openBlockSheet(b);
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
    f.agentMode.value = app.agentMode;
    f.proactive.value = app.proactive;
    f.myName.value = app.myName || '';
    f.apiKey.value = app.apiKey || '';
    f.model.value = app.model || DEFAULT_MODEL;
    dlg.showModal();
  });
  dlg.addEventListener('close', () => {
    if (dlg.returnValue !== 'save') return;
    const f = dlg.querySelector('form').elements;
    app.agentMode = f.agentMode.value;
    app.proactive = f.proactive.value;
    app.myName = f.myName.value.trim();
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

// ======================= 에이전트·실행·협업 기능 =======================
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const blockTitle = b => (b.habit ? (habitOf(state, b.taskId) || {}).title : (taskOf(state, b.taskId) || {}).title) || '';
const blockDate = b => localDateKey(dateOfDay(weekStart, b.day));

function openModal(html) {
  $('#modalBody').innerHTML = html;
  const dlg = $('#modal');
  if (!dlg.open) dlg.showModal();
  return $('#modalBody');
}
const closeModal = () => $('#modal').close();

// 지금/다음 위젯
function renderNow() {
  if (preview) return;
  const m = nowMin();
  const todays = plan.filter(b => b.day === today).sort((a, b) => toMin(a.start) - toMin(b.start));
  const cur = todays.find(b => toMin(b.start) <= m && toMin(b.end) > m);
  const next = todays.find(b => toMin(b.start) > m);
  const parts = [];
  if (cur) parts.push(`<span class="lbl">지금</span><b>${esc(blockTitle(cur))}</b> ~${cur.end}`);
  if (next) parts.push(`<span class="lbl next">다음</span><b>${esc(blockTitle(next))}</b> ${next.start}`);
  if (!parts.length) parts.push('<span class="lbl next">오늘</span>남은 공부 블록이 없어요. 수고했어요!');
  const tgt = cur || next;
  $('#nowCard').innerHTML = `${parts.join(' ')}<span class="sp"></span>${tgt ? `<button class="small" data-now="focus" data-block="${tgt.id}">집중 시작</button>` : ''}<button class="ghost small" data-now="notif">${'Notification' in window && Notification.permission === 'granted' ? '알림 켜짐' : '알림 켜기'}</button>`;
}

// 배치 못 한 과제가 있을 때 선택지 버튼
function renderFixOpts() {
  if (preview || !sched) { $('#fixOpts').innerHTML = ''; return; }
  const opts = feasibilityOptions(state, sched);
  renderFixOpts.opts = opts;
  $('#fixOpts').innerHTML = opts.length ? `<span class="muted" style="font-size:12px;color:var(--muted)">이렇게 해볼까요?</span>${opts.map((o, i) => `<button data-fix="${i}">${esc(o.label)}</button>`).join('')}` : '';
}

// 블록 시작 10분 전 알림
let notifTimers = [];
function scheduleNotifs() {
  notifTimers.forEach(clearTimeout);
  notifTimers = [];
  if (app.proactive === 'off') return;
  const m = nowMin();
  for (const b of plan.filter(x => x.day === today)) {
    const at = toMin(b.start) - 10;
    if (at <= m || at - m > 12 * 60) continue;
    notifTimers.push(setTimeout(() => {
      const msg = `10분 뒤 ${b.start} '${blockTitle(b)}'${b.mobile ? ' (통학 중)' : ''}`;
      toast(msg);
      try { if (Notification.permission === 'granted') new Notification('PlanPick', { body: msg }); } catch { /* 알림 미지원 */ }
    }, (at - m) * 60000));
  }
}

// 블록 시트: 배치 이유·집중 시작·완료/못 함·쪼개기·시작 도우미·제출 체크리스트
function openBlockSheet(b) {
  const isHabit = !!b.habit;
  const t = isHabit ? habitOf(state, b.taskId) : taskOf(state, b.taskId);
  if (!t) return;
  const len = toMin(b.end) - toMin(b.start);
  const dueSoon = !isHabit && (new Date(t.due) - now) / 3600000 < 48;
  const items = ['파일명이 안내 형식과 맞나요?', 'PDF 변환 후 깨진 곳은 없나요?', '최종본을 올렸나요?', '제출 버튼까지 눌렀나요?', '제출 완료 화면을 캡처했나요?'];
  const ck = t.checklist || {};
  const body = openModal(`
    <h2>${esc(t.title)}</h2>
    <div class="muted">${DAY_NAMES[b.day]}요일 ${b.start}–${b.end} · ${len}분${isHabit ? ` · 주 ${t.perWeek}회 목표` : ` · 마감 ${fmtDue(t.due)} · 예상 ${t.hours}h${t.doneMin ? ` · ${Math.round(t.doneMin / 6) / 10}h 완료` : ''}`}</div>
    <div class="why"><b>왜 이 시간에?</b> ${esc((b.why || []).join(', ') || '빈 시간 중 가장 이른 시간')}</div>
    ${dueSoon ? `<h3>제출 전 체크리스트</h3><div class="chk">${items.map((x, i) => `<label><input type="checkbox" data-ck="${i}" ${ck[i] ? 'checked' : ''}/> ${esc(x)}</label>`).join('')}</div>` : ''}
    <div id="helperOut"></div>
    <div class="acts">
      <button data-s="focus">집중 시작 (${len}분)</button>
      <button class="ghost" data-s="done">끝냈어요</button>
      <button class="ghost" data-s="skip">못 했어요</button>
      ${!isHabit && t.hours >= 3 && !t.parent ? '<button class="ghost" data-s="split">단계로 쪼개기</button>' : ''}
      ${!isHabit ? '<button class="ghost" data-s="help">시작 도우미</button>' : ''}
      <button class="ghost" data-s="close">닫기</button>
    </div>`);
  body.onclick = async e => {
    const ckEl = e.target.closest('[data-ck]');
    if (ckEl) { const s2 = clone(state); applyOp(s2, { type: 'set_checklist', task_id: t.id, item: ckEl.dataset.ck, checked: ckEl.checked }); state = s2; save(); return; }
    const a = e.target.dataset.s;
    if (!a) return;
    if (a === 'close') closeModal();
    if (a === 'focus') { closeModal(); startFocus(b); }
    if (a === 'done') { closeModal(); logBlock(b, len, true); }
    if (a === 'skip') { closeModal(); logBlock(b, 0, false); }
    if (a === 'split') { closeModal(); const d = clone(state); try { showPreview(d, '', [applyOp(d, { type: 'split_task', task_id: t.id, now })]); } catch (err) { toast(err.message); } }
    if (a === 'help') {
      const out = $('#helperOut');
      if (app.apiKey) {
        out.innerHTML = '<div class="why">시작 도우미가 생각 중…</div>';
        try { out.innerHTML = `<div class="why"><b>시작 도우미</b><div style="white-space:pre-wrap">${esc(await startHelper({ apiKey: app.apiKey, model: app.model || DEFAULT_MODEL, task: t }))}</div></div>`; }
        catch (err) { out.innerHTML = `<div class="why">${esc(err.message)}</div>`; }
      } else {
        const steps = templateFirstSteps(t);
        out.innerHTML = `<div class="why"><b>시작 도우미</b> (대신 써주지 않아요)<ul>${steps.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
      }
    }
  };
}

function templateFirstSteps(t) {
  if (/구현|코딩|과제\d|실습/.test(t.title)) return ['과제 명세에서 입력·출력 형식과 채점 기준 표시하기', '핵심 함수 3개의 이름과 역할만 먼저 적기', '가장 작은 테스트 케이스 하나 통과시키기'];
  if (/보고서|레포트|팀플|발표|ERD|기획/.test(t.title)) return ['요구 분량·형식·제출 방식 확인하기', '목차 5줄 먼저 쓰기', '근거 자료 2개 찾아 링크 저장하기'];
  if (/퀴즈|시험|복습|문제/.test(t.title)) return ['시험 범위 목차 펼치기', '틀렸던 문제 3개 다시 풀기', '헷갈리는 개념 1개 요약 카드 만들기'];
  return ['오늘 끝낼 범위 한 줄로 정하기', '필요한 자료 열어두기', '25분 동안 첫 부분만 하기'];
}

// 실행 기록 → 소요시간·집중 시간대 학습, 미완료는 자동 재배치
function logBlock(b, actual, done, finished = false) {
  const s2 = clone(state);
  const planned = toMin(b.end) - toMin(b.start);
  const msg = applyOp(s2, { type: 'log_block', task_id: b.taskId, planned, actual, hour: Math.floor(toMin(b.start) / 60), done, finished, date: blockDate(b) });
  commit(s2, msg);
  addBot(done ? `${msg}. 실제 걸린 시간을 배워서 다음 계획에 반영해요.` : `${msg}. 괜찮아요, 남은 빈 시간에 다시 넣었어요.`);
}

// 집중 타이머 (포모도로)
let focusT = null;
function startFocus(b) {
  const total = (toMin(b.end) - toMin(b.start)) * 60;
  let left = total;
  let paused = false;
  const startedAt = Date.now();
  $('#fTask').textContent = blockTitle(b);
  $('#fSub').textContent = (b.why || []).slice(0, 2).join(' · ');
  $('#focus').hidden = false;
  const draw = () => {
    $('#fTime').textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    $('#fBar').style.width = `${100 - (left / total) * 100}%`;
  };
  draw();
  clearInterval(focusT);
  focusT = setInterval(() => {
    if (paused) return;
    left = Math.max(0, left - ($('#fFast').checked ? 60 : 1));
    draw();
    if (left === 0) finish(true);
  }, 1000);
  const finish = done => {
    clearInterval(focusT);
    $('#focus').hidden = true;
    const spent = $('#fFast').checked ? Math.round((total - left) / 60) : Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    if (done) logBlock(b, Math.max(spent, 1), true);
    else if (spent >= 5) logBlock(b, spent, true);
  };
  $('#fPause').onclick = () => { paused = !paused; $('#fPause').textContent = paused ? '계속' : '일시정지'; };
  $('#fDone').onclick = () => finish(true);
  $('#fStop').onclick = () => finish(false);
}

// 아침 브리핑 / 저녁 회고
function openBriefing(auto = false) {
  const recs = hasMod('activities') ? recommend(state, feed(), { weekStart, now }) : [];
  const br = briefing(state, sched, { weekStart, now }, recs);
  const exams = (state.academic || []).filter(a => new Date(a.start) > now).map(a => `${a.name} D-${Math.ceil((new Date(a.start) - now) / 86400000)}`);
  const pillB = br.burn.level === 'high' ? 'hi' : br.burn.level === 'mid' ? 'mid' : 'ok';
  const list = arr => arr.map(b => `<li>${b.start}–${b.end} ${esc(blockTitle(b))}${b.mobile ? ' (통학 중)' : ''}</li>`).join('');
  if (br.kind === 'evening') {
    const todays = plan.filter(b => b.day === today && toMin(b.start) < nowMin());
    const body = openModal(`
      <h2>오늘 회고</h2><div class="muted">오늘 블록을 체크하면 못 한 건 내일 이후로 다시 배치하고, 실제 시간을 배워요.</div>
      ${todays.length ? todays.map(b => `<div class="rv"><span class="t">${b.start} ${esc(blockTitle(b))}</span><select data-rv="${b.id}"><option value="done">다 했어요</option><option value="half">절반 했어요</option><option value="skip">못 했어요</option></select></div>`).join('') : '<p class="muted">오늘 지나간 블록이 없어요.</p>'}
      <h3>내일 미리보기</h3><ul>${list(br.tomorrow) || '<li>배치된 블록 없음</li>'}</ul>
      ${br.counsel ? `<h3>마음 챙기기</h3><p>${esc(br.counsel)}</p>` : ''}
      <div class="acts"><button data-b="apply">회고 반영하고 내일 다시 짜기</button><button class="ghost" data-b="close">닫기</button></div>`);
    body.onclick = e => {
      const a = e.target.dataset.b;
      if (a === 'close') closeModal();
      if (a !== 'apply') return;
      const s2 = clone(state);
      let doneN = 0;
      let skipN = 0;
      body.querySelectorAll('[data-rv]').forEach(sel => {
        const b = plan.find(x => x.id === sel.dataset.rv);
        const len = toMin(b.end) - toMin(b.start);
        const v = sel.value;
        applyOp(s2, { type: 'log_block', task_id: b.taskId, planned: len, actual: v === 'done' ? len : v === 'half' ? Math.round(len / 2) : 0, hour: Math.floor(toMin(b.start) / 60), done: v !== 'skip', date: blockDate(b) });
        if (v === 'skip') skipN++; else doneN++;
      });
      closeModal();
      commit(s2, '회고를 반영했어요');
      addBot(`오늘 ${doneN}개 완료, ${skipN}개는 내일 이후 빈 시간으로 옮겼어요. 푹 쉬세요.`);
    };
  } else {
    const body = openModal(`
      <h2>${br.kind === 'morning' ? '좋은 아침이에요' : '오늘 남은 하루'}</h2>
      <div class="muted">${now.getMonth() + 1}월 ${now.getDate()}일 ${DAY_NAMES[today]}요일${todayInfo ? ` · ${esc(todayInfo.effect.label)}` : ''}${exams.length ? ` · ${exams.join(', ')}` : ''}</div>
      <h3>오늘 할 일</h3><ul>${list(br.upcoming) || '<li>남은 블록이 없어요</li>'}</ul>
      ${br.gaps.length ? `<h3>공강 활용</h3><ul>${br.gaps.map(g => `<li>${g.start}–${g.end} (${g.len}분) · ${esc(g.place)}에서 '${esc(g.suggestion || '복습')}' 추천</li>`).join('')}</ul>` : ''}
      ${br.risks.length ? `<h3>마감 위험</h3><ul>${br.risks.map(r => `<li><span class="pill ${r.level === 'high' ? 'hi' : 'mid'}">${r.level === 'high' ? '위험' : '주의'}</span>${esc(r.text)}</li>`).join('')}</ul>` : ''}
      <h3>이번 주 부하</h3><p><span class="pill ${pillB}">${br.burn.level === 'high' ? '번아웃 주의' : br.burn.level === 'mid' ? '빡빡함' : '적당함'}</span> 총 ${br.burn.totalH}시간 · 가장 바쁜 날 ${DAY_NAMES[br.burn.peakDay]}요일 ${br.burn.peakH}시간 · 2시간 미만으로 쉬는 날 ${br.burn.restDays}일${br.burn.level !== 'ok' ? `<br>제안: ${DAY_NAMES[br.burn.peakDay]}요일 저녁 하나를 비워 쉬는 시간을 만들어 보세요.` : ''}</p>
      ${br.actDeadlines.length ? `<h3>대외활동 마감</h3><ul>${br.actDeadlines.map(r => `<li>${esc(r.opp.title)} D-${r.daysLeft}</li>`).join('')}</ul>` : ''}
      ${br.counsel ? `<h3>마음 챙기기</h3><p>${esc(br.counsel)}</p>` : ''}
      <div class="acts">${br.burn.level !== 'ok' ? `<button class="ghost" data-b="rest">${DAY_NAMES[br.burn.peakDay]}요일 저녁 비우기</button>` : ''}<button data-b="close">시작하기</button></div>`);
    body.onclick = e => {
      const a = e.target.dataset.b;
      if (a === 'close') closeModal();
      if (a === 'rest') { closeModal(); const d = clone(state); showPreview(d, '번아웃 예방', [applyOp(d, { type: 'block_time', day: br.burn.peakDay, start: '19:00', end: '24:00', reason: '휴식' })]); }
    };
  }
  if (auto) app.lastBriefing = `${localDateKey(now)}|${br.kind}`;
  save();
}

// 주간 리포트·학기 회고
function openReport() {
  const r = weeklyReport(state, sched);
  const total = r.split.reduce((a, x) => a + x.min, 0) || 1;
  const maxN = Math.max(1, ...r.hourBars.map(x => x.n));
  openModal(`
    <h2>주간 리포트</h2><div class="muted">${$('#weekLabel').textContent} · 계획 기준 시간 분배와 실행 기록</div>
    <h3>시간 분배</h3>
    <div class="hbar">${r.split.map(x => `<i style="width:${(x.min / total) * 100}%;background:${x.color}" title="${x.label}"></i>`).join('')}</div>
    <div class="legend2">${r.split.map(x => `<span><b style="background:${x.color}"></b>${esc(x.label)} ${Math.round(x.min / 6) / 10}h</span>`).join('')}</div>
    <h3>계획 달성률</h3><p>${r.rate == null ? '아직 실행 기록이 없어요. 블록을 눌러 "끝냈어요"·"못 했어요"를 남기거나 저녁 회고를 하면 채워져요.' : `<b>${r.rate}%</b> (기록 ${r.logged}개)`}</p>
    <h3>시간대별 실행 기록</h3>
    <div class="hours24">${r.hourBars.map(x => `<div class="${r.focus.includes(x.hour) ? 'f' : ''}" style="height:${(x.n / maxN) * 100}%" title="${x.hour}시 · 기록 ${x.n}개 · 완료율 ${Math.round(x.rate * 100)}%"><span>${x.hour % 3 === 0 ? x.hour : ''}</span></div>`).join('')}</div>
    <h3 style="margin-top:24px">학기 회고 · 과목별</h3>
    ${r.courses.length ? `<ul>${r.courses.map(c => `<li>${esc(c.course)}: 실제 ${c.actualH}h / 계획 ${c.plannedH}h (×${c.ratio})</li>`).join('')}</ul>` : '<p class="muted">기록이 쌓이면 과목별로 보여드려요.</p>'}
    ${r.tips.length ? `<h3>다음 주 제안</h3><ul>${r.tips.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="acts"><button class="ghost" data-r="demo">기록 예시 채우기(시연)</button><button data-r="close">닫기</button></div>`).onclick = e => {
    if (e.target.dataset.r === 'close') closeModal();
    if (e.target.dataset.r === 'demo') {
      const s2 = clone(state);
      const samples = [['자료구조', 20, 90, 120], ['자료구조', 21, 90, 110], ['자료구조', 14, 60, 70], ['운영체제', 10, 60, 50], ['운영체제', 20, 60, 55], ['데이터베이스', 21, 90, 90], ['데이터베이스', 15, 90, 40], ['확률통계', 20, 60, 60], ['확률통계', 16, 60, 30]];
      for (const [course, hour, planned, actual] of samples) s2.log = [...(s2.log || []), { taskId: 'demo', course, planned, actual, hour, done: actual >= planned * 0.5, date: '' }];
      commit(s2, '실행 기록 예시를 채웠어요');
      openReport();
    }
  };
}

// 팀플 공통 빈 시간 · 스터디 계획 공유
function openTeam() {
  const mine = myBusyCode(app.myName, state, plan);
  const body = openModal(`
    <h2>팀플 시간 맞추기</h2>
    <div class="muted">서버 없이 공유 코드로 맞춰요. 코드에는 바쁜 시간만 들어가고 일정 이름은 들어가지 않아요.</div>
    <h3>내 코드</h3><div class="code">${esc(mine)}</div>
    <div class="acts" style="justify-content:flex-start"><button class="ghost small" data-t="copy">내 코드 복사</button></div>
    <h3>팀원 코드</h3><textarea id="teamCodes" rows="3" placeholder="팀원이 보낸 코드를 붙여넣으세요 (여러 개면 줄바꿈)"></textarea>
    <div class="acts" style="justify-content:flex-start"><button class="small" data-t="calc">공통 빈 시간 찾기</button><button class="ghost small" data-t="demo">시연용 팀원 2명</button></div>
    <div id="teamOut"></div>
    <h3>스터디 계획 공유</h3><div class="muted">시험 복습 회차를 코드로 넘겨 스터디원과 같은 계획으로 공부해요.</div>
    <div class="acts" style="justify-content:flex-start"><button class="ghost small" data-t="study">내 시험 계획 코드 복사</button></div>
    <div class="acts"><button data-t="close">닫기</button></div>`);
  let members = [];
  const calc = () => {
    const parsed = parseCodes($('#teamCodes').value);
    const studies = parsed.members.filter(m => m.t === 'study');
    members = parsed.members.filter(m => m.t === 'busy');
    const me = { name: app.myName || '나', busy: [...state.classes.map(c => [c.day, c.start, c.end]), ...state.events.map(e => [e.day, e.start, e.end])] };
    const slots = commonFree([me, ...members], { fromDay: today, nowMin: nowMin() });
    let html = '';
    if (studies.length) {
      html += `<p>스터디 계획 ${studies.length}개를 찾았어요.</p><button class="small" data-t="importStudy">스터디 계획 가져오기</button>`;
      calc.studies = studies;
    }
    if (members.length) html += `<h3>${[me.name, ...members.map(m => m.name)].join(', ')} 모두 비는 시간</h3>${slots.length ? slots.map((x, i) => `<div class="slot"><span>${x.label}${x.len >= 90 ? ' <span class="pill ok">여유</span>' : ''}</span><button class="small ghost" data-slot="${i}">회의로 넣기</button></div>`).join('') : '<p>이번 주에는 모두 비는 1시간이 없어요.</p>'}`;
    if (parsed.errors.length) html += `<p class="muted">${parsed.errors.length}개 코드를 읽지 못했어요.</p>`;
    $('#teamOut').innerHTML = html;
    calc.slots = slots;
  };
  body.onclick = async e => {
    const t = e.target.dataset.t;
    if (t === 'close') closeModal();
    if (t === 'copy') { try { await navigator.clipboard.writeText(mine); toast('내 코드를 복사했어요'); } catch { toast('직접 선택해 복사해 주세요'); } }
    if (t === 'study') { try { await navigator.clipboard.writeText(studyCode(app.myName, state)); toast('시험 계획 코드를 복사했어요'); } catch { toast('복사하지 못했어요'); } }
    if (t === 'demo') { $('#teamCodes').value = demoTeammates().map(m => btoa(unescape(encodeURIComponent(JSON.stringify(m))))).join('\n'); calc(); }
    if (t === 'calc') calc();
    if (t === 'importStudy') {
      const s2 = clone(state);
      let n = 0;
      for (const st of calc.studies) for (const task of st.tasks) { applyOp(s2, { type: 'add_task', ...task }); s2.tasks[s2.tasks.length - 1].exam = true; n++; }
      closeModal();
      commit(s2, `스터디 복습 ${n}회를 가져왔어요`);
    }
    if (e.target.dataset.slot != null) {
      const x = calc.slots[Number(e.target.dataset.slot)];
      const end = toMin(x.end) - toMin(x.start) > 90 ? toHHMM(toMin(x.start) + 90) : x.end;
      closeModal();
      const d = clone(state);
      showPreview(d, `팀원 ${members.length}명과 모두 비는 시간이에요`, [applyOp(d, { type: 'add_event', title: '팀플 회의', kind: '대외활동', day: x.day, start: x.start, end })]);
    }
  };
}

function explainGaps() {
  const g = [...gapsFor(state, sched, today), ...gapsFor(state, sched, Math.min(6, today + 1))];
  if (!g.length) { addBot('오늘·내일은 수업 사이 공강이 없어요.'); return; }
  addBot('공강을 이렇게 써보세요.', g.map(x => `${DAY_NAMES[x.day]} ${x.start}–${x.end} (${x.len}분) · ${x.place} · '${x.suggestion || '복습'}'`));
}

function explainFromChat(q) {
  const cand = plan.filter(b => !q || blockTitle(b).includes(q) || (q.length >= 2 && blockTitle(b).split(/\s+/).some(w => w.length >= 2 && q.includes(w))));
  const b = cand.find(x => x.day > today || (x.day === today && toMin(x.end) > nowMin())) || cand[0];
  if (!b) { addBot('설명할 블록을 찾지 못했어요. 계획표에서 블록을 누르면 이유가 보여요.'); return; }
  addBot(explainBlock(state, b));
}

function bindExtras() {
  $('#nowCard').addEventListener('click', async e => {
    const a = e.target.dataset.now;
    if (a === 'focus') { const b = plan.find(x => x.id === e.target.dataset.block); if (b) startFocus(b); }
    if (a === 'notif') {
      if (!('Notification' in window)) { toast('이 브라우저는 알림을 지원하지 않아요'); return; }
      const p = await Notification.requestPermission();
      toast(p === 'granted' ? '블록 시작 10분 전에 알려드릴게요' : '알림이 거부됐어요. 앱 안 알림으로만 알려드려요');
      renderNow();
      scheduleNotifs();
    }
  });
  $('#fixOpts').addEventListener('click', e => {
    const i = e.target.dataset.fix;
    if (i == null) return;
    const o = renderFixOpts.opts[Number(i)];
    const d = clone(state);
    const applied = o.ops.map(op => applyOp(d, op));
    showPreview(d, '배치 못 한 과제를 위한 선택지', applied);
  });
  $('#btnBrief').addEventListener('click', () => openBriefing());
  $('#btnReport').addEventListener('click', openReport);
  $('#btnTeam').addEventListener('click', openTeam);
  $('#btnDelay').addEventListener('click', () => {
    const d = clone(state);
    const cur = d.commuteDelay && d.commuteDelay.date === localDateKey(now) ? d.commuteDelay.min : 0;
    commit(d, applyOp(d, { type: 'set_commute_delay', minutes: cur ? 0 : 15, now }));
    addBot(cur ? '지연이 풀려 통학 시간을 원래대로 돌렸어요.' : '지하철이 15분 지연돼 오늘 통학 구간을 늘리고, 늘어난 시간에 이동 중 학습을 더 넣었어요. (실시간 교통 연동 시연)');
  });
  $('#examForm').addEventListener('submit', e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const d = clone(state);
    try { showPreview(d, '시험기간 모드', [applyOp(d, { type: 'add_exam', course: f.get('course'), date: f.get('date'), hours: Number(f.get('hours')), now })]); e.target.reset(); }
    catch (err) { toast(err.message); }
  });

  // 붙여넣기 → 일정 찾기
  $('#btnPasteSample').addEventListener('click', () => { $('#pasteText').value = SAMPLE_CHAT(DAY_NAMES[Math.min(6, today + 1)]); });
  $('#btnPaste').addEventListener('click', async () => {
    const text = $('#pasteText').value.trim();
    if (!text) return;
    const d = clone(state);
    let ops;
    if (app.apiKey) {
      try { ops = await extractWithLLM({ apiKey: app.apiKey, model: app.model || DEFAULT_MODEL, text, kind: 'chat', now }); } catch (err) { toast(err.message); }
    }
    if (!ops) ops = extractOps(text, state, { today, now, weekStart }).ops;
    const applied = [];
    for (const op of ops) { try { applied.push(applyOp(d, op)); } catch { /* 건너뜀 */ } }
    if (!applied.length) { addBot('붙여넣은 글에서 일정을 찾지 못했어요.'); return; }
    showPreview(d, '붙여넣은 글에서 찾은 일정이에요', applied);
  });

  // 강의계획서
  const importSyllabus = async text => {
    const course = $('#sylCourse').value.trim() || (text.split('\n')[0].match(/^(\S+)/) || [])[1] || '과목';
    let ops;
    if (app.apiKey) { try { ops = await extractWithLLM({ apiKey: app.apiKey, model: app.model || DEFAULT_MODEL, text, kind: 'syllabus', now }); } catch (err) { toast(err.message); } }
    if (!ops) ops = extractSyllabus(text, course, now);
    const d = clone(state);
    const applied = [];
    for (const op of ops) { try { applied.push(applyOp(d, { ...op, now })); } catch { /* 지난 일정 등 건너뜀 */ } }
    if (!applied.length) { addBot('강의계획서에서 앞으로 남은 시험·과제를 찾지 못했어요.'); return; }
    showPreview(d, `${course} 강의계획서에서 찾은 일정이에요`, applied);
  };
  $('#btnSylSample').addEventListener('click', () => { $('#sylCourse').value = '운영체제'; importSyllabus(SAMPLE_SYLLABUS); });
  $('#sylFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { importSyllabus(/pdf$/i.test(f.name) ? await pdfText(f) : await f.text()); } catch (err) { addBot(`PDF를 읽지 못했어요: ${err.message}`, [], true); }
  });

  // 근무표 사진
  $('#shiftFile').addEventListener('click', e => { if (!app.apiKey) { e.preventDefault(); toast('설정에서 Claude API 키를 먼저 넣어주세요'); } });
  $('#shiftFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const typing = addMsg('근무표를 읽는 중…', 'typing');
    try {
      const rows = await readTimetableImage({ apiKey: app.apiKey, model: app.model || DEFAULT_MODEL, file: f, prompt: SHIFT_PROMPT });
      typing.remove();
      const d = clone(state);
      d.events = d.events.filter(x => x.kind !== '알바');
      const applied = rows.map(r => { try { return applyOp(d, { type: 'add_event', title: r.title || '알바', kind: '알바', day: r.day, start: r.start.padStart(5, '0'), end: r.end.padStart(5, '0') }); } catch { return null; } }).filter(Boolean);
      showPreview(d, '근무표에서 읽은 이번 주 근무예요 (기존 알바 일정을 바꿔요)', applied);
    } catch (err) { typing.remove(); addBot(`근무표를 읽지 못했어요: ${err.message}`, [], true); }
  });

  // 학사일정 예시·개인 캘린더
  $('#btnAcademic').addEventListener('click', () => {
    const st = semesterStart(now);
    const at = w => { const d = new Date(st); d.setDate(d.getDate() + (w - 1) * 7); return localISO(d); };
    const d = clone(state);
    d.academic = [{ name: '중간고사', start: at(8) }, { name: '기말고사', start: at(15) }, { name: '종강', start: at(16) }];
    commit(d, '학사일정을 넣었어요');
    const next = d.academic.find(a => new Date(a.start) > now);
    addBot(next ? `학사일정(예시)을 넣었어요. ${next.name}까지 D-${Math.ceil((new Date(next.start) - now) / 86400000)}예요. 과목별로 '시험 등록'을 하면 복습 회차를 미리 배치해요.` : '학사일정을 넣었어요. 이번 학기 시험은 모두 지났어요.');
  });
  $('#calFile').addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const evs = parseICSEvents(await f.text(), weekStart);
    if (!evs.length) { toast('이번 주 일정이 없어요'); return; }
    const d = clone(state);
    const applied = evs.map(x => { try { return applyOp(d, { type: 'add_event', ...x }); } catch { return null; } }).filter(Boolean);
    showPreview(d, '개인 캘린더에서 가져온 이번 주 일정이에요', applied);
  });

  // 음성 입력
  $('#btnMic').addEventListener('click', () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('이 브라우저는 음성 인식을 지원하지 않아요 (크롬 권장)'); return; }
    const rec = new SR();
    rec.lang = 'ko-KR';
    rec.interimResults = true;
    $('#btnMic').classList.add('rec');
    rec.onresult = ev => { $('#input').value = [...ev.results].map(r => r[0].transcript).join(''); };
    rec.onend = () => { $('#btnMic').classList.remove('rec'); const v = $('#input').value.trim(); if (v) { $('#input').value = ''; handle(v); } };
    rec.onerror = () => { $('#btnMic').classList.remove('rec'); toast('음성을 인식하지 못했어요'); };
    rec.start();
  });

  // 1분마다 위젯·알림 갱신
  setInterval(() => { if (!preview) renderNow(); }, 60000);
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
bindExtras();
$('#obDone').addEventListener('click', () => closeOnboarding(true));
$('#obSkip').addEventListener('click', () => closeOnboarding(false));
const prevPlan = app.lastPlan;
recompute();
renderChips();
const tdue = new Date(now.getTime() + 3 * 86400000);
tdue.setHours(23, 59, 0, 0);
$('#taskForm').elements.due.value = localISO(tdue);
if (!app.onboarded) openOnboarding(false);
else {
  addBot(`다시 오셨네요! 이번 주 계획을 최신 상태로 다시 짰어요.\n${helpText()}`);
  const missed = app.proactive !== 'off' && missedSince(prevPlan, state, { weekStart, now });
  if (missed) addBot(`지난번 이후 기록 없이 지나간 블록 ${missed.count}개(${Math.round(missed.min / 6) / 10}시간)를 남은 빈 시간에 다시 배치했어요. 괜찮아요, 계획은 원래 깨지는 거예요.`, missed.titles);
  const bk = `${localDateKey(now)}|${now.getHours() >= 20 ? 'evening' : now.getHours() < 12 ? 'morning' : 'day'}`;
  if (app.proactive !== 'off' && app.lastBriefing !== bk && (now.getHours() < 12 || now.getHours() >= 20)) openBriefing(true);
  const fresh = hasMod('activities') ? recommend(state, feed(), { weekStart, now }).filter(r => r.opp.posted === 0) : [];
  if (fresh.length) addBot(`희망 분야 새 공고 ${fresh.length}건이 올라왔어요.`, fresh.map(r => `${r.opp.title} · ${r.score}점 · D-${r.daysLeft}`));
}
