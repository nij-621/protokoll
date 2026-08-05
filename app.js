/* Protokoll — 다국어 회의 전사. 오디오는 전사 시에만 Gemini API로 전송, 결과는 이 기기 IndexedDB에만 저장 */
'use strict';

const API = 'https://generativelanguage.googleapis.com';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 설정 (localStorage) ---------- */
const Settings = {
  load() {
    try { return JSON.parse(localStorage.getItem('protokoll-settings')) || {}; }
    catch { return {}; }
  },
  save(s) { localStorage.setItem('protokoll-settings', JSON.stringify(s)); },
};
let settings = Object.assign({ apiKey: '', model: 'gemini-2.5-flash', lang: 'ko' }, Settings.load());

/* ---------- 저장소 (IndexedDB) ---------- */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('protokoll', 1);
      r.onupgradeneeded = e => e.target.result.createObjectStore('meetings', { keyPath: 'id' });
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  req(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  store(mode) { return DB.db.transaction('meetings', mode).objectStore('meetings'); },
  put(m) { return DB.req(DB.store('readwrite').put(m)); },
  all() { return DB.req(DB.store('readonly').getAll()); },
  get(id) { return DB.req(DB.store('readonly').get(id)); },
  del(id) { return DB.req(DB.store('readwrite').delete(id)); },
};

/* ---------- Gemini API ---------- */
async function apiError(r) {
  let msg = `HTTP ${r.status}`;
  try { msg = (await r.json()).error?.message || msg; } catch {}
  if (r.status === 400 && /API key/i.test(msg)) msg = 'API 키가 올바르지 않습니다. 설정에서 확인하세요.';
  if (r.status === 429) msg = 'API 사용량 한도에 걸렸습니다. 잠시 후 다시 시도하세요.';
  return new Error(msg);
}

function guessMime(file) {
  if (file.type && file.type !== 'audio/x-m4a') return file.type;
  const ext = file.name.split('.').pop().toLowerCase();
  return { m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', aac: 'audio/aac',
           ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'audio/mp4' }[ext] || 'audio/mp4';
}

async function uploadAudio(file, onProgress) {
  const mime = guessMime(file);
  const start = await fetch(`${API}/upload/v1beta/files?key=${settings.apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: file.name } }),
  });
  if (!start.ok) throw await apiError(start);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('업로드 URL을 받지 못했습니다.');

  // XHR: 업로드 진행률 표시용
  const uploaded = await new Promise((res, rej) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
    xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => xhr.status < 300 ? res(JSON.parse(xhr.responseText)) : rej(new Error(`업로드 실패 (HTTP ${xhr.status})`));
    xhr.onerror = () => rej(new Error('업로드 중 네트워크 오류'));
    xhr.send(file);
  });

  let f = uploaded.file;
  while (f.state === 'PROCESSING') {
    await sleep(3000);
    const r = await fetch(`${API}/v1beta/${f.name}?key=${settings.apiKey}`);
    if (!r.ok) throw await apiError(r);
    f = await r.json();
  }
  if (f.state !== 'ACTIVE') throw new Error('Gemini가 파일을 처리하지 못했습니다: ' + f.state);
  return { uri: f.uri, mime };
}

async function streamGenerate(parts, priorTurns, onText) {
  const body = {
    contents: [...priorTurns, { role: 'user', parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 65536 },
  };
  const r = await fetch(`${API}/v1beta/models/${settings.model}:streamGenerateContent?alt=sse&key=${settings.apiKey}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw await apiError(r);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', finish = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      let o; try { o = JSON.parse(json); } catch { continue; }
      const c = o.candidates?.[0];
      const t = (c?.content?.parts || []).map(p => p.text || '').join('');
      if (t) { text += t; onText && onText(text); }
      if (c?.finishReason) finish = c.finishReason;
      if (o.promptFeedback?.blockReason) throw new Error('요청이 차단되었습니다: ' + o.promptFeedback.blockReason);
    }
  }
  return { text, finish };
}

