import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const cfg = window.TAETAE_CONFIG || {};
const view = document.getElementById('view');
const nav = document.getElementById('nav');
const $who = document.getElementById('who');
const $logout = document.getElementById('logout');
const ID_DOMAIN = 'staff.taetae-app.kr';
const TZ = 'Asia/Seoul';

if (!cfg.url || !cfg.anonKey || cfg.url.includes('YOUR_')) {
  view.innerHTML = `<div class="card">앱 설정(config.js)이 아직 비어 있어요.</div>`;
  throw new Error('config missing');
}
const sb = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true } });

let me = null;       // profile
let tab = localStorage.getItem('tab') || 'att';

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = 'none', 2600); };
const fmt = (d, opt) => d ? new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, ...opt }).format(new Date(d)) : '';
const fDate = d => fmt(d, { month: 'numeric', day: 'numeric', weekday: 'short' });
const fTime = d => fmt(d, { hour: '2-digit', minute: '2-digit', hour12: false });
const fFull = d => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const hours = (a, b) => b ? (new Date(b) - new Date(a)) / 36e5 : 0;
const hm = h => { const m = Math.round(h * 60); return `${Math.floor(m / 60)}시간 ${m % 60}분`; };
const kstParts = (d = new Date()) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(x => [x.type, x.value])); return p; };
const monthRange = (ym) => { const [y, m] = ym.split('-').map(Number); const s = new Date(Date.UTC(y, m - 1, 1) - 9 * 36e5); const e = new Date(Date.UTC(y, m, 1) - 9 * 36e5); return [s.toISOString(), e.toISOString()]; };
const toLocalInput = d => { if (!d) return ''; const p = kstParts(new Date(d)); return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`; };
const fromLocalInput = v => v ? new Date(v + ':00+09:00').toISOString() : null;
const err = e => toast('오류: ' + (e?.message || e));
const idToEmail = id => `${id.trim().toLowerCase()}@${ID_DOMAIN}`;

// ---------- auth ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderLogin();
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  if (error || !data) { view.innerHTML = `<div class="card">프로필을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.<br><br><button class="btn ghost" id="lo">로그아웃</button></div>`; document.getElementById('lo').onclick = logout; return; }
  me = data;
  $who.textContent = `${me.name}${me.role === 'owner' ? ' (사장)' : ''}`;
  $logout.classList.remove('hide');
  if (!me.approved) {
    nav.classList.add('hide');
    view.innerHTML = `<div class="card center"><h2>승인 대기 중이에요</h2><p class="muted">사장님이 승인하면 바로 쓸 수 있어요.</p><button class="btn ghost" id="re">승인 여부 다시 확인</button></div>`;
    document.getElementById('re').onclick = boot;
    return;
  }
  nav.classList.remove('hide');
  document.getElementById('admTab').classList.toggle('hide', me.role !== 'owner');
  if (tab === 'adm' && me.role !== 'owner') tab = 'att';
  go(tab);
}

async function logout() { await sb.auth.signOut(); me = null; $who.textContent = ''; $logout.classList.add('hide'); nav.classList.add('hide'); renderLogin(); }
$logout.onclick = logout;

function renderLogin(mode = 'login') {
  nav.classList.add('hide');
  view.innerHTML = `
  <div class="card">
    <h2>${mode === 'login' ? '로그인' : '직원 가입'}</h2>
    ${mode === 'signup' ? `<p class="muted">가입하면 사장님 승인 후 쓸 수 있어요. (맨 처음 가입한 사람이 사장 계정이 돼요)</p><label>이름</label><input id="nm" placeholder="홍길동">` : ''}
    <label>아이디 (영문·숫자)</label><input id="lid" autocapitalize="off" autocomplete="username" placeholder="예: gildong">
    <label>비밀번호 (6자 이상)</label><input id="pw" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}">
    <br><br><button class="btn pri block" id="go">${mode === 'login' ? '로그인' : '가입 신청'}</button>
    <p class="center muted" style="margin-top:14px">${mode === 'login' ? '처음이세요? <a href="#" id="sw">직원 가입</a>' : '이미 계정이 있어요. <a href="#" id="sw">로그인</a>'}</p>
  </div>`;
  document.getElementById('sw').onclick = e => { e.preventDefault(); renderLogin(mode === 'login' ? 'signup' : 'login'); };
  document.getElementById('go').onclick = async () => {
    const lid = document.getElementById('lid').value.trim();
    const pw = document.getElementById('pw').value;
    if (!/^[a-zA-Z0-9._-]{2,30}$/.test(lid)) return toast('아이디는 영문·숫자 2~30자로 써 주세요');
    if (pw.length < 6) return toast('비밀번호는 6자 이상이에요');
    const b = document.getElementById('go'); b.disabled = true;
    try {
      if (mode === 'login') {
        const { error } = await sb.auth.signInWithPassword({ email: idToEmail(lid), password: pw });
        if (error) throw new Error(error.message.includes('Invalid') ? '아이디나 비밀번호가 맞지 않아요' : error.message);
      } else {
        const name = document.getElementById('nm').value.trim();
        if (!name) throw new Error('이름을 써 주세요');
        const { data, error } = await sb.auth.signUp({ email: idToEmail(lid), password: pw, options: { data: { name, login_id: lid } } });
        if (error) throw new Error(error.message.includes('registered') ? '이미 있는 아이디예요' : error.message);
        if (!data.session) { toast('가입 신청 완료. 로그인해 주세요'); return renderLogin('login'); }
      }
      boot();
    } catch (e) { err(e); } finally { b.disabled = false; }
  };
}

// ---------- tabs ----------
nav.querySelectorAll('button').forEach(b => b.onclick = () => go(b.dataset.tab));
function go(t) {
  tab = t; localStorage.setItem('tab', t);
  nav.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  view.innerHTML = `<div class="card center muted">불러오는 중...</div>`;
  ({ att: renderAtt, inv: renderInv, ord: renderOrd, adm: renderAdm })[t]().catch(err);
}

// ---------- 출퇴근 ----------
async function renderAtt() {
  const { data: rows, error } = await sb.from('attendance').select('*').eq('user_id', me.id).order('clock_in', { ascending: false }).limit(60);
  if (error) throw error;
  const open = rows.find(r => !r.clock_out);
  const ym = `${kstParts().year}-${kstParts().month}`;
  const [ms] = monthRange(ym);
  const monthH = rows.filter(r => r.clock_in >= ms).reduce((a, r) => a + hours(r.clock_in, r.clock_out), 0);
  view.innerHTML = `
  <div class="card center">
    <div class="muted">${fmt(new Date(), { month: 'long', day: 'numeric', weekday: 'long' })}</div>
    <div class="big" id="clock">${fTime(new Date())}</div>
    <div class="muted" style="margin-bottom:12px">${open ? `출근 ${fTime(open.clock_in)} · 근무 중` : '퇴근 상태'}</div>
    ${open ? `<button class="btn pri block" id="out">퇴근하기</button>` : `<button class="btn ok block" id="in">출근하기</button>`}
  </div>
  <div class="card">
    <h2>내 기록</h2>
    <div class="muted">이번 달 근무 ${hm(monthH)}</div>
    <table><tr><th>날짜</th><th>출근</th><th>퇴근</th><th>근무</th></tr>
    ${rows.map(r => `<tr><td>${fDate(r.clock_in)}</td><td>${fTime(r.clock_in)}</td><td>${r.clock_out ? fTime(r.clock_out) : '-'}</td><td>${r.clock_out ? hm(hours(r.clock_in, r.clock_out)) : '근무 중'}${r.edited_by ? ' <span class="tag">수정됨</span>' : ''}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">기록이 없어요</td></tr>'}
    </table>
  </div>`;
  const tick = setInterval(() => { const c = document.getElementById('clock'); if (!c) return clearInterval(tick); c.textContent = fTime(new Date()); }, 15000);
  const act = async (fn, msg) => { const { error } = await sb.rpc(fn); if (error) return err(error); toast(msg); renderAtt(); };
  document.getElementById('in')?.addEventListener('click', e => { e.target.disabled = true; act('clock_in', '출근 기록했어요'); });
  document.getElementById('out')?.addEventListener('click', e => { if (!confirm('퇴근 기록할까요?')) return; e.target.disabled = true; act('clock_out', '퇴근 기록했어요. 수고하셨어요'); });
}

// ---------- 재고조사 ----------
async function loadItems(all = false) {
  let q = sb.from('items').select('*').order('sort').order('id');
  if (!all) q = q.eq('active', true);
  const { data, error } = await q; if (error) throw error; return data;
}
const groupBy = (arr, k) => arr.reduce((m, x) => ((m[x[k]] ||= []).push(x), m), {});

async function renderInv() {
  const [items, { data: last, error }] = await Promise.all([loadItems(), sb.from('latest_counts').select('*')]);
  if (error) throw error;
  const lastBy = Object.fromEntries(last.map(l => [l.item_id, l]));
  const groups = groupBy(items, 'category');
  const lowCount = items.filter(i => lastBy[i.id] && Number(lastBy[i.id].qty) < Number(i.min_qty)).length;
  view.innerHTML = `
  <div class="card"><h2>재고조사</h2>
    <div class="muted">센 품목만 숫자를 넣고 맨 아래 저장을 누르세요. 빈칸은 저장하지 않아요. 빨간색은 최소 수량보다 적은 품목이에요.${lowCount ? ` <b class="low">부족 ${lowCount}개</b>` : ''}</div>
    <input id="flt" placeholder="품목 검색" style="margin-top:10px">
  </div>
  ${Object.entries(groups).map(([cat, list]) => `
  <div class="card grp"><h2>${esc(cat)}</h2>
    ${list.map(i => { const l = lastBy[i.id]; const low = l && Number(l.qty) < Number(i.min_qty); return `
    <div class="item" data-name="${esc(i.name.toLowerCase())}">
      <div class="nm ${low ? 'low' : ''}">${esc(i.name)}<small>${l ? `지난 조사 ${l.qty}${esc(i.unit)} · ${fDate(l.counted_at)}` : '조사 기록 없음'} · 최소 ${i.min_qty}</small></div>
      <input type="number" inputmode="decimal" min="0" step="any" data-id="${i.id}" placeholder="${l ? l.qty : ''}">
      <span class="u">${esc(i.unit)}</span>
    </div>`; }).join('')}
  </div>`).join('')}
  <div class="card"><button class="btn pri block" id="save">재고조사 저장</button>
  <button class="btn ghost block" id="toOrd" style="margin-top:8px">부족한 품목 발주요청 만들기</button></div>`;
  document.getElementById('flt').oninput = e => { const v = e.target.value.trim().toLowerCase(); document.querySelectorAll('.item').forEach(el => el.style.display = !v || el.dataset.name.includes(v) ? '' : 'none'); };
  document.getElementById('save').onclick = async e => {
    const rows = [...document.querySelectorAll('.item input')].filter(x => x.value !== '').map(x => ({ item_id: Number(x.dataset.id), qty: Number(x.value) }));
    if (!rows.length) return toast('입력한 수량이 없어요');
    e.target.disabled = true;
    const { error } = await sb.from('inventory_counts').insert(rows);
    e.target.disabled = false;
    if (error) return err(error);
    toast(`${rows.length}개 품목 저장했어요`); renderInv();
  };
  document.getElementById('toOrd').onclick = async () => {
    const typed = Object.fromEntries([...document.querySelectorAll('.item input')].filter(x => x.value !== '').map(x => [x.dataset.id, Number(x.value)]));
    const lows = items.filter(i => { const q = typed[i.id] ?? lastBy[i.id]?.qty; return q !== undefined && Number(q) < Number(i.min_qty); });
    if (!lows.length) return toast('부족한 품목이 없어요');
    if (!confirm(`부족 품목 ${lows.length}개를 발주요청할까요?\n\n${lows.map(i => '· ' + i.name).join('\n')}`)) return;
    const rows = lows.map(i => { const q = Number(typed[i.id] ?? lastBy[i.id].qty); return { item_id: i.id, item_name: i.name, unit: i.unit, qty: Math.max(Number(i.min_qty) * 2 - q, 1), note: `재고 ${q}${i.unit} (최소 ${i.min_qty})` }; });
    const { error } = await sb.from('orders').insert(rows);
    if (error) return err(error);
    toast('발주요청을 만들었어요'); go('ord');
  };
}

// ---------- 발주요청 ----------
async function renderOrd() {
  const [items, { data: orders, error }, { data: people }] = await Promise.all([
    loadItems(), sb.from('orders').select('*').order('created_at', { ascending: false }).limit(150), sb.from('profiles').select('id,name')]);
  if (error) throw error;
  const nm = Object.fromEntries((people || []).map(p => [p.id, p.name]));
  const isOwner = me.role === 'owner';
  const flt = localStorage.getItem('ordFlt') || '진행중';
  const shown = orders.filter(o => flt === '전체' ? true : flt === '진행중' ? ['요청', '주문완료'].includes(o.status) : o.status === flt);
  view.innerHTML = `
  <div class="card"><h2>발주요청 하기</h2>
    <label>품목</label>
    <select id="it"><option value="">직접 입력</option>${items.map(i => `<option value="${i.id}">[${esc(i.category)}] ${esc(i.name)}</option>`).join('')}</select>
    <div id="freeWrap"><label>품목 이름</label><input id="free" placeholder="목록에 없는 품목"></div>
    <div class="row"><div><label>수량</label><input id="qty" type="number" inputmode="decimal" min="0" step="any"></div><div><label>단위</label><input id="unit" value="개"></div></div>
    <label>메모 (선택)</label><input id="note" placeholder="예: 내일 오전까지">
    <br><br><button class="btn pri block" id="req">요청 보내기</button>
  </div>
  <div class="card"><h2>요청 목록</h2>
    <div class="row" style="margin-bottom:8px">${['진행중', '입고완료', '취소', '전체'].map(f => `<button class="btn sm ${f === flt ? '' : 'ghost'}" data-f="${f}">${f}</button>`).join('')}</div>
    ${shown.map(o => `
    <div class="item">
      <div class="nm">${esc(o.item_name)} <b>${o.qty}${esc(o.unit)}</b> <span class="tag ${o.status}">${o.status}</span>
        <small>${esc(nm[o.requested_by] || '')} · ${fFull(o.created_at)}${o.note ? ' · ' + esc(o.note) : ''}</small></div>
      ${isOwner ? `<select data-oid="${o.id}" style="width:110px;flex:none">${['요청', '주문완료', '입고완료', '취소'].map(s => `<option ${s === o.status ? 'selected' : ''}>${s}</option>`).join('')}</select>`
        : (o.requested_by === me.id && o.status === '요청' ? `<button class="btn sm ghost" data-cancel="${o.id}">취소</button>` : '')}
    </div>`).join('') || '<div class="muted">요청이 없어요</div>'}
  </div>`;
  const it = document.getElementById('it');
  it.onchange = () => { const i = items.find(x => x.id == it.value); document.getElementById('freeWrap').style.display = i ? 'none' : ''; if (i) document.getElementById('unit').value = i.unit; };
  document.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { localStorage.setItem('ordFlt', b.dataset.f); renderOrd(); });
  document.getElementById('req').onclick = async e => {
    const i = items.find(x => x.id == it.value);
    const name = i ? i.name : document.getElementById('free').value.trim();
    const qty = Number(document.getElementById('qty').value);
    if (!name) return toast('품목을 골라 주세요');
    if (!(qty > 0)) return toast('수량을 넣어 주세요');
    e.target.disabled = true;
    const { error } = await sb.from('orders').insert({ item_id: i?.id ?? null, item_name: name, qty, unit: document.getElementById('unit').value.trim() || '개', note: document.getElementById('note').value.trim() });
    e.target.disabled = false;
    if (error) return err(error);
    toast('발주요청을 보냈어요'); renderOrd();
  };
  document.querySelectorAll('[data-oid]').forEach(s => s.onchange = async () => {
    const { error } = await sb.from('orders').update({ status: s.value, updated_at: new Date().toISOString() }).eq('id', s.dataset.oid);
    if (error) return err(error); toast(`'${s.value}'(으)로 바꿨어요`); renderOrd();
  });
  document.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    if (!confirm('이 요청을 취소할까요?')) return;
    const { error } = await sb.from('orders').update({ status: '취소', updated_at: new Date().toISOString() }).eq('id', b.dataset.cancel);
    if (error) return err(error); renderOrd();
  });
}

