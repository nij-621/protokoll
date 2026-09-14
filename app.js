/* MeetMemo — 다국어 회의 전사. 오디오는 전사 시에만 Gemini API로 전송(끝나면 즉시 삭제), 결과는 이 기기 IndexedDB에만 저장 */
'use strict';

const API = 'https://generativelanguage.googleapis.com';
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LOCALE = 'en-GB';
const STREAM_IDLE_MS = 3 * 60 * 1000;   // 스트림 무응답 3분이면 중단
const BLOCK_RETRIES = 2;                // 필터 차단(blockReason)은 오탐이 잦아 자동 재시도
// 안전 필터 최대 완화 — 회의 녹음이 SAFETY/OTHER 오탐으로 차단되는 것 방지 (OTHER는 보장 없음)
const SAFETY_OFF = ['HARASSMENT', 'HATE_SPEECH', 'SEXUALLY_EXPLICIT', 'DANGEROUS_CONTENT']
  .map(c => ({ category: 'HARM_CATEGORY_' + c, threshold: 'BLOCK_NONE' }));
const FALLBACK_MODEL = 'gemini-3.6-flash';
const RETIRED_MODELS = ['gemini-2.5-flash'];   // Google이 은퇴시킨 모델 — 저장된 설정을 새 모델로 이관

/* ---------- 설정 ----------
   apiKey는 rememberKey일 때만 localStorage, 아니면 sessionStorage(앱 닫으면 사라짐) */
const SKEY = 'protokoll-settings', KKEY = 'protokoll-apikey';
const Settings = {
  load() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SKEY)) || {}; } catch {}
    s.apiKey = (s.rememberKey !== false ? localStorage.getItem(KKEY) : null) || sessionStorage.getItem(KKEY) || '';
    return s;
  },
  save(s) {
    const { apiKey, ...rest } = s;
    localStorage.setItem(SKEY, JSON.stringify(rest));
    if (s.rememberKey) { localStorage.setItem(KKEY, apiKey); sessionStorage.removeItem(KKEY); }
    else { sessionStorage.setItem(KKEY, apiKey); localStorage.removeItem(KKEY); }
  },
  forgetKey() { localStorage.removeItem(KKEY); sessionStorage.removeItem(KKEY); },
};
let settings = Object.assign({ apiKey: '', model: FALLBACK_MODEL, lang: 'en', rememberKey: true, modelPicked: false }, Settings.load());
// 옛 버전이 settings 안에 apiKey를 저장했다면 새 위치로 이관
try { const old = JSON.parse(localStorage.getItem(SKEY) || '{}'); if (old.apiKey) { settings.apiKey = settings.apiKey || old.apiKey; Settings.save(settings); } } catch {}
if (RETIRED_MODELS.includes(settings.model)) { settings.model = FALLBACK_MODEL; Settings.save(settings); }

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
const authHeaders = extra => ({ 'x-goog-api-key': settings.apiKey, ...extra });

async function apiError(r) {
  let msg = `HTTP ${r.status}`;
  try { msg = (await r.json()).error?.message || msg; } catch {}
  if ((r.status === 400 || r.status === 403) && /API key/i.test(msg)) msg = 'Invalid API key. Check it in Settings.';
  if (r.status === 429) msg = 'API rate limit reached. Try again in a moment.';
  return new Error(msg);
}

// 브라우저가 알려준 MIME을 우선, m4a는 두 후보를 순서대로 시도
function mimeCandidates(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const byExt = { m4a: ['audio/mp4', 'audio/m4a'], mp4: ['audio/mp4'], mp3: ['audio/mpeg', 'audio/mp3'], wav: ['audio/wav'],
                  aac: ['audio/aac'], ogg: ['audio/ogg'], flac: ['audio/flac'], caf: ['audio/x-caf'] }[ext] || [];
  const list = [];
  if (file.type && file.type !== 'audio/x-m4a') list.push(file.type);
  for (const m of byExt) if (!list.includes(m)) list.push(m);
  if (!list.length) list.push('audio/mp4');
  return list;
}

async function uploadAudio(file, mime, onProgress, signal) {
  const start = await fetch(`${API}/upload/v1beta/files`, {
    method: 'POST', signal,
    headers: authHeaders({
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    }),
    body: JSON.stringify({ file: { display_name: file.name } }),
  });
  if (!start.ok) throw await apiError(start);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Did not receive an upload URL.');

  // XHR: 업로드 진행률 + 취소 지원
  const uploaded = await new Promise((res, rej) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.setRequestHeader('X-Goog-Upload-Command', 'upload, finalize');
    xhr.setRequestHeader('X-Goog-Upload-Offset', '0');
    xhr.upload.onprogress = e => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => xhr.status < 300 ? res(JSON.parse(xhr.responseText)) : rej(new Error(`Upload failed (HTTP ${xhr.status})`));
    xhr.onerror = () => rej(new Error('Network error during upload'));
    xhr.onabort = () => rej(new DOMException('Cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });

  let f = uploaded.file;
  while (f.state === 'PROCESSING') {
    await sleep(3000);
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const r = await fetch(`${API}/v1beta/${f.name}`, { headers: authHeaders(), signal });
    if (!r.ok) throw await apiError(r);
    f = await r.json();
  }
  if (f.state !== 'ACTIVE') throw new Error('Gemini could not process the file: ' + f.state);
  return { uri: f.uri, name: f.name };
}

async function deleteRemoteFile(name) {
  if (!name) return;
  try { await fetch(`${API}/v1beta/${name}`, { method: 'DELETE', headers: authHeaders() }); } catch {}
}

async function streamGenerate(parts, priorTurns, onText, signal) {
  const body = {
    contents: [...priorTurns, { role: 'user', parts }],
    generationConfig: { maxOutputTokens: 65536 },
    safetySettings: SAFETY_OFF,
  };
  const r = await fetch(`${API}/v1beta/models/${settings.model}:streamGenerateContent?alt=sse`, {
    method: 'POST', signal, headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(body),
  });
  if (!r.ok) throw await apiError(r);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', finish = '';
  // 무응답 타임아웃: 청크가 STREAM_IDLE_MS 동안 안 오면 중단
  let idle;
  const armIdle = () => { clearTimeout(idle); idle = setTimeout(() => reader.cancel('idle'), STREAM_IDLE_MS); };
  armIdle();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
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
        if (o.promptFeedback?.blockReason) {
          const e = new Error('Request was blocked: ' + o.promptFeedback.blockReason);
          e.blocked = true;
          throw e;
        }
      }
    }
  } finally { clearTimeout(idle); }
  if (/SAFETY|RECITATION|PROHIBITED_CONTENT|BLOCKLIST|OTHER/.test(finish)) {
    const e = new Error('Response was blocked: ' + finish);
    e.blocked = true;
    throw e;
  }
  if (!finish && !text) throw new Error('No response from Gemini for 3 minutes — stopped. Try again.');
  return { text, finish };
}