// MAX_TOKENS로 잘리면 이어쓰기 요청을 반복해 전체를 받는다
async function generateFull(parts, onText) {
  let turns = [], all = '';
  for (let round = 0; round < 8; round++) {
    const userParts = round === 0 ? parts
      : [{ text: '출력이 중단되었다. 중단된 지점 바로 다음부터 정확히 이어서 계속 출력하라. 이미 출력한 내용은 반복하지 마라.' }];
    const { text, finish } = await streamGenerate(userParts, turns, t => onText && onText(all + t));
    turns = [...turns, { role: 'user', parts: userParts }, { role: 'model', parts: [{ text }] }];
    all += text;
    if (finish !== 'MAX_TOKENS') break;
  }
  return all.trim();
}

async function fetchModels() {
  const r = await fetch(`${API}/v1beta/models?key=${settings.apiKey}&pageSize=100`);
  if (!r.ok) throw await apiError(r);
  const data = await r.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => n.startsWith('gemini') && !/embedding|image|tts|live|audio-dialog/.test(n))
    .sort();
}

/* ---------- 프롬프트 ---------- */
function transcriptPrompt(ctx) {
  return `너는 전문 회의 속기사다. 이 오디오는 영어·독일어·한국어·중국어·일본어가 섞일 수 있는 회의 녹음이다.

규칙:
1. 각 발언을 실제로 말한 언어 그대로 받아써라. 절대 번역하거나 요약하지 마라.
2. 화자를 목소리로 구분해 "Speaker 1", "Speaker 2" 형식으로 표기하라. 같은 화자는 녹음 끝까지 같은 번호를 유지하라.
3. 각 발언 시작 시점의 타임스탬프를 [HH:MM:SS] 형식으로 붙여라.
4. "음", "어", "äh", "also", "like" 같은 필러와 말버릇도 들리는 그대로 포함하라. 문장을 다듬지 마라.
5. 알아듣기 힘든 부분은 [불명확]으로 표시하라.
6. 출력 형식 (한 발언당 한 줄, 다른 텍스트 없이 전사만):
[HH:MM:SS] Speaker 1: 발언 내용
${ctx ? `\n회의 맥락 (고유명사 참고용): ${ctx}` : ''}`;
}

function langName(l) { return l === 'en' ? 'English' : '한국어'; }

function momPrompt(m, lang) {
  return `아래는 다국어 회의의 전사본이다. 빠짐없이 꼼꼼하게 회의록(Minutes of Meeting)을 작성하라. 출력 언어: ${langName(lang)}.

형식 (markdown):
# 회의록: ${m.title}
- 일시 / 참석자(화자 기준)
## 논의 내용 (주제별로, 누가 어떤 입장을 냈는지 포함)
## 결정 사항
## Action Items (담당자·기한이 언급됐으면 명시)
## 미결·후속 논의 필요 사항

원문에 없는 내용을 지어내지 마라. 사소해 보여도 결정·숫자·날짜·금액은 반드시 포함하라.

--- 전사본 ---
${renderedTranscriptText(m)}`;
}

function personPrompt(name, sources, lang) {
  const body = sources.map(s => `=== 회의: ${s.title} (${s.date}) ===\n${s.text}`).join('\n\n');
  return `아래 회의 전사본(들)에서 "${name}"의 발언을 근거로 이 인물을 분석하라. 출력 언어: ${langName(lang)}.

형식 (markdown):
## ${name} 분석
### 커뮤니케이션 스타일 (직설/우회, 데이터형/직관형, 언어 사용 패턴)
### 우선순위와 관심사 (무엇을 반복해서 강조하는가)
### 의사결정 성향 (신중/신속, 리스크 태도)
### 협업·설득 팁 (이 사람과 일할 때 효과적인 접근)

반드시 전사본의 실제 발언을 인용해 근거를 대라. 추측이면 추측이라고 표시하라.

${body}`;
}

function feedbackPrompt(myName, m, lang) {
  return `아래 회의 전사본에서 "${myName}"이 나(사용자)다. 내 발언만 분석해 말하기 개선 피드백을 작성하라. 출력 언어: ${langName(lang)}.

형식 (markdown):
## 말하기 피드백
### 잘한 점
### 개선점 (필러·말버릇 사용 빈도, 문장 구조, 명확성, 언어 전환 습관 — 실제 발언을 인용해 지적)
### 다음 회의에서 시도할 것 (구체적 행동 2~3개)

혹독하지 않되 솔직하게. 인용 없는 지적은 하지 마라.

--- 전사본 ---
${renderedTranscriptText(m)}`;
}