// ---------- 관리 (사장) ----------
async function renderAdm() {
  const sec = localStorage.getItem('admSec') || 'att';
  view.innerHTML = `<div class="card row">${[['att', '출퇴근 기록'], ['staff', '직원'], ['items', '품목']].map(([k, l]) => `<button class="btn sm ${k === sec ? '' : 'ghost'}" data-s="${k}">${l}</button>`).join('')}</div><div id="adm"></div>`;
  document.querySelectorAll('[data-s]').forEach(b => b.onclick = () => { localStorage.setItem('admSec', b.dataset.s); renderAdm(); });
  await ({ att: admAtt, staff: admStaff, items: admItems })[sec]();
}

async function admAtt() {
  const box = document.getElementById('adm');
  const p = kstParts();
  const ym = localStorage.getItem('admYm') || `${p.year}-${p.month}`;
  const [s, e] = monthRange(ym);
  const [{ data: rows, error }, { data: people }] = await Promise.all([
    sb.from('attendance').select('*').gte('clock_in', s).lt('clock_in', e).order('clock_in', { ascending: false }),
    sb.from('profiles').select('id,name,approved')]);
  if (error) throw error;
  const nm = Object.fromEntries(people.map(x => [x.id, x.name]));
  const sum = {}; rows.forEach(r => { sum[r.user_id] = (sum[r.user_id] || 0) + hours(r.clock_in, r.clock_out); });
  box.innerHTML = `
  <div class="card"><h2>월별 근무 합계</h2>
    <div class="row"><input type="month" id="ym" value="${ym}"><button class="btn ghost" id="csv" style="flex:none">CSV 받기</button></div>
    <table style="margin-top:8px"><tr><th>직원</th><th>근무일</th><th>합계</th></tr>
    ${Object.entries(sum).map(([u, h]) => `<tr><td>${esc(nm[u])}</td><td>${new Set(rows.filter(r => r.user_id === u).map(r => fDate(r.clock_in))).size}일</td><td>${hm(h)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">기록이 없어요</td></tr>'}
    </table></div>
  <div class="card"><h2>상세 기록</h2>
    <div class="muted">시간을 고치려면 '수정'을 누르세요. 고친 기록은 '수정됨'으로 표시돼요.</div>
    <table><tr><th>직원</th><th>날짜</th><th>출근</th><th>퇴근</th><th></th></tr>
    ${rows.map(r => `<tr><td>${esc(nm[r.user_id])}</td><td>${fDate(r.clock_in)}</td><td>${fTime(r.clock_in)}</td><td>${r.clock_out ? fTime(r.clock_out) : '근무 중'}</td><td><button class="btn sm ghost" data-ed="${r.id}">수정</button></td></tr>
      <tr class="hide" id="ed${r.id}"><td colspan="5"><div class="row"><input type="datetime-local" value="${toLocalInput(r.clock_in)}" id="ci${r.id}"><input type="datetime-local" value="${toLocalInput(r.clock_out)}" id="co${r.id}"></div>
      <input placeholder="메모 (수정 사유)" id="nt${r.id}" value="${esc(r.note)}" style="margin-top:6px"><button class="btn sm" data-sv="${r.id}" style="margin-top:6px">저장</button></td></tr>`).join('')}
    </table></div>
  <div class="card"><h2>출퇴근 기록 추가</h2><div class="muted">직원이 깜빡했을 때 사장님이 직접 넣어요.</div>
    <label>직원</label><select id="au">${people.filter(x => x.approved).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select>
    <div class="row"><div><label>출근</label><input type="datetime-local" id="ai"></div><div><label>퇴근</label><input type="datetime-local" id="ao"></div></div>
    <label>메모</label><input id="an"><br><br><button class="btn block" id="add">추가</button></div>`;
  document.getElementById('ym').onchange = ev => { localStorage.setItem('admYm', ev.target.value); admAtt(); };
  document.querySelectorAll('[data-ed]').forEach(b => b.onclick = () => document.getElementById('ed' + b.dataset.ed).classList.toggle('hide'));
  document.querySelectorAll('[data-sv]').forEach(b => b.onclick = async () => {
    const id = b.dataset.sv;
    const { error } = await sb.from('attendance').update({ clock_in: fromLocalInput(document.getElementById('ci' + id).value), clock_out: fromLocalInput(document.getElementById('co' + id).value), note: document.getElementById('nt' + id).value, edited_by: me.id, edited_at: new Date().toISOString() }).eq('id', id);
    if (error) return err(error); toast('수정했어요'); admAtt();
  });
  document.getElementById('add').onclick = async () => {
    const ci = fromLocalInput(document.getElementById('ai').value);
    if (!ci) return toast('출근 시간을 넣어 주세요');
    const { error } = await sb.from('attendance').insert({ user_id: document.getElementById('au').value, clock_in: ci, clock_out: fromLocalInput(document.getElementById('ao').value), note: document.getElementById('an').value, edited_by: me.id, edited_at: new Date().toISOString() });
    if (error) return err(error); toast('추가했어요'); admAtt();
  };
  document.getElementById('csv').onclick = () => {
    const lines = [['직원', '날짜', '출근', '퇴근', '근무(시간)', '메모', '수정됨'].join(',')].concat(
      [...rows].reverse().map(r => [nm[r.user_id], fmt(r.clock_in, { year: 'numeric', month: '2-digit', day: '2-digit' }), fTime(r.clock_in), r.clock_out ? fTime(r.clock_out) : '', hours(r.clock_in, r.clock_out).toFixed(2), r.note, r.edited_by ? 'Y' : ''].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `태태_출퇴근_${ym}.csv`; a.click();
  };
}

async function admStaff() {
  const box = document.getElementById('adm');
  const { data, error } = await sb.from('profiles').select('*').order('created_at');
  if (error) throw error;
  box.innerHTML = `<div class="card"><h2>직원</h2><div class="muted">직원이 앱에서 '직원 가입'을 하면 여기 뜨고, 승인해야 쓸 수 있어요. 그만둔 직원은 '사용 중지'하면 기록은 남고 로그인만 막혀요.</div>
  ${data.map(p => `<div class="item"><div class="nm">${esc(p.name)} ${p.role === 'owner' ? '<span class="tag">사장</span>' : ''}<small>아이디 ${esc(p.login_id)} · 가입 ${fDate(p.created_at)}</small></div>
    ${p.role === 'owner' ? '' : p.approved ? `<button class="btn sm ghost" data-ap="${p.id}" data-v="0">사용 중지</button>` : `<button class="btn sm ok" data-ap="${p.id}" data-v="1">승인</button>`}</div>`).join('')}</div>`;
  box.querySelectorAll('[data-ap]').forEach(b => b.onclick = async () => {
    const { error } = await sb.from('profiles').update({ approved: b.dataset.v === '1' }).eq('id', b.dataset.ap);
    if (error) return err(error); toast(b.dataset.v === '1' ? '승인했어요' : '사용 중지했어요'); admStaff();
  });
}

async function admItems() {
  const box = document.getElementById('adm');
  const items = await loadItems(true);
  const cats = [...new Set(items.map(i => i.category))];
  box.innerHTML = `<div class="card"><h2>품목 추가</h2>
    <div class="row"><div><label>분류</label><input id="nc" list="cats" placeholder="예: 채소"><datalist id="cats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist></div><div><label>품목명</label><input id="nn"></div></div>
    <div class="row"><div><label>단위</label><input id="nu" value="개"></div><div><label>최소 수량</label><input id="nm" type="number" inputmode="decimal" value="0"></div></div>
    <br><button class="btn block" id="addI">추가</button></div>
  <div class="card"><h2>품목 목록</h2><div class="muted">숨긴 품목은 재고조사·발주 목록에서 빠지지만 기록은 남아요.</div>
  ${items.map(i => `<div class="item" style="${i.active ? '' : 'opacity:.45'}">
    <div class="nm"><input value="${esc(i.name)}" data-f="name" data-id="${i.id}" style="width:100%;text-align:left"><small>${esc(i.category)}${i.active ? '' : ' · 숨김'}</small></div>
    <input value="${i.min_qty}" type="number" inputmode="decimal" data-f="min_qty" data-id="${i.id}" title="최소 수량" style="width:64px">
    <input value="${esc(i.unit)}" data-f="unit" data-id="${i.id}" style="width:52px;text-align:center">
    <button class="btn sm ghost" data-tg="${i.id}" data-a="${i.active ? 0 : 1}">${i.active ? '숨김' : '복구'}</button></div>`).join('')}</div>`;
  document.getElementById('addI').onclick = async () => {
    const name = document.getElementById('nn').value.trim(); if (!name) return toast('품목명을 써 주세요');
    const { error } = await sb.from('items').insert({ category: document.getElementById('nc').value.trim() || '기타', name, unit: document.getElementById('nu').value.trim() || '개', min_qty: Number(document.getElementById('nm').value) || 0, sort: 999 });
    if (error) return err(error); toast('추가했어요'); admItems();
  };
  box.querySelectorAll('input[data-f]').forEach(inp => inp.onchange = async () => {
    const v = inp.dataset.f === 'min_qty' ? Number(inp.value) || 0 : inp.value.trim();
    const { error } = await sb.from('items').update({ [inp.dataset.f]: v }).eq('id', inp.dataset.id);
    if (error) return err(error); toast('저장했어요');
  });
  box.querySelectorAll('[data-tg]').forEach(b => b.onclick = async () => {
    const { error } = await sb.from('items').update({ active: b.dataset.a === '1' }).eq('id', b.dataset.tg);
    if (error) return err(error); admItems();
  });
}

sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') renderLogin(); });
boot();
