#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');

const COMPANY_ID = 12275002;
const PASSWORD   = process.env.DASHBOARD_PASSWORD || 'NPCashdata';
const GH_PAT     = process.env.GH_PAT            || '';
const GH_REPO    = 'NP-Backoffice/cfo-dashboard';

// ── HTTP helper ────────────────────────────────────────────────
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── freee: token ───────────────────────────────────────────────
async function getToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: process.env.FREEE_REFRESH_TOKEN,
    client_id: process.env.FREEE_CLIENT_ID, client_secret: process.env.FREEE_CLIENT_SECRET,
  }).toString();
  const r = await request({
    hostname: 'accounts.secure.freee.co.jp', path: '/public_api/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(params) },
  }, params);
  if (r.status !== 200) throw new Error(`Token error ${r.status}: ${JSON.stringify(r.body)}`);
  console.log('[freee] ✓ アクセストークン取得');
  if (r.body.refresh_token && process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_refresh_token=${r.body.refresh_token}\n`);
    console.log('[freee] ✓ 新リフレッシュトークンを出力');
  }
  return r.body.access_token;
}

// ── freee: GET ─────────────────────────────────────────────────
async function freeeGet(token, endpoint, query = {}) {
  const qs = new URLSearchParams({ company_id: COMPANY_ID, ...query }).toString();
  const r = await request({
    hostname: 'api.freee.co.jp', path: `/api/1${endpoint}?${qs}`, method: 'GET',
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (r.status !== 200) { console.warn(`[freee] ${endpoint} → ${r.status}`); return null; }
  return r.body;
}

// ── Compute last N months ──────────────────────────────────────
function getMonths(jst, n) {
  const months = [];
  for (let i = n - 1; i >= 0; i--) {
    const d  = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() - i, 1));
    const yr = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    const fy = mo >= 4 ? yr : yr - 1;
    const key = `${yr}/${String(mo).padStart(2, '0')}`;
    const fm = ((mo - 4 + 12) % 12) + 1; // fiscal month (April=1 … March=12)
    months.push({ yr, mo, fm, fy, key, label: mo + '月', dateStr: yr + '-' + String(mo).padStart(2, '0') + '-01' });
  }
  return months;
}

// ── Extract P/L from balances ──────────────────────────────────
function getB(arr, name, total = false) {
  for (const b of arr || []) {
    if (total && b.total_line && b.account_category_name === name) return b.closing_balance || 0;
    if (!total && b.account_item_name === name) return b.closing_balance || 0;
  }
  return 0;
}
function extractPL(plData) {
  const b        = plData?.trial_pl?.balances || [];
  const revenue  = getB(b, '売上高', true);
  const opex     = getB(b, '販売管理費', true);
  const opIncome = getB(b, '営業損益金額', true);
  const outsource= getB(b, '外注費');
  const officers = getB(b, '役員報酬');
  const salary   = getB(b, '給料手当');
  const welfare  = getB(b, '法定福利費');
  const rent     = getB(b, '地代家賃');
  const fee      = getB(b, '支払報酬料');
  const comm     = getB(b, '通信費');
  const meeting  = getB(b, '会議費');
  const entertain= getB(b, '交際費');
  const other    = Math.max(0, opex - outsource - officers - salary - welfare - rent - fee - comm - meeting - entertain);
  const opMargin = revenue > 0 ? Math.round(opIncome / revenue * 1000) / 10 : 0;
  return { revenue, opex, opIncome, opMargin, outsource, officers, salary, welfare, rent, fee, comm, meeting, entertain, other };
}

// ── Client map from deals ──────────────────────────────────────
function buildClientMap(deals) {
  const map = {};
  for (const d of deals || []) {
    const n = d.partner_name || '（不明）';
    map[n] = (map[n] || 0) + Math.abs(d.amount || 0);
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

// ── Encrypt ────────────────────────────────────────────────────
function encrypt(html) {
  const salt = crypto.randomBytes(16);
  const key  = crypto.pbkdf2Sync(PASSWORD, salt, 100000, 32, 'sha256');
  const iv   = crypto.randomBytes(12);
  const c    = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc  = Buffer.concat([c.update(html, 'utf8'), c.final()]);
  const tag  = c.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

// ── Dashboard HTML ─────────────────────────────────────────────
function buildDashboard(dd) {
  const json = JSON.stringify(dd);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>NOWPEAK — CFO ダッシュボード</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Noto+Sans+JP:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><` + `/script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bk:#FAFAFA;--w:#0A0A0A;--g1:#F2F2F2;--g2:#EBEBEB;--g3:#E0E0E0;--g4:#AAAAAA;--g5:#777777;--g6:#555555;--acc:#F97316;--pos:#16a34a;--neg:#dc2626}
body{font-family:'Noto Sans JP','Space Mono',sans-serif;font-weight:300;background:var(--bk);color:var(--w);min-height:100vh;font-size:13px;line-height:1.6}
body::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.2;background-image:radial-gradient(circle,#D5D5D5 1px,transparent 1px);background-size:24px 24px;z-index:0}

/* Header */
.hdr{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:16px 40px;border-bottom:1px solid var(--g3);background:rgba(250,250,250,.96);backdrop-filter:blur(12px);gap:16px;flex-wrap:wrap}
.hdr-left{display:flex;align-items:center;gap:16px}
.hdr-dot{width:10px;height:10px;background:var(--acc);flex-shrink:0}
.hdr-brand{font-family:'Space Mono',monospace;font-size:13px;font-weight:700;letter-spacing:6px}
.hdr-sub{font-size:10px;color:var(--g5);letter-spacing:3px;font-weight:400;margin-top:2px}
.hdr-right{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.period-group{display:flex;border:1px solid var(--g3)}
.period-btn{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:2px;padding:6px 14px;border:none;background:transparent;color:var(--g5);cursor:pointer;transition:all .15s}
.period-btn.active{background:var(--w);color:var(--bk)}
.hdr-time{font-family:'Space Mono',monospace;font-size:10px;color:var(--g4);letter-spacing:1px}
.btn-icon{width:32px;height:32px;border:1px solid var(--g3);background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:14px;color:var(--g5);transition:all .2s}
.btn-icon:hover{border-color:var(--g4);color:var(--w)}
.hdr-refresh{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:2px;padding:7px 18px;border:1px solid var(--acc);color:var(--acc);background:transparent;cursor:pointer;transition:all .2s}
.hdr-refresh:hover{background:var(--acc);color:#fff}
.hdr-refresh:disabled{opacity:.4;cursor:not-allowed}

/* Alert */
.alert-bar{margin:16px 40px 0;padding:12px 20px;border:1px solid rgba(249,115,22,.3);background:rgba(249,115,22,.04);font-size:12px;color:var(--acc);display:flex;align-items:center;gap:10px}

/* Layout */
.main{position:relative;z-index:1;padding:28px 40px 60px;max-width:1600px;margin:0 auto}
.sec{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:4px;color:var(--g4);margin:36px 0 16px;display:flex;align-items:center;gap:14px;text-transform:uppercase}
.sec::before{content:'●';color:var(--acc);font-size:6px}
.sec::after{content:'';flex:1;height:1px;background:var(--g3)}

/* KPI Grid */
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--g3)}
.kpi{background:var(--bk);padding:28px 24px;position:relative;transition:background .15s;overflow:hidden}
.kpi:hover{background:var(--g1)}
.kpi-label{font-size:10px;color:var(--g5);letter-spacing:2px;font-weight:500;margin-bottom:12px}
.kpi-val{font-family:'Space Mono',monospace;font-size:38px;font-weight:700;letter-spacing:-2px;line-height:1;margin-bottom:10px;color:var(--w)}
.kpi-val.small{font-size:28px}
.kpi-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kpi-sub{font-family:'Space Mono',monospace;font-size:10px;color:var(--g4)}
.badge{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;padding:2px 7px;letter-spacing:.5px}
.badge.pos{background:rgba(22,163,74,.1);color:var(--pos)}
.badge.neg{background:rgba(220,38,38,.1);color:var(--neg)}
.badge.neu{background:var(--g2);color:var(--g5)}
.badge.warn{background:rgba(249,115,22,.1);color:var(--acc)}
.kpi-target{margin-top:10px}
.target-bar-wrap{height:3px;background:var(--g3);margin-top:4px;overflow:hidden}
.target-bar{height:100%;background:var(--acc);transition:width .4s}
.target-label{font-size:9px;color:var(--g4);letter-spacing:.5px;margin-top:2px;font-family:'Space Mono',monospace}
.kpi-acc{position:absolute;top:0;left:0;width:2px;height:100%;background:var(--acc);opacity:0;transition:opacity .15s}
.kpi:hover .kpi-acc{opacity:1}

/* Trend Chart */
.trend-cell{background:var(--bk);padding:28px;border:1px solid var(--g3)}
.chart-title{font-size:11px;color:var(--g5);letter-spacing:1px;font-weight:500;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between}
.chart-tag{font-family:'Space Mono',monospace;font-size:9px;color:var(--g4);border:1px solid var(--g3);padding:3px 8px;letter-spacing:1px}

/* Detail grid */
.detail-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:1px;background:var(--g3)}
.detail-cell{background:var(--bk);padding:24px}
.detail-title{font-size:11px;color:var(--g5);letter-spacing:1px;font-weight:500;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}

/* P/L */
.pl{border-top:1px solid var(--g3)}
.pl-row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--g2);font-size:12px}
.pl-row:last-child{border:none}
.pl-lbl{color:var(--g5)}
.pl-v{font-family:'Space Mono',monospace;font-size:12px;letter-spacing:.4px}
.pl-indent{padding-left:14px}
.pl-total{margin-top:10px;padding:14px 16px;background:var(--g1);display:flex;justify-content:space-between;align-items:center;font-weight:500}
.pl-total-v{font-family:'Space Mono',monospace;font-size:22px;font-weight:700;letter-spacing:-1px}

/* B/S */
.bs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--g3);margin-top:20px}
.bs-cell{background:var(--bk);padding:14px}
.bs-label{font-size:9px;color:var(--g4);letter-spacing:1px;margin-bottom:4px;font-weight:400}
.bs-val{font-family:'Space Mono',monospace;font-size:14px;font-weight:700}

/* Tables */
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:8px 10px;font-size:9px;font-weight:700;letter-spacing:2px;color:var(--g4);border-bottom:1px solid var(--g3);font-family:'Space Mono',monospace}
td{padding:9px 10px;border-bottom:1px solid var(--g2);font-size:12px}
tr:last-child td{border:none}
tr:hover td{background:var(--g1)}
.tr{text-align:right;font-family:'Space Mono',monospace;font-size:12px}
.bdg{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;padding:2px 7px;border:1px solid;display:inline-block}
.bdg-r{color:var(--acc);border-color:rgba(249,115,22,.4)}
.bdg-g{color:var(--g6);border-color:var(--g4)}

/* Charts side-by-side */
.chart-grid2{display:grid;grid-template-columns:1fr 1.6fr;gap:1px;background:var(--g3)}

/* Insights */
.insight-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--g3)}
.insight{background:var(--bk);padding:24px;border-left:2px solid var(--g3)}
.insight-tag{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:2px;margin-bottom:10px}
.insight-tag.high{color:var(--acc)}
.insight-tag.mid{color:#f59e0b}
.insight-tag.low{color:var(--g5)}
.insight-body{font-size:12px;color:var(--g5);line-height:1.75;font-weight:300}
.insight-body strong{color:var(--w);font-weight:500}

/* Expense */
.exp-total{margin-top:14px;padding-top:10px;border-top:1px solid var(--g3);display:flex;justify-content:space-between;font-size:12px}

/* Modal */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(250,250,250,.9);z-index:200;align-items:center;justify-content:center;backdrop-filter:blur(4px)}
.modal-overlay.open{display:flex}
.modal{background:var(--bk);border:1px solid var(--g3);padding:40px;max-width:400px;width:100%;position:relative}
.modal-title{font-family:'Space Mono',monospace;font-size:11px;font-weight:700;letter-spacing:3px;margin-bottom:28px}
.modal-field{margin-bottom:20px}
.modal-label{font-size:10px;color:var(--g5);letter-spacing:2px;margin-bottom:8px;display:block}
.modal-input{width:100%;background:transparent;border:none;border-bottom:1px solid var(--g3);color:var(--w);font-family:'Space Mono',monospace;font-size:16px;padding:8px 0;outline:none;transition:border-color .2s}
.modal-input:focus{border-bottom-color:var(--acc)}
.modal-note{font-size:10px;color:var(--g4);margin-top:4px}
.modal-save{font-family:'Space Mono',monospace;font-size:10px;font-weight:700;letter-spacing:3px;padding:12px 32px;border:1px solid var(--w);color:var(--w);background:transparent;cursor:pointer;transition:all .2s;margin-top:8px}
.modal-save:hover{background:var(--w);color:var(--bk)}
.modal-close{position:absolute;top:16px;right:16px;background:none;border:none;font-size:18px;cursor:pointer;color:var(--g4);line-height:1}
.modal-close:hover{color:var(--w)}

/* Footer / Toast */
.ftr{text-align:center;padding:40px;font-family:'Space Mono',monospace;font-size:9px;color:var(--g3);letter-spacing:2px}
#toast{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--w);color:var(--bk);font-family:'Space Mono',monospace;font-size:10px;letter-spacing:2px;padding:10px 24px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:300;white-space:nowrap}
#toast.show{opacity:1}
@media(max-width:1100px){.kpi-grid,.detail-grid,.chart-grid2,.insight-grid{grid-template-columns:1fr}.hdr{padding:14px 20px}.main{padding:20px}.kpi-val{font-size:28px}}
</style>
</head>
<body>

<header class="hdr">
  <div class="hdr-left">
    <div class="hdr-dot"></div>
    <div>
      <div class="hdr-brand">NOWPEAK</div>
      <div class="hdr-sub">CFO ダッシュボード</div>
    </div>
  </div>
  <div class="hdr-right">
    <div class="period-group">
      <button class="period-btn active" id="p3" onclick="setPeriod(3)">3M</button>
      <button class="period-btn" id="p6" onclick="setPeriod(6)">6M</button>
    </div>
    <span class="hdr-time" id="updTime"></span>
    <button class="btn-icon" onclick="openSettings()" title="予算設定">⚙</button>
    <button class="hdr-refresh" id="refreshBtn" onclick="triggerUpdate()">データ更新</button>
  </div>
</header>

<div id="alertBar"></div>

<div class="main">

  <div class="sec">経営パルス</div>
  <div class="kpi-grid">
    <div class="kpi" id="kpi0"><div class="kpi-acc"></div>
      <div class="kpi-label">今月売上</div>
      <div class="kpi-val small" id="kv0">—</div>
      <div class="kpi-row"><span class="kpi-sub" id="ks0"></span><span class="badge" id="kb0"></span></div>
      <div class="kpi-target" id="kt0"></div>
    </div>
    <div class="kpi" id="kpi1"><div class="kpi-acc"></div>
      <div class="kpi-label">営業利益率</div>
      <div class="kpi-val" id="kv1">—</div>
      <div class="kpi-row"><span class="kpi-sub" id="ks1"></span><span class="badge" id="kb1"></span></div>
      <div class="kpi-target" id="kt1"></div>
    </div>
    <div class="kpi" id="kpi2"><div class="kpi-acc"></div>
      <div class="kpi-label">現預金残高</div>
      <div class="kpi-val small" id="kv2">—</div>
      <div class="kpi-row"><span class="kpi-sub" id="ks2"></span><span class="badge" id="kb2"></span></div>
    </div>
    <div class="kpi" id="kpi3"><div class="kpi-acc"></div>
      <div class="kpi-label">今月コスト</div>
      <div class="kpi-val small" id="kv3">—</div>
      <div class="kpi-row"><span class="kpi-sub" id="ks3"></span><span class="badge" id="kb3"></span></div>
    </div>
  </div>

  <div class="sec">月次推移</div>
  <div class="trend-cell">
    <div class="chart-title">売上 / 営業利益 / 利益率<span class="chart-tag" id="trendTag">3ヶ月</span></div>
    <div style="height:280px"><canvas id="cTrend"></canvas></div>
  </div>

  <div class="sec">財務詳細</div>
  <div class="detail-grid">
    <div class="detail-cell">
      <div class="detail-title">損益計算書<span class="bdg bdg-g" id="plBadge">当月</span></div>
      <div class="pl" id="plTable"></div>
      <div class="pl-total"><span>営業利益</span><span class="pl-total-v" id="plTotalV">—</span></div>
      <div style="margin-top:28px">
        <div class="detail-title">貸借対照表<span class="bdg bdg-g">最新</span></div>
        <div class="bs-grid" id="bsGrid"></div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;background:var(--g3);gap:1px">
      <div class="detail-cell" style="flex:1">
        <div class="chart-title">費用構成<span class="chart-tag" id="costTag">当月</span></div>
        <div style="height:200px"><canvas id="cCost"></canvas></div>
      </div>
      <div class="detail-cell" style="flex:1">
        <div class="detail-title">クライアント別売上<span class="bdg bdg-g" id="clientBadge">当月</span></div>
        <table>
          <thead><tr><th>クライアント</th><th class="tr">売上</th><th class="tr">構成比</th></tr></thead>
          <tbody id="clientBody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="sec">未払経費</div>
  <div class="detail-cell" style="background:var(--bk);border:1px solid var(--g3)">
    <div class="detail-title">未払経費一覧<span class="bdg bdg-r" id="expBadge"></span></div>
    <table>
      <thead><tr><th>日付</th><th>内容</th><th class="tr">金額</th><th>ステータス</th></tr></thead>
      <tbody id="expBody"></tbody>
    </table>
    <div class="exp-total"><span style="color:var(--g5)" id="expCount"></span><span id="expTotal" style="font-family:'Space Mono',monospace;font-weight:700;color:var(--acc)"></span></div>
  </div>

  <div class="sec">経営インサイト</div>
  <div class="insight-grid" id="insightGrid"></div>

</div>

<!-- Settings Modal -->
<div class="modal-overlay" id="settingsModal">
  <div class="modal">
    <button class="modal-close" onclick="closeSettings()">×</button>
    <div class="modal-title">予算設定</div>
    <div class="modal-field">
      <label class="modal-label">月次売上目標 (万円)</label>
      <input class="modal-input" type="number" id="budgetRev" placeholder="例: 500">
      <div class="modal-note">入力例: 500 → ¥500万</div>
    </div>
    <div class="modal-field">
      <label class="modal-label">目標営業利益率 (%)</label>
      <input class="modal-input" type="number" id="budgetMargin" placeholder="例: 20">
      <div class="modal-note">入力例: 20 → 20%</div>
    </div>
    <button class="modal-save" onclick="saveBudget()">保存</button>
  </div>
</div>

<div class="ftr" id="ftr"></div>
<div id="toast"></div>

<script>
window._DD = ${json};
const _PAT  = '${GH_PAT}';
const _REPO = '${GH_REPO}';

// ── Helpers ────────────────────────────────────────────────────
const yen  = n => '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const yenM = n => { const v = Math.abs(n); return v >= 1e6 ? '¥'+(v/1e6).toFixed(1)+'M' : '¥'+(v/1e4).toFixed(0)+'万'; };
const pct  = n => n.toFixed(1) + '%';
const mom  = (cur, prev) => prev === 0 ? null : Math.round((cur - prev) / Math.abs(prev) * 1000) / 10;

let period = 3;
let trendChart = null, costChart = null;

// ── Period selector ────────────────────────────────────────────
function setPeriod(n) {
  period = n;
  document.getElementById('p3').classList.toggle('active', n === 3);
  document.getElementById('p6').classList.toggle('active', n === 6);
  renderAll();
}

function getSlice() { return _DD.months.slice(-period); }
function getCurrent() { return _DD.months[_DD.months.length - 1]; }
function getPrev() { return _DD.months[_DD.months.length - 2] || null; }

// ── Budget ─────────────────────────────────────────────────────
function getBudget() {
  try { return JSON.parse(localStorage.getItem('np_budget') || '{}'); } catch { return {}; }
}
function openSettings() {
  const b = getBudget();
  document.getElementById('budgetRev').value    = b.revenue || '';
  document.getElementById('budgetMargin').value = b.margin  || '';
  document.getElementById('settingsModal').classList.add('open');
}
function closeSettings() { document.getElementById('settingsModal').classList.remove('open'); }
function saveBudget() {
  const rev    = parseFloat(document.getElementById('budgetRev').value)    || 0;
  const margin = parseFloat(document.getElementById('budgetMargin').value) || 0;
  localStorage.setItem('np_budget', JSON.stringify({ revenue: rev * 1e4, margin }));
  closeSettings();
  renderKPIs();
  toast('✓ 予算設定を保存しました');
}
document.getElementById('settingsModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeSettings(); });

// ── KPIs ───────────────────────────────────────────────────────
function renderKPIs() {
  const cur  = getCurrent();
  const prev = getPrev();
  const bgt  = getBudget();

  // Revenue
  const revMoM = prev ? mom(cur.revenue, prev.revenue) : null;
  document.getElementById('kv0').textContent = yenM(cur.revenue);
  document.getElementById('ks0').textContent = prev ? yen(prev.revenue) + ' (前月)' : '';
  setBadge('kb0', revMoM);
  if (bgt.revenue > 0) {
    const pctVal = Math.min(100, cur.revenue / bgt.revenue * 100);
    document.getElementById('kt0').innerHTML =
      '<div class="target-bar-wrap"><div class="target-bar" style="width:'+pctVal+'%"></div></div>' +
      '<div class="target-label">目標比 '+pct(pctVal)+' (目標 '+yenM(bgt.revenue)+')</div>';
  } else {
    document.getElementById('kt0').innerHTML = '<div class="target-label" style="color:var(--acc)">⚙ 予算設定で目標を入力</div>';
  }

  // Margin
  const marMoM = prev ? mom(cur.opMargin, prev.opMargin) : null;
  document.getElementById('kv1').textContent = pct(cur.opMargin);
  document.getElementById('ks1').textContent = prev ? pct(prev.opMargin) + ' (前月)' : '';
  setBadge('kb1', marMoM);
  if (bgt.margin > 0) {
    const diff = cur.opMargin - bgt.margin;
    const el   = document.getElementById('kt1');
    el.innerHTML = '<div class="target-label">目標 '+pct(bgt.margin)+' / 差 <span style="color:'+(diff>=0?'var(--pos)':'var(--neg)')+';">'+(diff>=0?'+':'')+pct(diff)+'</span></div>';
  } else {
    document.getElementById('kt1').innerHTML = '<div class="target-label" style="color:var(--acc)">⚙ 予算設定で目標を入力</div>';
  }

  // Cash
  const bs = _DD.bs;
  const runway = (bs.opex6mAvg > 0) ? Math.round((bs.cash + bs.bank) / bs.opex6mAvg * 10) / 10 : null;
  document.getElementById('kv2').textContent = yenM(bs.cash + bs.bank);
  document.getElementById('ks2').textContent = '現金 '+yen(bs.cash)+' / 銀行 '+yen(bs.bank);
  const rb = document.getElementById('kb2');
  if (runway !== null) { rb.textContent = 'Runway '+runway+'ヶ月'; rb.className = 'badge '+(runway>6?'pos':runway>3?'warn':'neg'); }

  // Cost
  const costMoM = prev ? mom(cur.opex, prev.opex) : null;
  document.getElementById('kv3').textContent = yenM(cur.opex);
  document.getElementById('ks3').textContent = prev ? yen(prev.opex) + ' (前月)' : '';
  setBadge('kb3', costMoM, true);
}
function setBadge(id, val, invert = false) {
  const el = document.getElementById(id);
  if (val === null) { el.textContent = ''; el.className = 'badge'; return; }
  const up = val > 0;
  el.textContent = (up ? '▲' : '▼') + Math.abs(val) + '%';
  el.className   = 'badge ' + ((up !== invert) ? 'pos' : 'neg');
}

// ── Trend Chart ────────────────────────────────────────────────
function renderTrend() {
  const slice  = getSlice();
  const labels = slice.map(m => m.label);
  const revs   = slice.map(m => m.revenue);
  const ops    = slice.map(m => m.opIncome);
  const margins= slice.map(m => m.opMargin);
  document.getElementById('trendTag').textContent = period + 'ヶ月';

  if (trendChart) trendChart.destroy();
  trendChart = new Chart(document.getElementById('cTrend'), {
    data: {
      labels,
      datasets: [
        { type: 'bar',  label: '売上',     data: revs,    backgroundColor: 'rgba(249,115,22,.15)', borderColor: '#F97316', borderWidth: 2, yAxisID: 'y' },
        { type: 'bar',  label: '営業利益', data: ops,     backgroundColor: ops.map(v=>v>=0?'rgba(10,10,10,.7)':'rgba(220,38,38,.6)'), yAxisID: 'y' },
        { type: 'line', label: '利益率(%)',data: margins, borderColor: '#F97316', backgroundColor: 'transparent', pointBackgroundColor: '#F97316', pointRadius: 5, tension: .3, yAxisID: 'y2', borderWidth: 2 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'top', labels: { color: '#777', font: { size: 10 }, boxWidth: 10, boxHeight: 10, padding: 16 } },
        tooltip: { callbacks: { label: ctx => ctx.dataset.yAxisID === 'y2' ? ' '+ctx.parsed.y+'%' : ' '+yen(ctx.parsed.y) } }
      },
      scales: {
        y:  { grid: { color: '#EBEBEB' }, ticks: { color: '#888', font: { size: 10 }, callback: v => '¥'+(v/1e4).toFixed(0)+'万' } },
        y2: { position: 'right', grid: { display: false }, ticks: { color: '#F97316', font: { size: 10 }, callback: v => v+'%' } }
      }
    }
  });
}

// ── P/L Table ──────────────────────────────────────────────────
function renderPL() {
  const cur = getCurrent();
  const pv  = getPrev();
  function row(label, val, indent, pval) {
    const change = pv && pval !== undefined ? (val - pval) : null;
    const chHtml = change !== null ? '<span style="font-size:10px;color:'+(change<=0?'var(--pos)':'var(--neg)')+';">'+(change<=0?'▼':'▲')+''+yen(Math.abs(change))+'</span>' : '';
    return '<div class="pl-row'+(indent?' pl-indent':'')+'"><span class="pl-lbl">'+label+'</span><span class="pl-v">'+yen(val)+' '+chHtml+'</span></div>';
  }
  document.getElementById('plTable').innerHTML =
    row('売上高',   cur.revenue,   false, pv?.revenue) +
    row('外注費',   cur.outsource, true,  pv?.outsource) +
    row('役員報酬', cur.officers,  true,  pv?.officers) +
    row('給料手当', cur.salary,    true,  pv?.salary) +
    row('法定福利費',cur.welfare,  true,  pv?.welfare) +
    row('地代家賃', cur.rent,      true,  pv?.rent) +
    row('支払報酬料',cur.fee,      true,  pv?.fee) +
    row('通信費',   cur.comm,      true,  pv?.comm) +
    row('会議費',   cur.meeting,   true,  pv?.meeting) +
    row('交際費',   cur.entertain, true,  pv?.entertain) +
    row('その他',   cur.other,     true,  pv?.other) +
    '<div class="pl-row" style="border-top:1px solid var(--g4);margin-top:6px"><span style="font-weight:500">販管費合計</span><span class="pl-v" style="color:var(--acc)">' + yen(cur.opex) + '</span></div>';
  document.getElementById('plTotalV').textContent = (cur.opIncome >= 0 ? '+' : '') + yen(cur.opIncome);
  document.getElementById('plTotalV').style.color = cur.opIncome >= 0 ? 'var(--w)' : 'var(--neg)';
  document.getElementById('plBadge').textContent = getCurrent().label;
}

// ── B/S ───────────────────────────────────────────────────────
function renderBS() {
  const bs = _DD.bs;
  const eq = bs.totalAssets > 0 ? (bs.netAssets / bs.totalAssets * 100).toFixed(1) : '0.0';
  const cr = bs.currentLiab > 0 ? ((bs.cash+bs.bank) / bs.currentLiab * 100).toFixed(1) : '—';
  document.getElementById('bsGrid').innerHTML = [
    ['総資産',    yen(bs.totalAssets), ''],
    ['総負債',    yen(bs.totalLiab),   'color:var(--acc)'],
    ['純資産',    yen(bs.netAssets),   ''],
    ['自己資本比率', eq+'%',           ''],
    ['売掛金',    yen(bs.ar),          ''],
    ['流動比率',  cr+'%',              ''],
  ].map(([l,v,s]) => '<div class="bs-cell"><div class="bs-label">'+l+'</div><div class="bs-val" style="'+s+'">'+v+'</div></div>').join('');
}

// ── Cost donut ────────────────────────────────────────────────
function renderCost() {
  const cur = getCurrent();
  document.getElementById('costTag').textContent = cur.label;
  if (costChart) costChart.destroy();
  costChart = new Chart(document.getElementById('cCost'), {
    type: 'doughnut',
    data: {
      labels: ['外注費','役員報酬','給料手当','法定福利費','地代家賃','支払報酬料','その他'],
      datasets: [{ data: [cur.outsource,cur.officers,cur.salary,cur.welfare,cur.rent,cur.fee,cur.other+cur.comm+cur.meeting+cur.entertain],
        backgroundColor: ['#F97316','#111','#444','#777','#999','#bbb','#ddd'], borderWidth: 0, hoverOffset: 4 }]
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: '66%',
      plugins: {
        legend: { position: 'right', labels: { color: '#555', font: { size: 10 }, padding: 6, boxWidth: 8, boxHeight: 8 } },
        tooltip: { callbacks: { label: ctx => { const v=ctx.parsed, t=ctx.dataset.data.reduce((a,b)=>a+b,0); return ' '+yen(v)+' ('+(v/t*100).toFixed(1)+'%)'; } } }
      }
    }
  });
}

// ── Client table ───────────────────────────────────────────────
function renderClients() {
  const slice = getSlice();
  // Aggregate clients across period
  const map = {};
  for (const m of slice) {
    for (const [name, amt] of (m.clients || [])) {
      map[name] = (map[name] || 0) + amt;
    }
  }
  const clients    = Object.entries(map).sort((a,b) => b[1]-a[1]);
  const totalAmt   = clients.reduce((s,[,v])=>s+v,0);
  document.getElementById('clientBadge').textContent = period === 1 ? '当月' : period+'ヶ月計';
  document.getElementById('clientBody').innerHTML = clients.slice(0,8).map(([name, amt]) => {
    const p = totalAmt > 0 ? (amt/totalAmt*100).toFixed(1) : '0.0';
    const cls = p >= 15 ? 'bdg bdg-r' : 'bdg bdg-g';
    return '<tr><td>'+name+'</td><td class="tr">'+yen(amt)+'</td><td class="tr"><span class="'+cls+'">'+p+'%</span></td></tr>';
  }).join('');
}

// ── Expenses ───────────────────────────────────────────────────
function renderExpenses() {
  const uns = _DD.unsettled;
  const total = uns.reduce((s,d)=>s+d.amount,0);
  document.getElementById('expBadge').textContent = total > 0 ? yen(total) : '精算済';
  document.getElementById('expCount').textContent = '合計 '+uns.length+'件 — 月末精算期限';
  document.getElementById('expTotal').textContent = yen(total);
  document.getElementById('expBody').innerHTML = uns.slice(0,8).map(d =>
    '<tr><td style="color:var(--g4)">'+d.date+'</td><td>'+d.desc+'</td><td class="tr">'+yen(d.amount)+'</td><td><span class="bdg bdg-r" style="font-size:9px">未払</span></td></tr>'
  ).join('') || '<tr><td colspan="4" style="color:var(--g4);text-align:center;padding:20px">未払経費なし</td></tr>';
  if (total > 0) {
    document.getElementById('alertBar').innerHTML = '<div class="alert-bar">● <strong>要対応</strong> — 未払経費 '+yen(total)+'（'+uns.length+'件）月末精算期限</div>';
  }
}

// ── Insights ───────────────────────────────────────────────────
function renderInsights() {
  const cur  = getCurrent();
  const pv   = getPrev();
  const bgt  = getBudget();
  const slice = getSlice();

  // Aggregate period clients
  const map = {};
  for (const m of slice) for (const [n,v] of (m.clients||[])) map[n]=(map[n]||0)+v;
  const clients = Object.entries(map).sort((a,b)=>b[1]-a[1]);
  const totalCl = clients.reduce((s,[,v])=>s+v,0);

  const outsourcePct = cur.revenue > 0 ? (cur.outsource/cur.revenue*100).toFixed(1) : '0.0';
  const top2pct      = clients.length >= 2 && totalCl > 0 ? ((clients[0][1]+clients[1][1])/totalCl*100).toFixed(1) : null;
  const revTrend     = slice.length >= 2 ? mom(slice[slice.length-1].revenue, slice[0].revenue) : null;

  const insights = [];

  // Revenue trend insight
  if (revTrend !== null) {
    const up = revTrend > 0;
    insights.push({ level: up ? 'mid' : 'high', tag: up ? '● 売上成長' : '● 売上低下',
      body: '直近'+period+'ヶ月で売上が<strong>'+Math.abs(revTrend)+'%'+(up?'増加':'減少')+'</strong>。' +
        (up ? '成長モメンタムを維持しつつ利益率'+pct(cur.opMargin)+'の水準管理が重要。'
            : '要因分析と新規パイプライン強化が急務。現預金Runwayを確認しキャッシュ管理を徹底すること。') });
  }

  // Client concentration
  if (top2pct !== null) {
    const risk = parseFloat(top2pct) >= 50;
    insights.push({ level: risk ? 'high' : 'mid', tag: '● 売上集中リスク',
      body: '上位2社（'+(clients[0]?.[0])+'・'+(clients[1]?.[0])+'）で'+period+'ヶ月売上の<strong>'+top2pct+'%</strong>を占有。' +
        (risk ? '解約・単価変動でキャッシュに直撃。新規獲得と既存深耕を並行して推進すること。' :
                '集中度は許容範囲内。引き続きポートフォリオ分散を意識した営業活動を。') });
  }

  // Margin vs budget or structure
  const bgtMargin = bgt.margin || 0;
  if (bgtMargin > 0) {
    const diff = cur.opMargin - bgtMargin;
    insights.push({ level: diff >= 0 ? 'low' : 'high', tag: diff >= 0 ? '● 利益率達成' : '● 利益率未達',
      body: '目標利益率'+pct(bgtMargin)+'に対して実績<strong>'+pct(cur.opMargin)+'</strong>（差 '+(diff>=0?'+':'')+pct(diff)+'）。' +
        (diff >= 0 ? '外注費コントロールを維持し、この水準を堅守すること。' :
                     '外注費'+outsourcePct+'%が主因。案件単価の見直しと内製比率引き上げを検討。') });
  } else {
    insights.push({ level: 'low', tag: '● コスト構造',
      body: '外注費が売上の<strong>'+outsourcePct+'%</strong>を占め変動費型コスト構造。売上増に連動して利益が出やすい一方、粗利改善には単価交渉か内製化が有効。' });
  }

  document.getElementById('insightGrid').innerHTML = insights.map(i =>
    '<div class="insight" style="border-left-color:'+(i.level==='high'?'var(--acc)':i.level==='mid'?'#f59e0b':'var(--g4)')+'">' +
    '<div class="insight-tag '+i.level+'">'+i.tag+'</div>' +
    '<div class="insight-body">'+i.body+'</div></div>'
  ).join('');
}

// ── Render all ─────────────────────────────────────────────────
function renderAll() {
  renderKPIs();
  renderTrend();
  renderPL();
  renderBS();
  renderCost();
  renderClients();
  renderExpenses();
  renderInsights();
}

// ── Toast ──────────────────────────────────────────────────────
function toast(msg, ms=4000) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── Data refresh ───────────────────────────────────────────────
async function triggerUpdate() {
  if (!_PAT) { toast('PAT が未設定です'); return; }
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true; btn.textContent = '更新中...';
  try {
    const r = await fetch('https://api.github.com/repos/'+_REPO+'/actions/workflows/update.yml/dispatches', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer '+_PAT, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    });
    if (r.status === 204) {
      toast('✓ 更新開始。1〜2分後にページをリロードしてください。', 7000);
    } else {
      const body = await r.json().catch(() => ({}));
      toast('エラー '+r.status+': '+(body.message||'PATの権限を確認'));
    }
  } catch(e) { toast('接続エラー: '+e.message); }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'データ更新'; }, 10000);
}

// ── Init ───────────────────────────────────────────────────────
document.getElementById('updTime').textContent = '更新: ' + _DD.updatedAt;
document.getElementById('ftr').textContent = 'NOWPEAK — FREEE API — GITHUB ACTIONS — ' + _DD.updatedAt;
renderAll();
<` + `/script>
</body>
</html>`;
}