/* ---------- 전사 파싱·렌더 ---------- */
const LINE_RE = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*\**\s*(Speaker\s*\d+)\s*\**\s*[:：]\s*(.*)$/;

function parseTranscript(raw) {
  const lines = [];
  for (const l of raw.split('\n')) {
    const t = l.trim();
    if (!t) continue;
    const m = t.match(LINE_RE);
    if (m) lines.push({ time: m[1], speaker: m[2].replace(/\s+/, ' '), text: m[3] });
    else if (lines.length) lines[lines.length - 1].text += ' ' + t; // 줄바꿈으로 이어진 발언
    else lines.push({ time: '', speaker: '', text: t });
  }
  return lines;
}

function speakerIds(m) {
  const set = new Set(parseTranscript(m.raw).map(l => l.speaker).filter(Boolean));
  return [...set].sort((a, b) => (parseInt(a.match(/\d+/)) || 0) - (parseInt(b.match(/\d+/)) || 0));
}

function displayName(m, sp) { return m.speakers?.[sp]?.name || sp; }
function mySpeaker(m) {
  return Object.keys(m.speakers || {}).find(k => m.speakers[k].me) || null;
}

// 이름 치환이 적용된 전사 텍스트 (분석·내보내기용)
function renderedTranscriptText(m) {
  return parseTranscript(m.raw)
    .map(l => l.speaker
      ? `[${l.time}] ${displayName(m, l.speaker)}: ${l.text}`
      : l.text)
    .join('\n');
}

/* ---------- UI 공통 ---------- */
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, ms);
}
function esc(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// 최소 markdown 렌더 (분석 결과용)
function mdToHtml(md) {
  const lines = esc(md).split('\n');
  let html = '', inUl = false, inOl = false;
  const closeLists = () => { if (inUl) { html += '</ul>'; inUl = false; } if (inOl) { html += '</ol>'; inOl = false; } };
  const inline = s => s
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const l of lines) {
    const t = l.trim();
    if (/^#{1,3}\s/.test(t)) { closeLists(); const lv = t.match(/^#+/)[0].length; html += `<h${lv}>${inline(t.replace(/^#+\s*/, ''))}</h${lv}>`; }
    else if (/^[-*]\s/.test(t)) { if (!inUl) { closeLists(); html += '<ul>'; inUl = true; } html += `<li>${inline(t.slice(2))}</li>`; }
    else if (/^\d+\.\s/.test(t)) { if (!inOl) { closeLists(); html += '<ol>'; inOl = true; } html += `<li>${inline(t.replace(/^\d+\.\s/, ''))}</li>`; }
    else if (/^>\s?/.test(t)) { closeLists(); html += `<blockquote>${inline(t.replace(/^>\s?/, ''))}</blockquote>`; }
    else if (t === '') closeLists();
    else { closeLists(); html += `<p>${inline(t)}</p>`; }
  }
  closeLists();
  return html;
}

const views = ['home', 'new', 'detail', 'settings'];
function show(view) {
  views.forEach(v => $(`view-${v}`).hidden = v !== view);
  window.scrollTo(0, 0);
}

/* ---------- 홈 ---------- */
async function renderHome() {
  const meetings = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt);
  const list = $('meetingList');
  list.innerHTML = '';
  $('emptyHome').hidden = meetings.length > 0;
  for (const m of meetings) {
    const btn = document.createElement('button');
    btn.className = 'meeting-item';
    const n = speakerIds(m).length;
    btn.innerHTML = `<strong>${esc(m.title)}</strong>
      <span class="meta">${new Date(m.createdAt).toLocaleDateString('ko-KR')} · 화자 ${n}명${m.analyses?.mom ? ' · 회의록 ✓' : ''}</span>`;
    btn.onclick = () => openDetail(m.id);
    list.appendChild(btn);
  }
  show('home');
}

/* ---------- 새 전사 ---------- */
let pickedFile = null;