// MAX_TOKENS로 잘리면 이어쓰기 요청을 반복해 전체를 받는다
async function generateFull(parts, onText, signal) {
  let turns = [], all = '';
  for (let round = 0; round < 8; round++) {
    const userParts = round === 0 ? parts
      : [{ text: 'Your output was cut off. Continue exactly from where it stopped. Do not repeat anything already written.' }];
    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await streamGenerate(userParts, turns, t => onText && onText(all + t), signal);
        break;
      } catch (e) {
        if (!e.blocked || attempt >= BLOCK_RETRIES || signal?.aborted) throw e;
        await sleep(2000 * (attempt + 1));   // 차단은 오탐이 잦다 — 잠시 후 같은 요청 재시도
      }
    }
    const { text, finish } = result;
    turns = [...turns, { role: 'user', parts: userParts }, { role: 'model', parts: [{ text }] }];
    all += text;
    if (finish !== 'MAX_TOKENS') break;
  }
  return all.trim();
}

async function fetchModels() {
  const r = await fetch(`${API}/v1beta/models?pageSize=200`, { headers: authHeaders() });
  if (!r.ok) throw await apiError(r);
  const data = await r.json();
  return (data.models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => n.startsWith('gemini') && !/embedding|image|tts|live|audio-dialog|robotics|computer-use/.test(n))
    .sort();
}

// 목록에서 가장 최신 정식 Flash 모델을 고른다 (gemini-X.Y-flash 형태, preview/lite/exp 제외)
function pickDefaultModel(models) {
  const stable = models
    .map(n => ({ n, m: n.match(/^gemini-(\d+)(?:\.(\d+))?-flash$/) }))
    .filter(x => x.m)
    .sort((a, b) => (+b.m[1] - +a.m[1]) || ((+b.m[2] || 0) - (+a.m[2] || 0)));
  return stable[0]?.n || models.find(n => /flash/.test(n)) || settings.model;
}

/* ---------- Prompts ---------- */
function transcriptPrompt(ctx) {
  return `You are a professional meeting stenographer. This audio is a meeting recording that may mix English, German, Korean, Chinese and Japanese.

Rules:
1. Transcribe every utterance verbatim in the language it was actually spoken. Never translate or summarise.
2. Distinguish speakers by voice and label them "Speaker 1", "Speaker 2", ... Keep the same number for the same voice throughout the whole recording.
3. Prefix each utterance with its start timestamp in [HH:MM:SS] format.
4. Keep fillers and verbal tics exactly as heard ("um", "uh", "äh", "also", "like", "음", "어", "あの"). Do not clean up sentences.
5. Mark unintelligible passages as [unclear].
6. Output format — one utterance per line, transcript only, no other text:
[HH:MM:SS] Speaker 1: utterance
${ctx ? `\nMeeting context (for proper nouns): ${ctx}` : ''}`;
}

function langName(l) { return l === 'ko' ? 'Korean (한국어)' : 'English'; }

function isoDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

/* Canonical minutes format — must match minutes-archive/TEMPLATE.md (the archive app parses this) */
function momPrompt(m, lang) {
  return `Below is the transcript of a meeting that may mix English, German, Korean, Chinese and Japanese.
Write complete Minutes of Meeting in EXACTLY the format below. Section headings and field labels must stay in English verbatim; write the content in ${langName(lang)}.

# Minutes: ${m.title}
Date: ${isoDate(m.createdAt)}
Attendees: comma-separated names as they appear in the transcript
Tags: 2–5 short topic tags (project, customer, meeting series, subject), comma-separated

## Summary
Line 1: ONE sentence (max 20 words) with the bottom line of the meeting — what was decided or what changes. Then 2–4 bullets with the main outcomes. No paragraphs.

## Discussion
One bullet per topic: "- **Topic (max 4 words)** — position or outcome in at most 2 sentences". Put details, numbers and who took which position in indented sub-bullets under the topic. Keep all numbers, dates, amounts, names. Every decision and action item below must have its context here; items that were decided with little discussion go under a final "- **Other** —" bullet, one sub-bullet each.

## Decisions
One bullet per decision, most important first, prefixed with the person(s) who made or own it in square brackets: "- [Name] decision". Use "[All]" if the group decided jointly. Omit the bracket only if no one can be attributed.

## Action Items
One bullet per action: "- [Owner] task (due YYYY-MM-DD)". Convert relative deadlines ("next week", "end of October", "on the 6th") to a date counted from the Date line above. Omit "(due …)" only if no deadline was stated at all.

## Open Issues
Unresolved points and follow-ups needed, one bullet each.

Rules: do not invent anything not in the transcript. If a section has nothing, write "- none". Output only the minutes, no preamble.

--- Transcript ---
${renderedTranscriptText(m)}`;
}

function personPrompt(name, sources, lang) {
  const body = sources.map(s => `=== Meeting: ${s.title} (${s.date}) ===\n${s.text}`).join('\n\n');
  return `Based on what "${name}" says in the meeting transcript(s) below, profile this person. Output language: ${langName(lang)}.

Format (markdown):
## Profile: ${name}
### Communication style (direct/indirect, data-driven/intuitive, language-use patterns)
### Priorities and concerns (what they repeatedly emphasise)
### Decision-making tendencies (deliberate/fast, attitude to risk)
### How to work with and persuade this person

Ground every claim in actual quotes from the transcript. If something is a guess, say so.

${body}`;
}

function feedbackPrompt(myName, m, lang) {
  return `In the meeting transcript below, "${myName}" is me (the user). Analyse only my utterances and give feedback to improve my speaking. Output language: ${langName(lang)}.

Format (markdown):
## Speaking feedback
### What went well
### What to improve (filler and tic frequency, sentence structure, clarity, language-switching habits — quote actual utterances; diagnose only, do NOT rewrite here)
### To try in the next meeting (2–3 concrete actions)
### Say it now
Pick my 2–3 weakest utterances and rewrite each so I can read it aloud right now. Keep the rewrite in the SAME language I originally spoke it in (not necessarily the output language). Format each as:
- [HH:MM:SS] *original utterance, shortened if long*
> improved sentence

Honest but not harsh. No criticism without a quote.

--- Transcript ---
${renderedTranscriptText(m)}`;
}

