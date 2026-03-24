#!/usr/bin/env node
'use strict';
/**
 * NOW PEAK CFO Dashboard — 動的生成スクリプト
 * freee API からリアルタイムデータを取得し、AES-256-GCM で暗号化した
 * index.html を生成します。GitHub Actions から自動実行されます。
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const https  = require('https');

// ── 設定 ──────────────────────────────────────────────────────
const COMPANY_ID  = 12275002;
const FISCAL_YEAR = 2025;
const PASSWORD    = process.env.DASHBOARD_PASSWORD || 'NPCashdata';
const GH_PAT      = process.env.GH_PAT            || '';
const GH_REPO     = 'NP-Backoffice/cfo-dashboard';

// ── HTTP ヘルパー ──────────────────────────────────────────────
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

// ── freee: アクセストークン取得 ────────────────────────────────
async function getToken() {
  const params = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: process.env.FREEE_REFRESH_TOKEN,
    client_id:     process.env.FREEE_CLIENT_ID,
    client_secret: process.env.FREEE_CLIENT_SECRET,
  }).toString();

  const r = await request({
    hostname: 'accounts.secure.freee.co.jp',
    path:     '/public_api/token',
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(params),
    },
  }, params);

  if (r.status !== 200)
    throw new Error(`トークン取得失敗 ${r.status}: ${JSON.stringify(r.body)}`);
  console.log('[freee] ✓ アクセストークン取得');
  return r.body.access_token;
}

// ── freee: GET ─────────────────────────────────────────────────
async function freeeGet(token, endpoint, query = {}) {
  const qs = new URLSearchParams({ company_id: COMPANY_ID, ...query }).toString();
  const r  = await request({
    hostname: 'api.freee.co.jp',
    path:     `/api/1${endpoint}?${qs}`,
    method:   'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept':        'application/json',
    },
  });
  if (r.status !== 200) { console.warn(`[freee] ${endpoint} → ${r.status}`); return null; }
  return r.body;
}

// ── データ抽出ヘルパー ─────────────────────────────────────────
const get = (arr, name, total = false) => {
  for (const b of arr || []) {
    if (total && b.total_line && b.account_category_name === name) return b.closing_balance || 0;
    if (!total && b.account_item_name === name)                     return b.closing_balance || 0;
  }
  return 0;
};

// ── フォーマット ───────────────────────────────────────────────
const yen  = n => '¥' + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const yenM = n => '¥' + (Math.abs(n) / 1e6).toFixed(1) + 'M';

// ── 暗号化 ────────────────────────────────────────────────────
function encrypt(html) {
  const salt   = crypto.randomBytes(16);
  const key    = crypto.pbkdf2Sync(PASSWORD, salt, 100000, 32, 'sha256');
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(html, 'utf8'), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

// ── ダッシュボード HTML ────────────────────────────────────────
function buildDashboard(data, updatedAt) {
  const { pl, bs, income, expense } = data;
  const plB = pl?.trial_pl?.balances  || [];
  const bsB = bs?.trial_bs?.balances  || [];

  /* P/L */
  const revenue   = get(plB, '売上高',         true);
  const opex      = get(plB, '販売管理費',      true);
  const opIncome  = get(plB, '営業損益金額',    true);
  const outsource = get(plB, '外注費');
  const officers  = get(plB, '役員報酬');
  const welfare   = get(plB, '法定福利費');
  const comm      = get(plB, '通信費');
  const meeting   = get(plB, '会議費');
  const rent      = get(plB, '地代家賃');
  const fee       = get(plB, '支払報酬料');
  const salary    = get(plB, '給料手当');
  const entertain = get(plB, '交際費');
  const otherOpex = opex - outsource - officers - welfare - comm - meeting - rent - fee - salary - entertain;
  const opMargin  = revenue > 0 ? (opIncome / revenue * 100).toFixed(1) : '0.0';

  /* B/S */
  const totalAssets = get(bsB, '資産',   true);
  const totalLiab   = get(bsB, '負債',   true);
  const netAssets   = get(bsB, '純資産', true);
  const capital     = get(bsB, '資本金');
  const ar          = get(bsB, '売掛金');
  const currentLiab = get(bsB, '流動負債', true);

  let cash = 0, bank = 0, ap = 0;
  for (const b of bsB) {
    if (b.account_category_name === '現金・預金' && !b.total_line) {
      if (b.account_item_name === '現金') cash = b.closing_balance || 0;
      else bank += b.closing_balance || 0;
    }
    if (b.account_category_name === '他流動負債' && !b.total_line)
      ap += b.closing_balance || 0;
  }
  const cashTotal   = cash + bank;
  const equityRatio = totalAssets > 0 ? (netAssets   / totalAssets * 100).toFixed(1) : '0.0';
  const curRatio    = currentLiab > 0 ? (cashTotal   / currentLiab * 100).toFixed(1) : '0.0';

  /* クライアント集計 */
  const clientMap = {};
  for (const d of income?.deals || []) {
    const n = d.partner_name || '（不明）';
    clientMap[n] = (clientMap[n] || 0) + Math.abs(d.amount || 0);
  }
  const clients    = Object.entries(clientMap).sort((a, b) => b[1] - a[1]);
  const totalMonth = clients.reduce((s, [, v]) => s + v, 0);

  const clientRows = clients.slice(0, 7).map(([name, amt]) => {
    const pct = totalMonth > 0 ? (amt / totalMonth * 100).toFixed(1) : '0.0';
    const badge = pct >= 15 ? `<span class="bdg bdg-r">${pct}%</span>` : `${pct}%`;
    return `<tr><td>${name}</td><td class="tr">${yen(amt)}</td><td class="tr">${badge}</td></tr>`;
  }).join('');

  /* 未払経費 */
  const unsettled      = (expense?.deals || []).filter(d => d.payment_status !== 'settled');
  const unsettledTotal = unsettled.reduce((s, d) => s + Math.abs(d.amount || 0), 0);
  const expenseRows    = unsettled.slice(0, 5).map(d => {
    const dt   = d.issue_date || '';
    const desc = (d.details?.[0]?.description || '—').slice(0, 16);
    return `<tr><td style="color:var(--g4)">${dt}</td><td>${desc}</td><td class="tr">${yen(Math.abs(d.amount || 0))}</td></tr>`;
  }).join('');

  /* Chart データ */
  const cLabels = JSON.stringify(clients.slice(0, 8).map(c => c[0]));
  const cData   = JSON.stringify(clients.slice(0, 8).map(c => c[1]));

  /* インサイト */
  const outsourcePct = revenue > 0 ? (outsource / revenue * 100).toFixed(1) : '0.0';
  const outsourceOpexPct = opex > 0 ? (outsource / opex * 100).toFixed(1) : '0.0';
  const top2Pct = clients.length >= 2 && totalMonth > 0
    ? ((clients[0][1] + clients[1][1]) / totalMonth * 100).toFixed(1) : '—';
  const top2Names = clients.length >= 2
    ? `${clients[0][0]}・${clients[1][0]}` : 'トップ2社';

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
:root{--bk:#FAFAFA;--w:#0A0A0A;--g1:#F2F2F2;--g2:#EBEBEB;--g3:#E0E0E0;--g4:#AAAAAA;--g5:#777777;--g6:#555555;--acc:#F97316}
body{font-family:'Noto Sans JP','Space Mono',sans-serif;font-weight:300;background:var(--bk);color:var(--w);min-height:100vh;font-size:13px;line-height:1.6}
body::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.25;background-image:radial-gradient(circle,#D5D5D5 1px,transparent 1px);background-size:24px 24px;z-index:0}
.hdr{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:20px 40px;border-bottom:1px solid var(--g3);background:rgba(250,250,250,.95);backdrop-filter:blur(12px)}
.hdr-left{display:flex;align-items:center;gap:16px}
.hdr-dot{width:10px;height:10px;background:var(--acc)}
.hdr-brand{font-family:'Space Mono',monospace;font-size:13px;font-weight:700;letter-spacing:6px}
.hdr-sub{font-size:10px;color:var(--g5);letter-spacing:3px;font-weight:400;margin-top:2px}
.hdr-right{display:flex;align-items:center;gap:16px}
.hdr-tag{font-family:'Space Mono',monospace;font-size:10px;font-weight:700;letter-spacing:2px;padding:5px 12px;border:1px solid var(--g4);color:var(--g6)}
.hdr-time{font-family:'Space Mono',monospace;font-size:10px;color:var(--g4);letter-spacing:1px}
.hdr-refresh{font-family:'Space Mono',monospace;font-size:10px;font-weight:700;letter-spacing:2px;padding:8px 20px;border:1px solid var(--acc);color:var(--acc);background:transparent;cursor:pointer;transition:all .2s}
.hdr-refresh:hover{background:var(--acc);color:#fff}
.hdr-refresh:disabled{opacity:.5;cursor:not-allowed;background:transparent !important;color:var(--acc) !important}
.alert-bar{margin:20px 40px 0;padding:14px 20px;border:1px solid rgba(249,115,22,.25);background:rgba(249,115,22,.05);font-size:12px;color:var(--acc);display:flex;align-items:center;gap:12px;letter-spacing:.3px}
.alert-bar strong{font-weight:500}
.main{position:relative;z-index:1;padding:32px 40px 60px;max-width:1600px;margin:0 auto}
.sec{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:4px;color:var(--g4);margin:40px 0 20px;display:flex;align-items:center;gap:16px;text-transform:uppercase}
.sec::before{content:'●';color:var(--acc);font-size:6px}
.sec::after{content:'';flex:1;height:1px;background:var(--g3)}
.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--g3)}
.kpi{background:var(--bk);padding:32px 28px;position:relative;transition:background .2s}
.kpi:hover{background:var(--g1)}
.kpi-label{font-size:10px;color:var(--g5);letter-spacing:2px;font-weight:500;margin-bottom:16px}
.kpi-val{font-family:'Space Mono',monospace;font-size:40px;font-weight:700;letter-spacing:-2px;line-height:1;margin-bottom:12px;color:var(--w)}
.kpi-sub{font-family:'Space Mono',monospace;font-size:11px;color:var(--g4);letter-spacing:.5px}
.kpi-acc{position:absolute;top:0;left:0;width:2px;height:100%;background:var(--acc);opacity:0;transition:opacity .2s}
.kpi:hover .kpi-acc{opacity:1}
.chart-grid{display:grid;grid-template-columns:1fr 1.8fr;gap:1px;background:var(--g3)}
.chart-cell{background:var(--bk);padding:28px}
.chart-title{font-size:11px;color:var(--g5);letter-spacing:1px;font-weight:500;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between}
.chart-tag{font-family:'Space Mono',monospace;font-size:9px;color:var(--g4);border:1px solid var(--g3);padding:3px 8px;letter-spacing:1px}
.detail-grid{display:grid;grid-template-columns:1.3fr 1fr;gap:1px;background:var(--g3)}
.detail-cell{background:var(--bk);padding:28px}
.detail-title{font-size:11px;color:var(--g5);letter-spacing:1px;font-weight:500;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between}
.pl{border-top:1px solid var(--g3)}
.pl-row{display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--g2);font-size:12px}
.pl-row:last-child{border:none}
.pl-lbl{color:var(--g5);font-weight:400}
.pl-v{font-family:'Space Mono',monospace;font-size:12px;letter-spacing:.5px}
.pl-indent{padding-left:16px}
.pl-total{margin-top:12px;padding:16px 20px;background:var(--g1);display:flex;justify-content:space-between;align-items:center;font-weight:500;font-size:13px}
.pl-total-v{font-family:'Space Mono',monospace;font-size:24px;font-weight:700;letter-spacing:-1px}
.bs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--g3);margin-top:24px}
.bs-cell{background:var(--bk);padding:16px}
.bs-label{font-size:10px;color:var(--g4);letter-spacing:1px;margin-bottom:6px;font-weight:400}
.bs-val{font-family:'Space Mono',monospace;font-size:15px;font-weight:700}
.bs-note{font-size:9px;color:var(--g4);margin-top:3px;letter-spacing:.5px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 12px;font-size:9px;font-weight:700;letter-spacing:2px;color:var(--g4);border-bottom:1px solid var(--g3);font-family:'Space Mono',monospace}
td{padding:10px 12px;border-bottom:1px solid var(--g2);font-size:12px}
tr:last-child td{border:none}
tr:hover td{background:var(--g1)}
.tr{text-align:right;font-family:'Space Mono',monospace;font-size:12px;letter-spacing:.3px}
.bdg{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:1px;padding:3px 8px;border:1px solid;display:inline-block}
.bdg-r{color:var(--acc);border-color:rgba(249,115,22,.4)}
.bdg-w{color:var(--g6);border-color:var(--g4)}
.exp-total{margin-top:16px;padding-top:12px;border-top:1px solid var(--g3);display:flex;justify-content:space-between;font-size:12px}
.insight-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--g3)}
.insight{background:var(--bk);padding:28px;border-left:2px solid var(--g3)}
.insight-tag{font-family:'Space Mono',monospace;font-size:9px;font-weight:700;letter-spacing:2px;margin-bottom:12px}
.insight-tag.high{color:var(--acc)}
.insight-tag.mid{color:#f59e0b}
.insight-tag.low{color:var(--g5)}
.insight-body{font-size:12px;color:var(--g5);line-height:1.7;font-weight:300}
.insight-body strong{color:var(--w);font-weight:500}
.ftr{text-align:center;padding:40px;font-family:'Space Mono',monospace;font-size:9px;color:var(--g3);letter-spacing:2px}
#toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%);background:var(--w);color:var(--bk);font-family:'Space Mono',monospace;font-size:10px;letter-spacing:2px;padding:12px 28px;opacity:0;transition:opacity .3s;pointer-events:none;z-index:999;white-space:nowrap}
#toast.show{opacity:1}
@media(max-width:1100px){.kpi-grid,.chart-grid,.detail-grid,.insight-grid{grid-template-columns:1fr}.hdr{padding:16px 20px;flex-wrap:wrap;gap:12px}.main{padding:20px}.kpi-val{font-size:32px}}
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
    <span class="hdr-tag">FY${FISCAL_YEAR} 累計</span>
    <span class="hdr-tag">確定済</span>
    <span class="hdr-time">更新: ${updatedAt}</span>
    <button class="hdr-refresh" id="refreshBtn" onclick="triggerUpdate()">データ更新</button>
  </div>
</header>

${unsettledTotal > 0 ? `<div class="alert-bar">● <strong>要対応</strong> — 未払経費 ${yen(unsettledTotal)}（${unsettled.length}件）月末精算期限</div>` : ''}

<div class="main">

  <div class="sec">主要指標</div>
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-acc"></div>
      <div class="kpi-label">売上高（累計）</div>
      <div class="kpi-val">${yenM(revenue)}</div>
      <div class="kpi-sub">${yen(revenue)}</div>
    </div>
    <div class="kpi"><div class="kpi-acc"></div>
      <div class="kpi-label">営業利益率</div>
      <div class="kpi-val">${opMargin}%</div>
      <div class="kpi-sub">${yen(opIncome)}</div>
    </div>
    <div class="kpi"><div class="kpi-acc"></div>
      <div class="kpi-label">現預金残高</div>
      <div class="kpi-val">${yenM(cashTotal)}</div>
      <div class="kpi-sub">現金 ${yen(cash)} + 銀行 ${yen(bank)}</div>
    </div>
    <div class="kpi"><div class="kpi-acc"></div>
      <div class="kpi-label">自己資本比率</div>
      <div class="kpi-val">${equityRatio}%</div>
      <div class="kpi-sub">流動比率 ${curRatio}%</div>
    </div>
  </div>

  <div class="sec">財務分析</div>
  <div class="chart-grid">
    <div class="chart-cell">
      <div class="chart-title">費用構成<span class="chart-tag">販管費 ${yenM(opex)}</span></div>
      <div style="height:260px"><canvas id="c1"></canvas></div>
    </div>
    <div class="chart-cell">
      <div class="chart-title">クライアント別売上<span class="chart-tag">当月</span></div>
      <div style="height:260px"><canvas id="c2"></canvas></div>
    </div>
  </div>

  <div class="sec">詳細データ</div>
  <div class="detail-grid">

    <div class="detail-cell">
      <div class="detail-title">損益計算書<span class="bdg bdg-w">FY${FISCAL_YEAR}</span></div>
      <div class="pl">
        <div class="pl-row"><span style="font-weight:500">売上高</span><span class="pl-v" style="font-weight:700">+${yen(revenue)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">外注費</span><span class="pl-v" style="color:var(--acc)">-${yen(outsource)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">役員報酬</span><span class="pl-v" style="color:var(--acc)">-${yen(officers)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">法定福利費</span><span class="pl-v">-${yen(welfare)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">通信費</span><span class="pl-v">-${yen(comm)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">会議費</span><span class="pl-v">-${yen(meeting)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">地代家賃</span><span class="pl-v">-${yen(rent)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">支払報酬料</span><span class="pl-v">-${yen(fee)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">給料手当</span><span class="pl-v">-${yen(salary)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">交際費</span><span class="pl-v">-${yen(entertain)}</span></div>
        <div class="pl-row pl-indent"><span class="pl-lbl">その他</span><span class="pl-v">-${yen(otherOpex)}</span></div>
        <div class="pl-row" style="border-top:1px solid var(--g4);margin-top:8px;padding-top:12px">
          <span style="font-weight:500">販管費合計</span>
          <span class="pl-v" style="color:var(--acc);font-weight:700">-${yen(opex)}</span>
        </div>
      </div>
      <div class="pl-total"><span>営業利益</span><span class="pl-total-v">+${yen(opIncome)}</span></div>
      <div style="margin-top:32px">
        <div class="detail-title">貸借対照表<span class="bdg bdg-w">スナップショット</span></div>
        <div class="bs-grid">
          <div class="bs-cell"><div class="bs-label">総資産</div><div class="bs-val">${yen(totalAssets)}</div></div>
          <div class="bs-cell"><div class="bs-label">総負債</div><div class="bs-val" style="color:var(--acc)">${yen(totalLiab)}</div></div>
          <div class="bs-cell"><div class="bs-label">純資産</div><div class="bs-val">${yen(netAssets)}</div></div>
          <div class="bs-cell"><div class="bs-label">資本金</div><div class="bs-val">${yen(capital)}</div></div>
          <div class="bs-cell"><div class="bs-label">売掛金</div><div class="bs-val">${yen(ar)}</div>${ar === 0 ? '<div class="bs-note">全額回収済</div>' : ''}</div>
          <div class="bs-cell"><div class="bs-label">未払金等</div><div class="bs-val" style="color:var(--acc)">${yen(ap)}</div></div>
        </div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;background:var(--g3);gap:1px">
      <div class="detail-cell" style="flex:1">
        <div class="detail-title">主要クライアント<span class="bdg bdg-w">当月</span></div>
        <table>
          <thead><tr><th>クライアント</th><th class="tr">売上</th><th class="tr">構成比</th></tr></thead>
          <tbody>${clientRows}</tbody>
        </table>
      </div>
      <div class="detail-cell">
        <div class="detail-title">未払経費<span class="bdg bdg-r">${yen(unsettledTotal)}</span></div>
        <table>
          <thead><tr><th>日付</th><th>内容</th><th class="tr">金額</th></tr></thead>
          <tbody>${expenseRows}</tbody>
        </table>
        <div class="exp-total">
          <span style="color:var(--g5)">合計 ${unsettled.length}件 — 月末精算期限</span>
          <span style="color:var(--acc);font-family:'Space Mono',monospace;font-weight:700">${yen(unsettledTotal)}</span>
        </div>
      </div>
    </div>
  </div>

  <div class="sec">経営インサイト</div>
  <div class="insight-grid">
    <div class="insight" style="border-left-color:var(--acc)">
      <div class="insight-tag high">● 外注費集中</div>
      <div class="insight-body">
        外注費が売上の<strong>${outsourcePct}%</strong>・販管費の<strong>${outsourceOpexPct}%</strong>を占めコスト構造を支配。売上増に比例してコスト増加する変動費型。内製化・単価再交渉が急務。
      </div>
    </div>
    <div class="insight" style="border-left-color:#f59e0b">
      <div class="insight-tag mid">● 売上集中</div>
      <div class="insight-body">
        上位2社（${top2Names}）で月次売上の<strong>${top2Pct}%</strong>を占有。解約・縮小でキャッシュフローに直接影響。MRR積上げ型の新規獲得とリテンション強化が必要。
      </div>
    </div>
    <div class="insight" style="border-left-color:var(--g4)">
      <div class="insight-tag low">● 財務健全性</div>
      <div class="insight-body">
        自己資本比率<strong>${equityRatio}%</strong>・流動比率<strong>${curRatio}%</strong>で財務体力は高水準。法人税積立・創立費償却・未払経費精算を踏まえた実質キャッシュ管理を継続。
      </div>
    </div>
  </div>

</div>
<div class="ftr">NOWPEAK — FREEE API — GITHUB ACTIONS — ${updatedAt}</div>
<div id="toast"></div>

<script>
const _PAT  = '${GH_PAT}';
const _REPO = '${GH_REPO}';
function toast(msg, ms = 4000) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
async function triggerUpdate() {
  if (!_PAT) { toast('PAT が未設定です — GitHub Secrets を確認してください'); return; }
  const btn = document.getElementById('refreshBtn');
  btn.disabled = true; btn.textContent = '更新中...';
  try {
    const r = await fetch('https://api.github.com/repos/' + _REPO + '/actions/workflows/update.yml/dispatches', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + _PAT, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' })
    });
    if (r.status === 204) {
      toast('✓ 更新を開始しました。約1〜2分後にページを再読み込みしてください。', 6000);
    } else {
      toast('エラー: ' + r.status + ' — PATの権限を確認してください');
    }
  } catch(e) {
    toast('接続エラー: ' + e.message);
  }
  setTimeout(() => { btn.disabled = false; btn.textContent = 'データ更新'; }, 8000);
}
new Chart(document.getElementById('c1'), {
  type: 'doughnut',
  data: {
    labels: ['外注費','役員報酬','通信費','法定福利費','会議費','地代家賃','支払報酬料','その他'],
    datasets: [{ data: [${outsource},${officers},${comm},${welfare},${meeting},${rent},${fee},${Math.round(otherOpex + salary + entertain)}],
      backgroundColor: ['#F97316','#111','#555','#777','#999','#aaa','#ccc','#ddd'], borderWidth: 0, hoverOffset: 6 }]
  },
  options: { responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right', labels: { color: '#555', font: { size: 11 }, padding: 8, boxWidth: 10, boxHeight: 10 } },
      tooltip: { callbacks: { label: ctx => { const v=ctx.parsed, t=ctx.dataset.data.reduce((a,b)=>a+b,0); return ' ¥'+v.toLocaleString()+'  ('+(v/t*100).toFixed(1)+'%)'; } } }
    }, cutout: '68%'
  }
});
new Chart(document.getElementById('c2'), {
  type: 'bar',
  data: { labels: ${cLabels}, datasets: [{ data: ${cData},
    backgroundColor: ctx => { const v=ctx.raw; return v>=1e6?'#F97316':v>=5e5?'#111':v>=3e5?'#888':'#ccc'; },
    borderRadius: 0, borderSkipped: false }]
  },
  options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ¥'+ctx.parsed.x.toLocaleString() } } },
    scales: {
      x: { grid: { color: '#EBEBEB' }, ticks: { color: '#888', font: { size: 10 }, callback: v => '¥'+(v/1e4).toFixed(0)+'万' } },
      y: { grid: { display: false }, ticks: { color: '#555', font: { size: 11 } } }
    }
  }
});
<` + `/script>
</body>
</html>`;
}

// ── ログイン画面 HTML ─────────────────────────────────────────
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
body{font-family:'Noto Sans JP','Space Mono',sans-serif;font-weight:300;background:#FAFAFA;color:#0A0A0A;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden}
body::before{content:'';position:fixed;inset:0;pointer-events:none;opacity:.6;background-image:radial-gradient(circle,#D5D5D5 1px,transparent 1px);background-size:24px 24px}
.gate{position:relative;z-index:1;text-align:center;width:100%;max-width:400px;padding:40px 24px}
.dot{width:10px;height:10px;background:#F97316;margin:0 auto 36px}
.brand{font-family:'Space Mono',monospace;font-size:14px;font-weight:700;letter-spacing:8px;margin-bottom:6px}
.sub{font-size:11px;color:#888;letter-spacing:3px;margin-bottom:48px;font-weight:300}
.field{position:relative;margin-bottom:36px}
.field input{width:100%;background:transparent;border:none;border-bottom:1px solid #CCC;color:#0A0A0A;font-family:'Noto Sans JP',sans-serif;font-size:13px;font-weight:300;letter-spacing:2px;padding:12px 0;outline:none;text-align:center}
.field input::placeholder{color:#BBB;letter-spacing:3px}
.field input:focus{border-bottom-color:#F97316}
.line{position:absolute;bottom:0;left:50%;width:0;height:1px;background:#F97316;transition:all .3s;transform:translateX(-50%)}
.field input:focus~.line{width:100%}
.btn{font-family:'Space Mono',monospace;font-size:10px;font-weight:700;letter-spacing:4px;padding:14px 48px;border:1px solid #F97316;color:#F97316;background:transparent;cursor:pointer;transition:all .2s}
.btn:hover{background:#F97316;color:#fff}
.btn:active{transform:scale(.98)}
.err{margin-top:24px;font-size:11px;color:#F97316;letter-spacing:1px;opacity:0;transition:opacity .3s;font-weight:300}
.err.show{opacity:1}
.loading{display:none;margin-top:24px;font-size:10px;color:#AAA;letter-spacing:2px;font-weight:300}
.dots{margin-top:48px;display:flex;justify-content:center;gap:8px}
.dots span{width:4px;height:4px;background:#D5D5D5;display:block}
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
    <input type="password" id="pw" placeholder="パスワード" autocomplete="off"
      onkeydown="if(event.key==='Enter')go()">
    <div class="line"></div>
  </div>
  <button class="btn" onclick="go()">アクセス</button>
  <div class="err" id="err">認証に失敗しました</div>
  <div class="loading" id="ld">復号中...</div>
  <div class="dots"><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div>
</div>
<script>
const D='${payload}';
async function go(){
  const pw=document.getElementById('pw').value;if(!pw)return;
  const err=document.getElementById('err'),ld=document.getElementById('ld'),gate=document.getElementById('gate');
  err.classList.remove('show');ld.style.display='block';
  try{
    const raw=Uint8Array.from(atob(D),c=>c.charCodeAt(0));
    const salt=raw.slice(0,16),iv=raw.slice(16,28),tag=raw.slice(28,44),ct=raw.slice(44);
    const km=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:100000,hash:'SHA-256'},km,{name:'AES-GCM',length:256},false,['decrypt']);
    const combined=new Uint8Array(ct.length+16);combined.set(ct);combined.set(tag,ct.length);
    const dec=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,combined);
    const html=new TextDecoder().decode(dec);
    document.open();document.write(html);document.close();
  }catch(e){
    ld.style.display='none';err.classList.add('show');gate.classList.add('shake');
    setTimeout(()=>gate.classList.remove('shake'),300);
    document.getElementById('pw').value='';document.getElementById('pw').focus();
  }
}
document.getElementById('pw').focus();
<` + `/script>
</body>
</html>`;
}

// ── メイン ────────────────────────────────────────────────────
async function main() {
  console.log('━'.repeat(50));
  console.log('  NOW PEAK CFO Dashboard — 生成開始');
  console.log('━'.repeat(50));

  const token = await getToken();

  const jst       = new Date(Date.now() + 9 * 3600000);
  const updatedAt = jst.toISOString().slice(0, 16).replace('T', ' ') + ' JST';
  const startDate = new Date(jst.getFullYear(), jst.getMonth(), 1).toISOString().slice(0, 10);

  console.log(`[info] 対象月: ${startDate} 〜`);

  const [pl, bs, income, expense] = await Promise.all([
    freeeGet(token, '/reports/trial_pl',  { fiscal_year: FISCAL_YEAR }),
    freeeGet(token, '/reports/trial_bs',  { fiscal_year: FISCAL_YEAR }),
    freeeGet(token, '/deals', { type: 'income',  start_issue_date: startDate, limit: 100 }),
    freeeGet(token, '/deals', { type: 'expense', start_issue_date: startDate, limit: 100 }),
  ]);
  console.log('[freee] ✓ 全データ取得完了');

  const dashboard = buildDashboard({ pl, bs, income, expense }, updatedAt);
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