function resetNew() {
  pickedFile = null;
  $('fileInput').value = '';
  $('fileLabel').innerHTML = '녹음 파일 선택<small>음성 메모 → 공유 → "파일에 저장" 한 파일</small>';
  $('titleInput').value = '';
  $('ctxInput').value = '';
  $('btnStart').disabled = true;
  $('progressBox').hidden = true;
  $('livePreview').textContent = '';
}

function setStage(label, pct) {
  $('progressBox').hidden = false;
  $('progressStage').textContent = label;
  $('progressFill').style.width = `${Math.round(pct * 100)}%`;
}

async function startTranscription() {
  if (!settings.apiKey) { toast('먼저 설정에서 Gemini API 키를 입력하세요'); show('settings'); return; }
  if (!pickedFile) return;
  const title = $('titleInput').value.trim() || pickedFile.name.replace(/\.[^.]+$/, '');
  const ctx = $('ctxInput').value.trim();
  $('btnStart').disabled = true;

  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  try {
    setStage('1/3 오디오 업로드 중…', 0);
    const { uri, mime } = await uploadAudio(pickedFile, p => setStage(`1/3 오디오 업로드 중… ${Math.round(p * 100)}%`, p * 0.4));
    setStage('2/3 Gemini가 파일 처리 중…', 0.45);

    setStage('3/3 전사 중… (실시간 미리보기)', 0.5);
    const preview = $('livePreview');
    const raw = await generateFull(
      [{ file_data: { file_uri: uri, mime_type: mime } }, { text: transcriptPrompt(ctx) }],
      t => {
        preview.textContent = t.length > 4000 ? '…' + t.slice(-4000) : t;
        preview.scrollTop = preview.scrollHeight;
        setStage(`3/3 전사 중… ${t.length.toLocaleString()}자`, Math.min(0.95, 0.5 + t.length / 120000));
      });
    if (!raw) throw new Error('전사 결과가 비어 있습니다. 다시 시도해 보세요.');

    const meeting = {
      id: crypto.randomUUID(),
      title, createdAt: Date.now(), fileName: pickedFile.name,
      context: ctx, raw, speakers: {}, analyses: {},
    };
    for (const sp of speakerIds(meeting)) meeting.speakers[sp] = { name: '', me: false };
    await DB.put(meeting);
    setStage('완료', 1);
    toast('전사 완료 — 화자 탭에서 이름을 붙여 보세요');
    openDetail(meeting.id);
  } catch (e) {
    setStage('오류: ' + e.message, 0);
    toast(e.message, 5000);
  } finally {
    $('btnStart').disabled = false;
    try { await wakeLock?.release(); } catch {}
  }
}

/* ---------- 상세 ---------- */
let current = null; // 현재 열린 meeting 객체
let analysisLang = settings.lang;

async function openDetail(id) {
  current = await DB.get(id);
  if (!current) return renderHome();
  analysisLang = settings.lang;
  $('detailTitle').value = current.title;
  $('detailDate').textContent = new Date(current.createdAt).toLocaleString('ko-KR') + ' · ' + (current.fileName || '');
  switchTab('transcript');
  renderTranscript();
  renderSpeakers();
  renderAnalysis();
  show('detail');
}

function switchTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['transcript', 'speakers', 'analysis', 'export'].forEach(t => $(`pane-${t}`).hidden = t !== tab);
}

function renderTranscript() {
  const pane = $('pane-transcript');
  const my = mySpeaker(current);
  const ids = speakerIds(current);
  pane.innerHTML = parseTranscript(current.raw).map(l => {
    if (!l.speaker) return `<p class="hint">${esc(l.text)}</p>`;
    const idx = ids.indexOf(l.speaker);
    const cls = `sc${(idx % 8) + 1}` + (l.speaker === my ? ' sp-me' : '');
    return `<div class="tline ${cls}">
      <span class="tstamp">${esc(l.time)}</span>
      <div class="tbody-wrap">
        <span class="tspeaker">${esc(displayName(current, l.speaker))}</span>
        <span class="ttext">${esc(l.text)}</span>
      </div>
    </div>`;
  }).join('');
}