/* ---------- 전사 파싱·렌더 ---------- */
const LINE_RE = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*\**\s*(Speaker\s*\d+)\s*\**\s*[:：]\s*(.*)$/;

function parseTranscript(raw) {
  const lines = [];
  raw.split('\n').forEach((l, rawIdx) => {
    const t = l.trim();
    if (!t) return;
    const m = t.match(LINE_RE);
    if (m) lines.push({ time: m[1], speaker: m[2].replace(/\s+/, ' '), text: m[3], rawIdx });
    else if (lines.length) lines[lines.length - 1].text += ' ' + t; // 줄바꿈으로 이어진 발언
    else lines.push({ time: '', speaker: '', text: t, rawIdx });
  });
  return lines;
}

// 화자 수동 교정: raw의 해당 줄에서 화자 토큰만 바꾼다
async function reassignSpeaker(rawIdx, newSp) {
  const rows = current.raw.split('\n');
  rows[rawIdx] = rows[rawIdx].replace(/Speaker\s*\d+/, newSp);
  current.raw = rows.join('\n');
  if (!current.speakers[newSp]) current.speakers[newSp] = { name: '', me: false };
  await DB.put(current);
  renderDetailHead();
  renderTranscript();
  renderSpeakers();
}

function speakerIds(m) {
  const set = new Set(parseTranscript(m.raw).map(l => l.speaker).filter(Boolean));
  return [...set].sort((a, b) => (parseInt(a.match(/\d+/)) || 0) - (parseInt(b.match(/\d+/)) || 0));
}

function displayName(m, sp) { return m.speakers?.[sp]?.name || sp; }
function mySpeaker(m) {
  return Object.keys(m.speakers || {}).find(k => m.speakers[k].me) || null;
}

/* 회의 통계 — 길이(마지막 타임스탬프)와 화자별 발언 비중(글자수). 추가 API 호출 없이 전사본에서 계산 */
function parseTime(t) {
  if (!t) return 0;
  const p = t.split(':').map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] || 0);
}
function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}
function meetingStats(m) {
  const lines = parseTranscript(m.raw || '');
  const ids = speakerIds(m);
  const chars = Object.fromEntries(ids.map(s => [s, 0]));
  let last = 0;
  for (const l of lines) {
    if (l.speaker) chars[l.speaker] += l.text.length;
    last = Math.max(last, parseTime(l.time));
  }
  return { ids, chars, duration: last, my: mySpeaker(m) };
}
// 화자 → 색 클래스. "나"는 잉크색
function speakerClass(ids, sp, my) { return sp === my ? 'gme' : `g${(ids.indexOf(sp) % 8) + 1}`; }
// 대화 지문: 화자별 비중 막대
function fpHtml(st) {
  const total = Object.values(st.chars).reduce((a, b) => a + b, 0);
  if (!total) return '';
  return st.ids.filter(s => st.chars[s] > 0)
    .map(s => `<i class="${speakerClass(st.ids, s, st.my)}" style="flex:${(st.chars[s] / total * 100).toFixed(1)}"></i>`)
    .join('');
}
const fmtDay = ts => new Date(ts).toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
const fmtMonth = ts => new Date(ts).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
const ICON_CHECK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

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
  clearTimeout(t._timer); clearTimeout(t._hide);
  t.classList.remove('leaving');
  t.textContent = msg; t.hidden = false;
  t._timer = setTimeout(() => {
    t.classList.add('leaving');
    t._hide = setTimeout(() => { t.hidden = true; t.classList.remove('leaving'); }, 160);
  }, ms);
}