// ── Login page ─────────────────────────────────────────────────
function buildLogin(payload) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>NOWPEAK — アクセス</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Noto+Sans+JP:wght@300;400;500&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Noto Sans JP','Space Mono',sans-serif;font-weight:300;background:#FAFAFA;color:#0A0A0A;min-height:100vh;display:flex;align-items:center;justify-content:center}
body::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.6;background-image:radial-gradient(circle,#D5D5D5 1px,transparent 1px);background-size:24px 24px}
.gate{position:relative;z-index:1;text-align:center;width:100%;max-width:400px;padding:40px 24px}
.dot{width:10px;height:10px;background:#F97316;margin:0 auto 36px}
.brand{font-family:'Space Mono',monospace;font-size:14px;font-weight:700;letter-spacing:8px;margin-bottom:6px}
.sub{font-size:11px;color:#888;letter-spacing:3px;margin-bottom:48px}
.field{position:relative;margin-bottom:36px}
.field input{width:100%;background:transparent;border:none;border-bottom:1px solid #CCC;color:#0A0A0A;font-family:'Space Mono',monospace;font-size:13px;letter-spacing:2px;padding:12px 0;outline:none;text-align:center}
.field input::placeholder{color:#BBB;letter-spacing:3px;font-family:'Noto Sans JP',sans-serif}
.field input:focus{border-bottom-color:#F97316}
.line{position:absolute;bottom:0;left:50%;width:0;height:1px;background:#F97316;transition:all .3s;transform:translateX(-50%)}
.field input:focus~.line{width:100%}
.btn{font-family:'Space Mono',monospace;font-size:10px;font-weight:700;letter-spacing:4px;padding:14px 48px;border:1px solid #F97316;color:#F97316;background:transparent;cursor:pointer;transition:all .2s}
.btn:hover{background:#F97316;color:#fff}
.err{margin-top:24px;font-size:11px;color:#F97316;letter-spacing:1px;opacity:0;transition:opacity .3s}
.err.show{opacity:1}
.dots{margin-top:48px;display:flex;justify-content:center;gap:8px}
.dots span{width:4px;height:4px;background:#D5D5D5}
.dots span:nth-child(5){background:#F97316}
@keyframes shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
.shake{animation:shake .3s ease}
</style>
</head>
<body>
<div class="gate" id="gate">
  <div class="dot"></div>
  <div class="brand">NOWPEAK</div>
  <div class="sub">CFO ダッシュボード</div>
  <div class="field">
    <input type="password" id="pw" placeholder="パスワード" autocomplete="off" onkeydown="if(event.key==='Enter')go()">
    <div class="line"></div>
  </div>
  <button class="btn" onclick="go()">アクセス</button>
  <div class="err" id="err">認証に失敗しました</div>
  <div class="dots"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
</div>
<script>
const D='${payload}';
async function go(){
  const pw=document.getElementById('pw').value;if(!pw)return;
  document.getElementById('err').classList.remove('show');
  try{
    const raw=Uint8Array.from(atob(D),c=>c.charCodeAt(0));
    const salt=raw.slice(0,16),iv=raw.slice(16,28),tag=raw.slice(28,44),ct=raw.slice(44);
    const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);
    const combined=new Uint8Array(ct.length+16);combined.set(ct);combined.set(tag,ct.length);
    const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,combined);
    document.open();document.write(new TextDecoder().decode(dec));document.close();
  }catch(e){
    document.getElementById('err').classList.add('show');
    const g=document.getElementById('gate');g.classList.add('shake');
    setTimeout(()=>g.classList.remove('shake'),300);
    document.getElementById('pw').value='';document.getElementById('pw').focus();
  }
}
document.getElementById('pw').focus();
<` + `/script>
</body>
</html>`;
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log('━'.repeat(50));
  console.log('  NOW PEAK CFO Dashboard — 生成開始');
  console.log('━'.repeat(50));

  const token = await getToken();
  const jst   = new Date(Date.now() + 9 * 3600000);
  const updatedAt = jst.toISOString().slice(0, 16).replace('T', ' ') + ' JST';

  // 6ヶ月分の月情報を計算
  const months6 = getMonths(jst, 6);
  console.log(`[info] 対象: ${months6[0].key} 〜 ${months6[months6.length-1].key}`);

  // 6ヶ月分のP/Lを並列取得
  const plResults = await Promise.all(months6.map(m =>
    freeeGet(token, '/reports/trial_pl', { fiscal_year: m.fy, start_month: m.fm, end_month: m.fm })
  ));

  // 6ヶ月分のdeals + BSを並列取得
  const periodStart = months6[0].dateStr;
  const [incomeAll, expenseAll, bs] = await Promise.all([
    freeeGet(token, '/deals', { type: 'income',  start_issue_date: periodStart, limit: 100 }),
    freeeGet(token, '/deals', { type: 'expense', start_issue_date: periodStart, limit: 100 }),
    freeeGet(token, '/reports/trial_bs', { fiscal_year: months6[months6.length-1].fy }),
  ]);
  console.log('[freee] ✓ 全データ取得完了');

  // Dealsを月別に振り分け
  const dealsByMonth = {};
  for (const m of months6) dealsByMonth[m.key] = [];
  for (const d of incomeAll?.deals || []) {
    const key = d.issue_date?.slice(0, 7).replace('-', '/');
    if (dealsByMonth[key]) dealsByMonth[key].push(d);
  }

  // 月別データを構築
  const monthsData = months6.map((m, i) => ({
    key:     m.key,
    label:   m.label,
    clients: buildClientMap(dealsByMonth[m.key]),
    ...extractPL(plResults[i]),
  }));

  // B/S 抽出
  const bsB = bs?.trial_bs?.balances || [];
  let cash = 0, bank = 0, ap = 0;
  for (const b of bsB) {
    if (b.account_category_name === '現金・預金' && !b.total_line) {
      if (b.account_item_name === '現金') cash = b.closing_balance || 0;
      else bank += b.closing_balance || 0;
    }
    if (b.account_category_name === '他流動負債' && !b.total_line)
      ap += b.closing_balance || 0;
  }
  const totalAssets = getB(bsB, '資産',   true);
  const totalLiab   = getB(bsB, '負債',   true);
  const netAssets   = getB(bsB, '純資産', true);
  const capital     = getB(bsB, '資本金');
  const ar          = getB(bsB, '売掛金');
  const currentLiab = getB(bsB, '流動負債', true);

  // 6ヶ月平均月次opexをRunway計算用に
  const opex6mAvg = monthsData.reduce((s, m) => s + m.opex, 0) / monthsData.length;

  // 未払経費
  const unsettled = (expenseAll?.deals || [])
    .filter(d => d.payment_status !== 'settled')
    .map(d => ({
      date:   d.issue_date || '',
      desc:   (d.details?.[0]?.description || '—').slice(0, 20),
      amount: Math.abs(d.amount || 0),
    }));

  const dashData = {
    updatedAt,
    months: monthsData,
    bs: { totalAssets, totalLiab, netAssets, capital, ar, cash, bank, ap, currentLiab, opex6mAvg },
    unsettled,
  };

  const dashboard = buildDashboard(dashData);
  console.log(`[build] ✓ ダッシュボード HTML: ${(dashboard.length / 1024).toFixed(1)} KB`);

  const payload = encrypt(dashboard);
  console.log(`[crypt] ✓ AES-256-GCM 暗号化: ${(payload.length / 1024).toFixed(1)} KB`);

  const html = buildLogin(payload);
  const out  = path.join(__dirname, 'index.html');
  fs.writeFileSync(out, html, 'utf8');
  console.log(`[write] ✓ ${out} (${(html.length / 1024).toFixed(1)} KB)`);
  console.log('━'.repeat(50));
  console.log('  完了');
  console.log('━'.repeat(50));
}

main().catch(e => { console.error('[error]', e.message); process.exit(1); });