function renderSpeakers() {
  const box = $('speakerList');
  box.innerHTML = '';
  for (const sp of speakerIds(current)) {
    const row = document.createElement('div');
    row.className = 'speaker-row';
    const info = current.speakers[sp] || { name: '', me: false };
    row.innerHTML = `<span class="speaker-tag">${esc(sp)}</span>
      <input type="text" placeholder="이름 (예: Müller)" value="${esc(info.name)}" data-sp="${esc(sp)}">
      <label class="me-toggle"><input type="radio" name="meRadio" data-sp="${esc(sp)}" ${info.me ? 'checked' : ''}> 나</label>`;
    box.appendChild(row);
  }
}

async function saveSpeakers() {
  const me = document.querySelector('#speakerList input[type=radio]:checked')?.dataset.sp || null;
  document.querySelectorAll('#speakerList input[type=text]').forEach(inp => {
    const sp = inp.dataset.sp;
    current.speakers[sp] = { name: inp.value.trim(), me: sp === me };
  });
  await DB.put(current);
  renderTranscript();
  renderAnalysis();
  toast('저장했습니다');
}

/* ---------- 분석 ---------- */
function renderAnalysis() {
  document.querySelectorAll('#langSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === analysisLang));
  // 인물 선택
  const sel = $('personSel');
  sel.innerHTML = speakerIds(current)
    .map(sp => `<option value="${esc(sp)}">${esc(displayName(current, sp))}</option>`).join('');
  // 누적 범위: 다른 회의 목록
  DB.all().then(all => {
    $('scopeList').innerHTML = all
      .filter(m => m.id !== current.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(m => `<label class="check"><input type="checkbox" data-mid="${m.id}"> ${esc(m.title)} <small>(${new Date(m.createdAt).toLocaleDateString('ko-KR')})</small></label>`)
      .join('') || '<p class="hint">다른 회의가 없습니다.</p>';
  });
  const my = mySpeaker(current);
  $('feedbackHint').hidden = !!my;
  $('btnFeedback').disabled = !my;
  $('momOut').innerHTML = current.analyses.mom ? mdToHtml(current.analyses.mom.text) : '';
  $('personOut').innerHTML = current.analyses.person ? mdToHtml(current.analyses.person.text) : '';
  $('feedbackOut').innerHTML = current.analyses.feedback ? mdToHtml(current.analyses.feedback.text) : '';
}

async function runAnalysis(kind, btn) {
  if (!settings.apiKey) { toast('설정에서 API 키를 입력하세요'); return; }
  const outEl = $({ mom: 'momOut', person: 'personOut', feedback: 'feedbackOut' }[kind]);
  btn.disabled = true;
  const oldLabel = btn.textContent;
  btn.textContent = '생성 중…';
  try {
    let prompt;
    if (kind === 'mom') prompt = momPrompt(current, analysisLang);
    else if (kind === 'person') {
      const sp = $('personSel').value;
      const name = displayName(current, sp);
      const sources = [{ title: current.title, date: new Date(current.createdAt).toLocaleDateString('ko-KR'), text: renderedTranscriptText(current) }];
      for (const cb of document.querySelectorAll('#scopeList input:checked')) {
        const m = await DB.get(cb.dataset.mid);
        if (m) sources.push({ title: m.title, date: new Date(m.createdAt).toLocaleDateString('ko-KR'), text: renderedTranscriptText(m) });
      }
      prompt = personPrompt(name, sources, analysisLang);
    } else {
      const my = mySpeaker(current);
      prompt = feedbackPrompt(displayName(current, my), current, analysisLang);
    }
    const text = await generateFull([{ text: prompt }], t => { outEl.innerHTML = mdToHtml(t); });
    current.analyses[kind] = { text, lang: analysisLang, at: Date.now() };
    await DB.put(current);
    outEl.innerHTML = mdToHtml(text);
    toast('완료');
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = oldLabel;
  }
}

/* ---------- 내보내기 ---------- */
function buildExport() {
  const parts = [`# ${current.title}\n${new Date(current.createdAt).toLocaleString('ko-KR')}`];
  if ($('expTranscript').checked) parts.push(`## 전사 (원문)\n\n${renderedTranscriptText(current)}`);
  if ($('expMom').checked && current.analyses.mom) parts.push(current.analyses.mom.text);
  if ($('expPerson').checked && current.analyses.person) parts.push(current.analyses.person.text);
  if ($('expFeedback').checked && current.analyses.feedback) parts.push(current.analyses.feedback.text);
  return parts.join('\n\n---\n\n');
}
function exportFileName() {
  const d = new Date(current.createdAt);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd} ${current.title}`.replace(/[\\/:*?"<>|]/g, '_');
}

async function shareExport() {
  const text = buildExport();
  const file = new File([text], exportFileName() + '.txt', { type: 'text/plain' });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: current.title });
    else if (navigator.share) await navigator.share({ title: current.title, text });
    else throw new Error('no-share');
  } catch (e) {
    if (e.name === 'AbortError') return;
    await copyExport(); // 공유 미지원 → 클립보드로 폴백
  }
}
async function copyExport() {
  await navigator.clipboard.writeText(buildExport());
  toast('클립보드에 복사했습니다');
}
function downloadExport() {
  const blob = new Blob([buildExport()], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFileName() + '.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------- 설정 화면 ---------- */
function renderSettings() {
  $('apiKeyInput').value = settings.apiKey;
  fillModelSelect([settings.model]);
  document.querySelectorAll('#defLangSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  show('settings');
}
function fillModelSelect(models) {
  const sel = $('modelSel');
  const set = new Set([settings.model, ...models]);
  sel.innerHTML = [...set].map(m => `<option ${m === settings.model ? 'selected' : ''}>${esc(m)}</option>`).join('');
}

/* ---------- 이벤트 바인딩 ---------- */
function bind() {
  $('btnHome').onclick = renderHome;
  $('btnSettings').onclick = renderSettings;
  $('btnNew').onclick = () => { resetNew(); show('new'); };

  $('fileInput').onchange = e => {
    pickedFile = e.target.files[0] || null;
    if (pickedFile) {
      $('fileLabel').innerHTML = `${esc(pickedFile.name)}<small>${(pickedFile.size / 1048576).toFixed(1)} MB</small>`;
      if (!$('titleInput').value) $('titleInput').value = pickedFile.name.replace(/\.[^.]+$/, '');
      $('btnStart').disabled = false;
    }
  };
  $('btnStart').onclick = startTranscription;

  $('detailTitle').onchange = async () => {
    current.title = $('detailTitle').value.trim() || current.title;
    await DB.put(current);
  };
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('btnSaveSpeakers').onclick = saveSpeakers;

  $('langSeg').onclick = e => {
    if (e.target.dataset.lang) { analysisLang = e.target.dataset.lang; renderAnalysis(); }
  };
  $('btnMom').onclick = e => runAnalysis('mom', e.target);
  $('btnPerson').onclick = e => runAnalysis('person', e.target);
  $('btnFeedback').onclick = e => runAnalysis('feedback', e.target);

  $('btnShare').onclick = shareExport;
  $('btnCopy').onclick = copyExport;
  $('btnDownload').onclick = downloadExport;
  $('btnDelete').onclick = async () => {
    if (!confirm(`"${current.title}" 회의를 삭제할까요? 되돌릴 수 없습니다.`)) return;
    await DB.del(current.id);
    toast('삭제했습니다');
    renderHome();
  };

  $('btnShowKey').onclick = () => {
    const i = $('apiKeyInput');
    i.type = i.type === 'password' ? 'text' : 'password';
  };
  $('btnLoadModels').onclick = async e => {
    settings.apiKey = $('apiKeyInput').value.trim();
    if (!settings.apiKey) { toast('API 키를 먼저 입력하세요'); return; }
    e.target.disabled = true;
    try { fillModelSelect(await fetchModels()); toast('모델 목록을 불러왔습니다'); }
    catch (err) { toast(err.message, 5000); }
    finally { e.target.disabled = false; }
  };
  $('defLangSeg').onclick = e => {
    if (!e.target.dataset.lang) return;
    settings.lang = e.target.dataset.lang;
    document.querySelectorAll('#defLangSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  };
  $('btnSaveSettings').onclick = () => {
    settings.apiKey = $('apiKeyInput').value.trim();
    settings.model = $('modelSel').value || settings.model;
    Settings.save(settings);
    toast('설정을 저장했습니다');
    renderHome();
  };
}

/* ---------- 시작 ---------- */
(async function init() {
  await DB.open();
  bind();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!settings.apiKey) renderSettings();
  else renderHome();
})();