// 버튼 라벨을 블러 크로스페이드로 교체
function swapLabel(btn, text) {
  btn.classList.add('swapping');
  setTimeout(() => { btn.textContent = text; btn.classList.remove('swapping'); }, 120);
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
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

function fmtDate(ts) { return new Date(ts).toLocaleDateString(LOCALE); }

const views = ['home', 'new', 'live', 'detail', 'settings'];
function show(view) {
  views.forEach(v => $(`view-${v}`).hidden = v !== view);
  $('btnBack').hidden = view === 'home';
  window.scrollTo(0, 0);
}

/* ---------- 홈 ---------- */
async function renderHome() {
  const meetings = (await DB.all()).sort((a, b) => b.createdAt - a.createdAt);
  const list = $('meetingList');
  list.innerHTML = '';
  $('emptyHome').hidden = meetings.length > 0;
  let month = '';
  meetings.forEach((m, i) => {
    const mo = fmtMonth(m.createdAt);
    if (mo !== month) {
      month = mo;
      const h = document.createElement('div');
      h.className = 'month'; h.textContent = mo;
      list.appendChild(h);
    }
    const st = meetingStats(m);
    const n = st.ids.length;
    const btn = document.createElement('button');
    btn.className = 'meeting-item';
    btn.style.setProperty('--i', Math.min(i, 8)); // 스태거는 앞 8개까지만
    const meta = [fmtDay(m.createdAt), `${n} speaker${n === 1 ? '' : 's'}`, fmtDuration(st.duration)].filter(Boolean).map(esc);
    if (m.analyses?.mom) meta.push(`<span class="ok">${ICON_CHECK}Minutes</span>`);
    btn.innerHTML = `<strong>${esc(m.title)}</strong>
      <span class="meta">${meta.join('<i class="dot"></i>')}</span>
      <div class="fp" aria-hidden="true">${fpHtml(st)}</div>`;
    btn.onclick = () => openDetail(m.id);
    list.appendChild(btn);
  });
  show('home');
}

/* ---------- 새 전사 ---------- */
let pickedFile = null;
let job = null; // { controller, remoteName } — 진행 중인 전사 (중복 실행 방지·취소용)

function resetNew() {
  pickedFile = null;
  $('fileInput').value = '';
  showFileCard(null);
  $('titleInput').value = '';
  $('ctxInput').value = '';
  $('btnStart').disabled = true;
  $('btnStart').hidden = false;
  $('btnCancel').hidden = true;
  $('progressBox').hidden = true;
  $('livePreview').innerHTML = '';
  $('livePreview').hidden = true;
}

// 파일을 고르면 드롭존 → 파일 카드(이름·크기·길이). 길이는 Audio 메타데이터에서
function showFileCard(file) {
  $('fileDrop').hidden = !!file;
  $('fileCard').hidden = !file;
  if (!file) return;
  $('fileName').textContent = file.name;
  const mb = `${(file.size / 1048576).toFixed(1)} MB`;
  $('fileMeta').textContent = mb;
  try {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (isFinite(a.duration) && pickedFile === file) {
        const s = Math.round(a.duration);
        const hh = Math.floor(s / 3600), mm = Math.floor(s % 3600 / 60), ss = s % 60;
        $('fileMeta').textContent = `${mb} · ${hh ? hh + ':' : ''}${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      }
      URL.revokeObjectURL(url);
    };
    a.onerror = () => URL.revokeObjectURL(url);
    a.src = url;
  } catch {}
}

// 진행 표시: step 1~3(업로드·전사·저장) + 우측 상태 문구 + 막대. step 0 = 실패/취소
function setStage(step, label, pct) {
  $('progressBox').hidden = false;
  document.querySelectorAll('#steps .step').forEach(el => {
    const n = +el.dataset.step;
    if (step === 0) { el.classList.toggle('fail', el.classList.contains('now')); return; } // 실패·취소: 진행 중이던 단계만 표시
    el.classList.remove('fail');
    el.classList.toggle('done', step > n);
    el.classList.toggle('now', step === n);
  });
  $('progressStage').textContent = label;
  $('progressFill').style.transform = `scaleX(${pct})`;
}
const fmtElapsed = ms => { const s = Math.round(ms / 1000); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`; };

async function startTranscription() {
  if (job) return; // 이미 실행 중
  if (!settings.apiKey) { toast('Enter your Gemini API key in Settings first'); show('settings'); return; }
  if (!pickedFile) return;
  const file = pickedFile;
  const title = $('titleInput').value.trim() || file.name.replace(/\.[^.]+$/, '');
  const ctx = $('ctxInput').value.trim();
  $('btnStart').disabled = true;
  $('btnStart').hidden = true;       // 진행 중엔 같은 자리에 액션 하나만(Cancel)
  $('btnCancel').hidden = false;
  job = { controller: new AbortController(), remoteName: null, startedAt: Date.now() };
  const { signal } = job.controller;

  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  const preview = $('livePreview');
  const hint = $('progressHint');
  const baseHint = 'Keep the screen on and stay in the app while transcribing.';
  hint.textContent = baseHint;
  const tick = setInterval(() => { if (job) hint.textContent = `${baseHint} Running for ${fmtElapsed(Date.now() - job.startedAt)}.`; }, 1000);
  try {
    const mimes = mimeCandidates(file);
    let raw = '';
    for (let i = 0; i < mimes.length; i++) {
      const mime = mimes[i];
      setStage(1, 'Uploading… 0%', 0);
      const up = await uploadAudio(file, mime, p => setStage(1, `Uploading… ${Math.round(p * 100)}%`, p * 0.4), signal);
      job.remoteName = up.name;
      setStage(2, 'Gemini is reading the file…', 0.45);
      try {
        raw = await generateFull(
          [{ file_data: { file_uri: up.uri, mime_type: mime } }, { text: transcriptPrompt(ctx) }],
          t => {
            // 라이브 미리보기: 완성본과 같은 렌더러. 마지막 4000자만, 줄 단위로
            const tail = t.length > 4000 ? t.slice(t.indexOf('\n', t.length - 4000) + 1) : t;
            preview.hidden = false;
            preview.innerHTML = transcriptHtml(tail, { speakers: {} }, false);
            preview.scrollTop = preview.scrollHeight;
            setStage(2, `${t.length.toLocaleString()} chars`, Math.min(0.95, 0.5 + t.length / 120000));
          }, signal);
        break;
      } catch (e) {
        // MIME 문제로 보이면 다음 후보로 재시도 (업로드부터 다시)
        const mimeIssue = /mime|unsupported|not supported|invalid argument/i.test(e.message);
        await deleteRemoteFile(job.remoteName); job.remoteName = null;
        if (mimeIssue && i < mimes.length - 1) { preview.innerHTML = ''; preview.hidden = true; continue; }
        throw e;
      }
    }
    if (!raw) throw new Error('The transcript came back empty. Please try again.');

    setStage(3, 'Saving…', 0.97);
    const meeting = {
      id: crypto.randomUUID(),
      title, createdAt: Date.now(), fileName: file.name,
      context: ctx, raw, speakers: {}, analyses: {},
    };
    for (const sp of speakerIds(meeting)) meeting.speakers[sp] = { name: '', me: false };
    await DB.put(meeting);
    setStage(4, 'Done', 1);
    toast('Transcription complete — name the speakers in the Speakers tab');
    openDetail(meeting.id);
  } catch (e) {
    if (e.name === 'AbortError') { setStage(0, 'Cancelled', 0); toast('Transcription cancelled'); }
    else { setStage(0, 'Error: ' + e.message, 0); toast(e.message, 5000); }
  } finally {
    clearInterval(tick);
    hint.textContent = baseHint + ' A one-hour recording takes a few minutes.';
    await deleteRemoteFile(job?.remoteName); // 성공·실패·취소 모두 원격 오디오 즉시 삭제
    job = null;
    $('btnStart').disabled = false;
    $('btnStart').hidden = false;
    $('btnCancel').hidden = true;
    try { await wakeLock?.release(); } catch {}
  }
}

function cancelTranscription() {
  job?.controller.abort();
}

/* ---------- 라이브 번역 ----------
   이원 구조: 전체 세션을 통째로 녹음(정식 전사용)하면서, 복제 스트림을 10초 청크로 잘라
   청크마다 독립적으로 전사+한국어 번역(문맥 없음 — 검증 2026-08-23 통과 조건과 동일).
   자막은 소모품, 정식 회의록은 세션 종료 후 녹음본으로 기존 파이프라인을 돌린다 */
const LIVE_CHUNK_MS = 10000;
const LIVE_PROMPT = `You receive a ~10 second audio chunk cut from the middle of a live business meeting. The speech may be German, English, Chinese, Japanese or Korean, possibly code-mixed, and may be cut off mid-sentence at either end.

1. Transcribe the speech verbatim in its original language. Keep cut-off fragments as-is.
2. Translate the transcription into natural Korean.

Reply in EXACTLY this format, nothing else:
ORIG: <transcription>
KO: <Korean translation>

If the chunk contains no intelligible speech, reply exactly: NOSPEECH`;

let live = null; // { stream, chunkStream, mime, fullRec, chunkRec, fullChunks, fullBlob, idx, startedAt, timer, tick, wakeLock, stopping, ended }

// 라이브 세션 중(종료 후 처리 대기 포함)엔 화면 이동 차단 — 녹음·자막이 조용히 유실되는 것 방지
function liveGuard() {
  if (!live) return false;
  toast(live.ended ? 'Finish the live session first — transcribe or discard' : 'Live session running — end it first');
  return true;
}

function resetLiveView() {
  $('liveTitleInput').value = '';
  $('liveTitleField').hidden = false;
  $('liveStatus').hidden = true;
  $('liveStream').innerHTML = '';
  $('liveHint').textContent = 'Subtitles appear a few seconds after each sentence — original on top, Korean below. The whole session is also recorded, so you can run a full transcription afterwards. Keep the screen on and stay in the app.';
  $('btnLiveStart').hidden = false;
  $('btnLiveStop').hidden = true;
  $('liveEndRow').hidden = true;
}

const fmtClock = sec => {
  const s = Math.max(0, Math.round(sec)), h = Math.floor(s / 3600);
  return `${h ? h + ':' : ''}${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

async function startLive() {
  if (live) return;
  if (!settings.apiKey) { toast('Enter your Gemini API key in Settings first'); show('settings'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('Microphone access was denied. Allow it in iOS Settings → MeetMemo.', 5000); return; }
  const mime = MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  live = { stream, chunkStream: null, mime, fullRec: null, chunkRec: null, fullChunks: [], fullBlob: null,
           idx: 0, startedAt: Date.now(), timer: null, tick: null, wakeLock: null, stopping: false, ended: false };
  try { live.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}

  live.fullRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  live.fullRec.ondataavailable = e => { if (e.data.size) live.fullChunks.push(e.data); };
  live.fullRec.start(60000); // 1분마다 조각 수집(연속 녹음 하나로 이어붙일 수 있음)

  // 자막용 청크는 복제 스트림에서 — 같은 스트림에 recorder 2개 붙이는 것보다 사파리에서 안전
  live.chunkStream = stream.clone();
  liveCycle();

  $('liveTitleField').hidden = true;
  $('liveStatus').hidden = false;
  $('btnLiveStart').hidden = true;
  $('btnLiveStop').hidden = false;
  $('liveHint').textContent = 'Korean subtitles land a few seconds behind — glance, don’t wait. End the session to run a full transcription.';
  live.tick = setInterval(() => { if (live) $('liveElapsed').textContent = fmtClock((Date.now() - live.startedAt) / 1000); }, 1000);
}

// 10초마다 청크 recorder를 새로 시작 — stop이 만든 blob은 헤더가 붙은 독립 파일이라 그대로 API로 보낼 수 있다
function liveCycle() {
  if (!live || live.stopping) return;
  const rec = new MediaRecorder(live.chunkStream, live.mime ? { mimeType: live.mime } : undefined);
  const i = live.idx++;
  const t0 = (Date.now() - live.startedAt) / 1000;
  rec.ondataavailable = e => { if (e.data.size > 1500) processLiveChunk(i, t0, e.data); };
  rec.start();
  live.chunkRec = rec;
  live.timer = setTimeout(() => { try { rec.stop(); } catch {} liveCycle(); }, LIVE_CHUNK_MS);
}

async function liveGenerate(b64, mime) {
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: LIVE_PROMPT }] }],
    generationConfig: { temperature: 0.2 },
    safetySettings: SAFETY_OFF,
  });
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 60000);
    try {
      const r = await fetch(`${API}/v1beta/models/${settings.model}:generateContent`, {
        method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }), body, signal: ctl.signal,
      });
      if (!r.ok) throw await apiError(r);
      const o = await r.json();
      const text = (o.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (!text) throw new Error('Empty response');
      return text;
    } catch (e) {
      if (attempt >= 1) throw e;
      await sleep(1200);
    } finally { clearTimeout(to); }
  }
}

function parseLive(text) {
  if (/^NOSPEECH/i.test(text)) return null;
  const m = text.match(/ORIG:\s*([\s\S]*?)\s*\nKO:\s*([\s\S]*)/);
  return m ? { orig: m[1].trim(), ko: m[2].trim() } : { orig: '', ko: text };
}

async function processLiveChunk(i, t0, blob) {
  const box = $('liveStream');
  const el = document.createElement('div');
  el.className = 'lv pending';
  el.style.order = i; // 응답이 순서 없이 와도 자막은 시간순
  el.innerHTML = `<span class="tstamp">${fmtClock(t0)}</span><div class="tx"><p class="lv-orig">…</p><p class="lv-ko"></p></div>`;
  const nearBottom = () => window.innerHeight + window.scrollY > document.body.scrollHeight - 160;
  const follow = nearBottom();
  box.appendChild(el);
  if (follow) window.scrollTo(0, document.body.scrollHeight);
  try {
    const b64 = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
    const parsed = parseLive(await liveGenerate(b64, blob.type || live?.mime || 'audio/mp4'));
    if (!parsed) { el.remove(); return; } // 무음 청크
    el.classList.remove('pending');
    el.querySelector('.lv-orig').textContent = parsed.orig;
    el.querySelector('.lv-ko').textContent = parsed.ko;
    if (nearBottom()) window.scrollTo(0, document.body.scrollHeight);
  } catch (e) {
    // 청크 하나의 실패로 세션을 멈추지 않는다 — 표시만 하고 계속
    el.classList.remove('pending');
    el.classList.add('err');
    el.querySelector('.lv-orig').textContent = `[chunk failed: ${e.message}]`;
  }
}

function stopLive() {
  if (!live || live.stopping) return;
  live.stopping = true;
  clearTimeout(live.timer);
  clearInterval(live.tick);
  try { if (live.chunkRec?.state !== 'inactive') live.chunkRec.stop(); } catch {}
  live.fullRec.onstop = () => {
    live.fullBlob = new Blob(live.fullChunks, { type: live.mime || 'audio/mp4' });
    live.ended = true;
    $('btnLiveStop').hidden = true;
    $('liveEndRow').hidden = false;
    const mb = (live.fullBlob.size / 1048576).toFixed(1);
    $('liveHint').textContent = `Recording kept in memory (${mb} MB, ${fmtClock((Date.now() - live.startedAt) / 1000)}). Transcribe it now for the full minutes-quality transcript, or discard everything.`;
  };
  try { live.fullRec.stop(); } catch {}
  live.stream.getTracks().forEach(t => t.stop());
  live.chunkStream.getTracks().forEach(t => t.stop());
  try { live.wakeLock?.release(); } catch {}
  $('liveStatusText').textContent = 'Ended';
  document.querySelector('#liveStatus .rec-dot')?.classList.add('off');
}

function liveDefaultTitle() {
  const d = new Date(live.startedAt);
  return `Live ${d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' })}`;
}

// 종료 → 녹음본을 기존 전사 플로우(view-new)에 파일로 넘긴다
function liveToTranscription() {
  if (!live?.fullBlob) return;
  const title = $('liveTitleInput').value.trim() || liveDefaultTitle();
  const ext = (live.mime || 'audio/mp4').includes('mp4') ? 'm4a' : 'webm';
  const file = new File([live.fullBlob], `${title}.${ext}`, { type: live.mime || 'audio/mp4' });
  live = null;
  resetLiveView();
  resetNew();
  pickedFile = file;
  showFileCard(file);
  $('titleInput').value = title;
  $('btnStart').disabled = !!job;
  show('new');
  toast('Recording attached — start the transcription');
}

function liveDiscard() {
  if (!confirm('Discard this live session? The recording and subtitles will be lost.')) return;
  live = null;
  resetLiveView();
  renderHome();
}

/* ---------- 상세 ---------- */
let current = null; // 현재 열린 meeting 객체
let analysisLang = settings.lang;

async function openDetail(id) {
  current = await DB.get(id);
  if (!current) return renderHome();
  current.analyses ||= {};
  current.analyses.persons ||= {};
  analysisLang = settings.lang;
  $('detailTitle').value = current.title;
  switchTab('transcript');
  renderDetailHead();
  renderTranscript();
  renderSpeakers();
  await renderAnalysis();
  show('detail');
  positionTabLine(); // hidden 해제 후 실측
}

function switchTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['transcript', 'speakers', 'analysis', 'export'].forEach(t => $(`pane-${t}`).hidden = t !== tab);
  positionTabLine();
}
function positionTabLine() {
  const tabs = $('tabs');
  const active = tabs.querySelector('button.active');
  if (!active) return;
  tabs.style.setProperty('--x', `${active.offsetLeft}px`);
  tabs.style.setProperty('--w', `${active.offsetWidth}px`);
}

// 상세 헤더: 날짜 · 길이 · 화자수, 대화 지문, 화자 칩(탭 → Speakers 탭)
function renderDetailHead() {
  const st = meetingStats(current);
  const n = st.ids.length;
  const when = new Date(current.createdAt).toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('detailDate').textContent = [when, fmtDuration(st.duration), `${n} speaker${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  $('detailDate').title = current.fileName || '';
  $('detailFp').innerHTML = fpHtml(st);
  $('detailLegend').innerHTML = st.ids.map(s => {
    const me = s === st.my;
    return `<button type="button" class="chip ${me ? 'me' : speakerClass(st.ids, s, st.my)}"><i></i>${esc(displayName(current, s))}${me ? ' · Me' : ''}</button>`;
  }).join('');
  $('detailLegend').querySelectorAll('.chip').forEach(c => c.onclick = () => switchTab('speakers'));
}

/* 전사 HTML — 같은 화자의 연속 발언은 한 블록(라벨은 첫 줄에만, 색 레일이 블록을 따라감).
   상세 화면과 라이브 미리보기가 같은 렌더러를 쓴다. interactive면 라벨·타임스탬프가 화자 교정 버튼 */
function transcriptHtml(raw, m, interactive) {
  const lines = parseTranscript(raw);
  const ids = speakerIds({ raw });
  const my = mySpeaker(m);
  let prev = null, html = '';
  for (const l of lines) {
    if (!l.speaker) { html += `<p class="hint">${esc(l.text)}</p>`; prev = null; continue; }
    const cls = speakerClass(ids, l.speaker, my);
    const attrs = `data-raw="${l.rawIdx}" data-sp="${esc(l.speaker)}"`;
    const tag = interactive ? 'button type="button"' : 'span';
    const end = interactive ? 'button' : 'span';
    if (l.speaker !== prev) {
      const me = l.speaker === my ? '<span class="me">Me</span>' : '';
      html += `<div class="tl lab ${cls}"><span class="tstamp" aria-hidden="true">${esc(l.time)}</span>
        <div class="tx"><${tag} class="tspeaker" ${attrs} title="Change speaker">${esc(displayName(m, l.speaker))}${me}</${end}></div></div>`;
      prev = l.speaker;
    }
    html += `<div class="tl ${cls}"><${tag} class="tstamp" ${attrs} title="Change speaker for this line">${esc(l.time)}</${end}>
      <div class="tx">${esc(l.text)}</div></div>`;
  }
  return html;
}

function renderTranscript() {
  const pane = $('pane-transcript');
  const ids = speakerIds(current);
  pane.innerHTML = transcriptHtml(current.raw, current, true);
  pane.querySelectorAll('button.tspeaker, button.tstamp').forEach(btn => btn.onclick = () => openSpeakerPicker(btn, ids));
}

// 화자 라벨·타임스탬프 탭 → 그 줄의 텍스트 칸 위에 인라인 select. 선택하면 raw 수정, 포커스 잃으면 제거
function openSpeakerPicker(btn, ids) {
  const cur = btn.dataset.sp;
  const host = btn.closest('.tl').querySelector('.tx');
  if (host.querySelector('.tspeaker-sel')) return;
  const nextN = Math.max(0, ...ids.map(s => parseInt(s.match(/\d+/)) || 0)) + 1;
  const sel = document.createElement('select');
  sel.className = 'tspeaker-sel';
  sel.innerHTML = ids.map(s => {
    const nm = displayName(current, s);
    return `<option value="${esc(s)}" ${s === cur ? 'selected' : ''}>${esc(nm)}${nm !== s ? ` (${esc(s)})` : ''}</option>`;
  }).join('') + `<option value="Speaker ${nextN}">+ New speaker (Speaker ${nextN})</option>`;
  host.prepend(sel);
  sel.focus();
  sel.onchange = () => {
    sel.onblur = null;
    if (sel.value !== cur) reassignSpeaker(+btn.dataset.raw, sel.value);
    else sel.remove();
  };
  sel.onblur = () => sel.remove();
}

function renderSpeakers() {
  const box = $('speakerList');
  box.innerHTML = '';
  for (const sp of speakerIds(current)) {
    const row = document.createElement('div');
    row.className = 'speaker-row';
    const info = current.speakers[sp] || { name: '', me: false };
    row.innerHTML = `<span class="speaker-tag">${esc(sp)}</span>
      <input type="text" placeholder="Name (e.g. Müller)" value="${esc(info.name)}" data-sp="${esc(sp)}">
      <label class="me-toggle"><input type="radio" name="meRadio" data-sp="${esc(sp)}" ${info.me ? 'checked' : ''}> Me</label>`;
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
  renderDetailHead();
  renderTranscript();
  await renderAnalysis();
  toast('Saved');
}

/* ---------- 분석 ---------- */
// 인물 분석 저장 키: 화자 | 언어 | 포함한 과거 회의 id들
function personKey() {
  const sp = $('personSel').value;
  const scope = [...document.querySelectorAll('#scopeList input:checked')].map(cb => cb.dataset.mid).sort();
  return `${sp}|${analysisLang}|${scope.join(',')}`;
}
function currentPerson() {
  const p = current.analyses.persons?.[personKey()];
  if (p) return p;
  return current.analyses.person || null; // 옛 버전(단일 저장) 호환
}
function renderPersonOut() {
  const p = currentPerson();
  $('personOut').innerHTML = p ? mdToHtml(p.text) : '';
  $('personMeta').textContent = p ? `Generated ${new Date(p.at).toLocaleString(LOCALE)}` : '';
}

async function renderAnalysis() {
  document.querySelectorAll('#langSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === analysisLang));
  const prevSp = $('personSel').value;
  const sel = $('personSel');
  sel.innerHTML = speakerIds(current)
    .map(sp => `<option value="${esc(sp)}">${esc(displayName(current, sp))}</option>`).join('');
  if ([...sel.options].some(o => o.value === prevSp)) sel.value = prevSp;
  // 누적 범위: 다른 회의 목록 (체크 상태 유지)
  const checked = new Set([...document.querySelectorAll('#scopeList input:checked')].map(cb => cb.dataset.mid));
  const all = await DB.all();
  $('scopeList').innerHTML = all
    .filter(m => m.id !== current.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(m => `<label class="check"><input type="checkbox" data-mid="${esc(m.id)}" ${checked.has(m.id) ? 'checked' : ''}> ${esc(m.title)} <small>(${fmtDate(m.createdAt)})</small></label>`)
    .join('') || '<p class="hint">No other meetings yet.</p>';
  const my = mySpeaker(current);
  $('feedbackHint').hidden = !!my;
  $('btnFeedback').disabled = !my;
  $('momOut').innerHTML = current.analyses.mom ? mdToHtml(current.analyses.mom.text) : '';
  $('feedbackOut').innerHTML = current.analyses.feedback ? mdToHtml(current.analyses.feedback.text) : '';
  renderPersonOut();
}

async function runAnalysis(kind, btn) {
  if (!settings.apiKey) { toast('Enter your API key in Settings'); return; }
  if (btn.disabled) return;
  const outEl = $({ mom: 'momOut', person: 'personOut', feedback: 'feedbackOut' }[kind]);
  btn.disabled = true;
  const oldLabel = btn.textContent;
  swapLabel(btn, 'Generating…');
  try {
    let prompt, key = null;
    if (kind === 'mom') prompt = momPrompt(current, analysisLang);
    else if (kind === 'person') {
      key = personKey();
      const sp = $('personSel').value;
      const name = displayName(current, sp);
      const sources = [{ title: current.title, date: fmtDate(current.createdAt), text: renderedTranscriptText(current) }];
      for (const cb of document.querySelectorAll('#scopeList input:checked')) {
        const m = await DB.get(cb.dataset.mid);
        if (m) sources.push({ title: m.title, date: fmtDate(m.createdAt), text: renderedTranscriptText(m) });
      }
      prompt = personPrompt(name, sources, analysisLang);
    } else {
      const my = mySpeaker(current);
      prompt = feedbackPrompt(displayName(current, my), current, analysisLang);
    }
    const text = await generateFull([{ text: prompt }], t => { outEl.innerHTML = mdToHtml(t); });
    const entry = { text, lang: analysisLang, at: Date.now() };
    if (kind === 'person') { current.analyses.persons ||= {}; current.analyses.persons[key] = entry; }
    else current.analyses[kind] = entry;
    await DB.put(current);
    if (kind === 'person') renderPersonOut(); else outEl.innerHTML = mdToHtml(text);
    toast('Done');
  } catch (e) {
    toast(e.message, 5000);
  } finally {
    btn.disabled = false;
    swapLabel(btn, oldLabel);
  }
}

/* ---------- 내보내기 ---------- */
function buildExport() {
  const parts = [`# ${current.title}\n${new Date(current.createdAt).toLocaleString(LOCALE)}`];
  if ($('expTranscript').checked) parts.push(`## Transcript (verbatim)\n\n${renderedTranscriptText(current)}`);
  if ($('expMom').checked && current.analyses.mom) parts.push(current.analyses.mom.text);
  if ($('expPerson').checked) { const p = currentPerson(); if (p) parts.push(p.text); }
  if ($('expFeedback').checked && current.analyses.feedback) parts.push(current.analyses.feedback.text);
  return parts.join('\n\n---\n\n');
}
function exportFileName() {
  const d = new Date(current.createdAt);
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${ymd} ${current.title}`.replace(/[\\/:*?"<>|]/g, '_');
}

async function shareBlob(blob, name, title) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title }); return true; }
  return false;
}
async function shareExport() {
  const text = buildExport();
  try {
    if (await shareBlob(new Blob([text], { type: 'text/plain' }), exportFileName() + '.txt', current.title)) return;
    if (navigator.share) { await navigator.share({ title: current.title, text }); return; }
    throw new Error('no-share');
  } catch (e) {
    if (e.name === 'AbortError') return;
    await copyExport(); // 공유 미지원 → 클립보드로 폴백
  }
}
async function copyExport() {
  await navigator.clipboard.writeText(buildExport());
  toast('Copied to clipboard');
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function downloadExport() {
  downloadBlob(new Blob([buildExport()], { type: 'text/markdown' }), exportFileName() + '.md');
}

/* ---------- 백업·복원 (전체 회의 JSON) ---------- */
async function backupAll() {
  const meetings = await DB.all();
  if (!meetings.length) { toast('Nothing to back up yet'); return; }
  const payload = { app: 'MeetMemo', version: 1, exportedAt: new Date().toISOString(), meetings };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const d = new Date();
  const name = `meetmemo-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  try {
    if (await shareBlob(blob, name, 'MeetMemo backup')) return;
  } catch (e) { if (e.name === 'AbortError') return; }
  downloadBlob(blob, name);
}

async function restoreFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast('Not a valid backup file'); return; }
  const list = Array.isArray(data?.meetings) ? data.meetings : null;
  if (!list) { toast('Not a MeetMemo backup'); return; }
  const existing = new Set((await DB.all()).map(m => m.id));
  let added = 0, replaced = 0;
  for (const m of list) {
    if (!m?.id || typeof m.raw !== 'string') continue;
    if (existing.has(m.id)) {
      if (!confirm(`"${m.title}" already exists. Replace it with the backup version?`)) continue;
      replaced++;
    } else added++;
    await DB.put(m);
  }
  toast(`Restored: ${added} added, ${replaced} replaced`, 4000);
  renderHome();
}

/* ---------- 설정 화면 ---------- */
function renderSettings() {
  $('apiKeyInput').value = settings.apiKey;
  $('rememberKey').checked = settings.rememberKey !== false;
  fillModelSelect([settings.model]);
  document.querySelectorAll('#defLangSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  show('settings');
}
function fillModelSelect(models, selected = settings.model) {
  const sel = $('modelSel');
  const set = new Set([selected, ...models]);
  sel.innerHTML = [...set].map(m => `<option ${m === selected ? 'selected' : ''}>${esc(m)}</option>`).join('');
}
async function loadModelsAndPick(auto) {
  const models = await fetchModels();
  const chosen = auto ? pickDefaultModel(models) : settings.model;
  fillModelSelect(models, chosen);
  return { models, chosen };
}

/* ---------- 이벤트 바인딩 ---------- */
function bind() {
  $('btnHome').onclick = () => { if (!liveGuard()) renderHome(); };
  $('btnBack').onclick = () => { if (!liveGuard()) renderHome(); };
  $('btnSettings').onclick = () => { if (!liveGuard()) renderSettings(); };
  $('btnNew').onclick = () => { if (job) { show('new'); return; } resetNew(); show('new'); };
  $('btnLive').onclick = () => { if (!live) resetLiveView(); show('live'); };
  $('btnLiveStart').onclick = startLive;
  $('btnLiveStop').onclick = stopLive;
  $('btnLiveTranscribe').onclick = liveToTranscription;
  $('btnLiveDiscard').onclick = liveDiscard;

  $('fileInput').onchange = e => {
    const f = e.target.files[0] || null;
    if (!f) return; // 취소 → 이전 선택 유지
    pickedFile = f;
    showFileCard(f);
    if (!$('titleInput').value) $('titleInput').value = f.name.replace(/\.[^.]+$/, '');
    $('btnStart').disabled = !!job;
  };
  $('btnChangeFile').onclick = () => { if (!job) $('fileInput').click(); };
  $('btnStart').onclick = startTranscription;
  $('btnCancel').onclick = cancelTranscription;

  $('detailTitle').onchange = async () => {
    current.title = $('detailTitle').value.trim() || current.title;
    await DB.put(current);
  };
  document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => switchTab(b.dataset.tab));
  $('btnSaveSpeakers').onclick = saveSpeakers;

  $('langSeg').onclick = e => {
    if (e.target.dataset.lang) { analysisLang = e.target.dataset.lang; renderAnalysis(); }
  };
  $('personSel').onchange = renderPersonOut;
  $('scopeList').onchange = renderPersonOut;
  $('btnMom').onclick = e => runAnalysis('mom', e.target);
  $('btnPerson').onclick = e => runAnalysis('person', e.target);
  $('btnFeedback').onclick = e => runAnalysis('feedback', e.target);

  $('btnShare').onclick = shareExport;
  $('btnCopy').onclick = copyExport;
  $('btnDownload').onclick = downloadExport;
  $('btnDelete').onclick = async () => {
    if (!confirm(`Delete "${current.title}"? This cannot be undone.`)) return;
    await DB.del(current.id);
    toast('Deleted');
    renderHome();
  };

  $('btnShowKey').onclick = e => {
    const i = $('apiKeyInput');
    const showing = i.type === 'password';
    i.type = showing ? 'text' : 'password';
    e.currentTarget.setAttribute('aria-pressed', String(showing));
    e.currentTarget.setAttribute('aria-label', showing ? 'Hide key' : 'Show key');
  };
  $('btnForgetKey').onclick = () => {
    if (!confirm('Remove the API key from this device?')) return;
    settings.apiKey = '';
    Settings.forgetKey();
    $('apiKeyInput').value = '';
    toast('API key removed');
  };
  $('btnLoadModels').onclick = async e => {
    settings.apiKey = $('apiKeyInput').value.trim();
    if (!settings.apiKey) { toast('Enter your API key first'); return; }
    e.target.disabled = true;
    try {
      const { chosen } = await loadModelsAndPick(!settings.modelPicked);
      toast(settings.modelPicked ? 'Model list loaded' : `Model list loaded — suggested: ${chosen}`, 4000);
    } catch (err) { toast(err.message, 5000); }
    finally { e.target.disabled = false; }
  };
  $('defLangSeg').onclick = e => {
    if (!e.target.dataset.lang) return;
    settings.lang = e.target.dataset.lang;
    document.querySelectorAll('#defLangSeg button').forEach(b => b.classList.toggle('active', b.dataset.lang === settings.lang));
  };
  $('btnSaveSettings').onclick = async () => {
    settings.apiKey = $('apiKeyInput').value.trim();
    settings.rememberKey = $('rememberKey').checked;
    const picked = $('modelSel').value || settings.model;
    // 모델을 한 번도 고른 적 없고 키가 있으면, 최신 Flash를 자동으로 잡는다
    if (!settings.modelPicked && settings.apiKey && picked === FALLBACK_MODEL) {
      try { const { chosen } = await loadModelsAndPick(true); settings.model = chosen; }
      catch { settings.model = picked; }
    } else settings.model = picked;
    settings.modelPicked = !!settings.apiKey;
    Settings.save(settings);
    toast(`Settings saved · model: ${settings.model}`, 3500);
    renderHome();
  };
  $('btnBackup').onclick = backupAll;
  $('btnRestore').onclick = () => $('restoreInput').click();
  $('restoreInput').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) await restoreFromFile(f);
  };

  // 전사·라이브 세션 중 실수로 닫는 것 방지
  window.addEventListener('beforeunload', e => { if (job || live) { e.preventDefault(); e.returnValue = ''; } });
}

/* ---------- 시작 ---------- */
(async function init() {
  await DB.open();
  bind();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  window.addEventListener('resize', positionTabLine);
  if (!settings.apiKey) renderSettings();
  else renderHome();
})();
