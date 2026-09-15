// 养基宝

const $ = new Env('养基宝');

const HOST = 'https://app-api.yangjibao.com';
const SECRET = 'Zk0w9mX7IKFGo5qp5jyDwJKnU7ZJZZJwGhs5myg4vlv4lKEHFKxGe6jlb84KOLkx';
const STORE_CK = 'yjb_ck';
const STORE_DATA = 'yjb_account_collect';
const STORE_TS = 'yjb_last_ts';
const STORE_VIP = 'yjb_vip_data';
const STORE_VIP_TS = 'yjb_vip_ts';
const STORE_DAYINFO = 'yjb_dayinfo_cache';

// ↓↓↓ 新增:通知展示相关常量 ↓↓↓
const SEPARATOR = '——————————';
// ↑↑↑ 新增结束 ↑↑↑

(async () => {
  const arg = parseArg();
  const mode = detectMode();

  $.log(`[YJB] 2025-05-16`);

  if (mode === 'response') {
    sniffToken();
  } else if (mode === 'panel') {
    await runPanel(arg);
  } else if (arg.mode === 'vip') {
    await runVipCron(arg);
  } else {
    await runCron(arg);
  }
})()
  .catch((e) => { $.logErr(e); })
  .finally(() => $.done());

function detectMode() {
  if (typeof $request !== 'undefined' && $request) {
    if (typeof $response !== 'undefined' && $response) return 'response';
    return 'request';
  }
  const arg = parseArg();
  if (arg.mode === 'panel') return 'panel';
  return 'cron';
}

function parseArg() {
  const out = {};
  const raw = (typeof $argument !== 'undefined' ? $argument : '') || '';
  raw.split('&').filter(Boolean).forEach((kv) => {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
  });
  return out;
}

// CK
function sniffToken() {
  try {
    const headers = ($request && $request.headers) || {};
    const auth = headers['Authorization'] || headers['authorization'];
    if (!auth) return;
    const ua = headers['User-Agent'] || headers['user-agent'] || '';
    const old = getCK();
    saveCK(auth, ua);
    if (auth !== old.auth) {
      $.msg('养基宝', old.auth ? 'Authorization 已更新' : 'Authorization 获取成功', auth);
    }
  } catch (e) { $.logErr(e); }
}

function getCK() {
  try { return JSON.parse($.getdata(STORE_CK)) || {}; } catch (e) { return {}; }
}
function saveCK(auth, ua) {
  $.setdata(JSON.stringify({ auth, ua }), STORE_CK);
}

// ↓↓↓ 新增内容开始 ↓↓↓
async function checkTradingDay(token, ua) {
  const todayKey = formatDateKey(new Date());

  // 同一天内有缓存就不重复请求 /day_info
  try {
    const cacheRaw = $.getdata(STORE_DAYINFO);
    if (cacheRaw) {
      const cache = JSON.parse(cacheRaw);
      if (cache.date === todayKey) return cache.isMarketDay;
    }
  } catch (e) {}

  const dayInfo = await fetchAPI(token, ua, '/day_info');
  if (!dayInfo || !dayInfo.data || typeof dayInfo.data.is_market_day === 'undefined') {
    $.log('[YJB] day_info 获取失败,本次默认按交易日处理');
    return true; // 接口异常时容错放行,避免误判漏推
  }

  const isMarketDay = !!dayInfo.data.is_market_day;
  $.setdata(JSON.stringify({ date: todayKey, isMarketDay }), STORE_DAYINFO);
  return isMarketDay;
}

function formatDateKey(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// ↑↑↑ 新增内容结束 ↑↑↑

// ↓↓↓ 新增:通知样式改造所需的辅助函数 ↓↓↓
function trendEmoji(v) {
  const n = Number(v) || 0;
  if (n > 0) return '🔴'; // 涨
  if (n < 0) return '🟢'; // 跌
  return '⚪️';            // 平盘
}

function pct(v) {
  const n = Number(v) || 0;
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function isAfterCutoff(d, hour, minute) {
  return d.getHours() * 60 + d.getMinutes() >= hour * 60 + minute;
}

function httpGetJson(url) {
  return new Promise((resolve) => {
    $task_get(
      { url, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS)' } },
      (err, resp, body) => {
        if (err) { $.logErr('[YJB] http error: ' + err); return resolve(null); }
        try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
      }
    );
  });
}

// 单独拉取上证指数 / 创业板指(养基宝自身行情接口)
async function fetchIndexQuotes(token, ua) {
  const idxRes = await fetchAPI(token, ua, '/market/v1/quote/index-data');
  const out = { sse: null, gem: null };
  if (idxRes && idxRes.data && Array.isArray(idxRes.data)) {
    for (const i of idxRes.data) {
      if (i.name === '上证指数') out.sse = { v: Number(i.v) || 0, dir: Number(i.dir) || 0 };
      if (i.name === '创业板指') out.gem = { v: Number(i.v) || 0, dir: Number(i.dir) || 0 };
    }
  }
  return out;
}

// 东方财富公共接口:今日两市(沪+深)实时成交额,单位:元
async function fetchTodayTurnover() {
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001&fields=f2,f3,f4,f6,f12,f14';
  const res = await httpGetJson(url);
  if (!res || !res.data || !Array.isArray(res.data.diff)) return null;
  let total = 0;
  for (const item of res.data.diff) total += Number(item.f6) || 0;
  return total;
}

// 东方财富公共接口:昨日两市(沪+深)收盘完整成交额,单位:元
async function fetchYesterdayTurnover() {
  const secids = ['1.000001', '0.399001'];
  const todayKey = formatDateKey(new Date()).replace(/-/g, '');
  let total = 0;
  let ok = false;
  for (const secid of secids) {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&end=20500101&lmt=5`;
    const res = await httpGetJson(url);
    if (!res || !res.data || !Array.isArray(res.data.klines)) continue;
    const klines = res.data.klines;
    for (let i = klines.length - 1; i >= 0; i--) {
      const parts = klines[i].split(',');
      const dateKey = (parts[0] || '').replace(/-/g, '');
      if (dateKey && dateKey !== todayKey) {
        total += Number(parts[6]) || 0; // f57 成交额
        ok = true;
        break;
      }
    }
  }
  return ok ? total : null;
}

function formatWanYi(yuan) {
  return (yuan / 1e12).toFixed(2) + '万亿';
}
function formatYiSigned(yuan) {
  const yi = yuan / 1e8;
  return (yi >= 0 ? '+' : '') + yi.toFixed(2) + '亿';
}
// ↑↑↑ 新增结束 ↑↑↑

async function runCron(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;
  if (!token) {
    $.msg('养基宝', '未获取 Authorization', '请先打开 App 添加持有');
    return;
  }

  // 非交易日直接跳过,不拉取数据也不推送
  const tradingDay = await checkTradingDay(token, ck.ua);
  if (!tradingDay) {
    $.log('[YJB] 今日非交易日,跳过本次估值/净值推送');
    return;
  }

  const now = new Date();
  const afterCutoff = isAfterCutoff(now, 15, 0);

  const [json, vipLines, idxData] = await Promise.all([
    fetchAccountCollect(token, ck.ua),
    fetchVipLines(token, ck.ua),
    fetchIndexQuotes(token, ck.ua),
  ]);
  if (!json) return;

  $.setdata(JSON.stringify(json), STORE_DATA);
  $.setdata(String(Date.now()), STORE_TS);

  if (vipLines.length) {
    $.setdata(JSON.stringify({ lines: vipLines, ts: Date.now() }), STORE_VIP);
  }

  // 数据异常时按原逻辑走 buildSummary 兜底,不套用新样式
  if (!json || json.code !== 200 || !json.data) {
    const summary = buildSummary(json);
    const vipBlock = vipLines.length ? '\n' + vipLines.join('\n') : '';
    $.msg(`场内穿透 • ${formatTime(now)}`, summary.subtitle, summary.body + vipBlock);
    return;
  }

  // ↓↓↓ 新版通知样式 ↓↓↓
  const acData = json.data;
  const totalAsset = Number(acData.assets_collect) || 0;
  const todayIncome = Number(acData.today_income) || 0;
  const todayIncomeRate = (totalAsset - todayIncome) ? todayIncome / (totalAsset - todayIncome) : 0;
  const accounts = Array.isArray(acData.account_data) ? acData.account_data : [];

  let upCount = 0, downCount = 0, updatedCount = 0;
  for (const a of accounts) {
    upCount += Number(a.up) || 0;
    downCount += Number(a.down) || 0;
    if (a.nav_update === true) updatedCount++;
  }

  // 第一行标题:附带涨跌统计
  const title = `场内穿透 • ${formatTime(now)} 🔛『📈${upCount} ‖ ${downCount}📉』`;

  // 第二行:场内穿透涨跌估值,15:00后追加已更新数量
  let subtitle = `${trendEmoji(todayIncome)}场内穿透${signed(todayIncome)} (${signedRate(todayIncomeRate)})`;
  if (afterCutoff) subtitle += `  [已更新${updatedCount}]`;

  const bodyLines = [];

  // 第三行:分隔线
  bodyLines.push(SEPARATOR);

  // 第四、五行:上证指数 / 创业板指
  if (idxData.sse) {
    bodyLines.push(`${trendEmoji(idxData.sse.dir)}上证指数${idxData.sse.v.toFixed(0)}${pct(idxData.sse.dir)}`);
  }
  if (idxData.gem) {
    bodyLines.push(`${trendEmoji(idxData.gem.dir)}创业板指${idxData.gem.v.toFixed(0)}${pct(idxData.gem.dir)}`);
  }

  // 第六行:两市成交额,15:00后追加较昨日变化
  let turnoverLine = '两市成交额';
  try {
    const todayTotal = await fetchTodayTurnover();
    if (todayTotal !== null) {
      turnoverLine += formatWanYi(todayTotal);
      if (afterCutoff) {
        const yesterdayTotal = await fetchYesterdayTurnover();
        if (yesterdayTotal !== null) {
          turnoverLine += `   [较昨日${formatYiSigned(todayTotal - yesterdayTotal)}]`;
        }
      }
    } else {
      turnoverLine += '获取失败';
    }
  } catch (e) {
    $.logErr(e);
    turnoverLine += '获取失败';
  }
  bodyLines.push(turnoverLine);

  // 保留原有资金流入/流出、榜单信息(其他内容不变)
  const extraLines = vipLines.filter(l => l.startsWith('资金') || l.startsWith('榜单'));
  if (extraLines.length) bodyLines.push(...extraLines);
  // ↑↑↑ 新版通知样式 ↑↑↑

  $.msg(title, subtitle, bodyLines.join('\n'));
}

async function runPanel(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;

  if (token) {
    try {
      const json = await fetchAccountCollect(token, ck.ua);
      if (json) {
        $.setdata(JSON.stringify(json), STORE_DATA);
        $.setdata(String(Date.now()), STORE_TS);
      }
    } catch (e) { $.logErr(e); }
  }

  const cached = $.getdata(STORE_DATA);
  const ts = Number($.getdata(STORE_TS) || 0);
  if (!cached) {
    panelOutput({
      title: '养基宝',
      content: token ? '首次拉取中,请稍后重新点击面板' : '请先打开 App 让 MITM 嗅探 token',
      icon: 'chart.bar.fill',
      'icon-color': '#FF8C00',
    });
    return;
  }

  let json;
  try { json = JSON.parse(cached); } catch (e) { json = null; }
  const summary = buildSummary(json);

  let agoText = '';
  if (ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) agoText = '刚刚更新';
    else if (mins < 60) agoText = `${mins}分钟前更新`;
    else agoText = `${Math.floor(mins / 60)}小时前更新`;
  }

  let vipBlock = '';
  try {
    const vipRaw = $.getdata(STORE_VIP);
    if (vipRaw) {
      const vd = JSON.parse(vipRaw);
      if (vd.lines && vd.lines.length) {
        const header = vd.lines.find(l => l.startsWith('--'));
        const show = vd.lines.filter(l => !l.startsWith('--'));
        if (show.length) vipBlock = '\n' + (header || '') + (header ? '\n' : '') + show.join('\n');
      }
    }
  } catch (e) {}

  panelOutput({
    title: summary.title || '养基宝',
    content: summary.body + vipBlock,
    icon: summary.icon || 'chart.bar.fill',
    'icon-color': summary.color || '#FF8C00',
  });
}

function panelOutput(obj) {
  if (typeof $done === 'function') {
    $done(obj);
  } else {
    $.log(JSON.stringify(obj));
  }
  $._panel_done = true;
}

function buildSummary(json) {
  if (!json || json.code !== 200 || !json.data) {
    return { title: '养基宝', subtitle: '数据为空', body: (json && json.message) || '响应解析失败' };
  }

  const d = json.data;
  const totalAsset = Number(d.assets_collect) || 0;
  const todayIncome = Number(d.today_income) || 0;
  const accounts = Array.isArray(d.account_data) ? d.account_data : [];

  let totalCost = 0, totalHoldIncome = 0, upCount = 0, downCount = 0;
  let navUpdated = true;
  for (const a of accounts) {
    totalCost += Number(a.hold_cost) || 0;
    totalHoldIncome += Number(a.hold_income) || 0;
    upCount += Number(a.up) || 0;
    downCount += Number(a.down) || 0;
    if (a.nav_update === false) navUpdated = false;
  }
  const totalIncomeRate = totalCost ? totalHoldIncome / totalCost : 0;
  const todayIncomeRate = (totalAsset - todayIncome) ? todayIncome / (totalAsset - todayIncome) : 0;

  const up = todayIncome >= 0;
  const subtitle = `当前预估 ${signed(todayIncome)} (${signedRate(todayIncomeRate)})${navUpdated ? '' : '  [未更新]'}`;

  const lines = [];
 //  lines.push(`总资产     ${fmt(totalAsset)}`);
 //  lines.push(`本    金     ${fmt(totalCost)}`);
 //  lines.push(`累计收益  ${signed(totalHoldIncome)} (${signedRate(totalIncomeRate)})`);
  lines.push(`基金涨跌  ${upCount} 📈 / ${downCount} 📉`);
  if (accounts.length > 1) {
    lines.push('');
    for (const a of accounts) {
      const r = Number(a.today_income_rate) || 0;
      lines.push(`${a.title.padEnd(4, '\u3000')}  ${signed(a.today_income)} (${signedRate(r)})`);
    }
  }

  return {
    title: '养基宝',
    subtitle,
    body: lines.join('\n'),
    icon: up ? 'chart.line.uptrend.xyaxis' : 'chart.line.downtrend.xyaxis',
    color: up ? '#00A65A' : '#D9534F',
  };
}

function fmt(v) {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
function signed(v) {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return (n >= 0 ? '+' : '') + fmt(n);
}
function signedRate(v) {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  const pct = Math.abs(n) < 1 ? n * 100 : n;
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}
function formatTime(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function fetchAPI(token, ua, path) {
  const url = HOST + path;
  const basePath = path.split('?')[0];
  const ts = String(Math.floor(Date.now() / 1000));
  const pureToken = token.replace(/^\w+:/, '');
  const signUrl = HOST + basePath;
  const sign = md5(signUrl + pureToken + SECRET + ts);

  const opts = {
    url,
    method: 'GET',
    headers: {
      'Host': 'app-api.yangjibao.com',
      'Accept': '*/*',
      'Authorization': token,
      'Request-Sign': sign,
      'Request-Time': ts,
      'Content-Type': 'application/json',
      'User-Agent': ua || '',
    },
  };

  return new Promise((resolve) => {
    $task_get(opts, (err, resp, body) => {
      if (err) { $.logErr('[YJB] ' + path + ' error: ' + err); return resolve(null); }
      try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
    });
  });
}

async function fetchVipLines(token, ua) {
  const [vipRes, idxRes] = await Promise.all([
    fetchAPI(token, ua, '/vip_information?page=1'),
    fetchAPI(token, ua, '/market/v1/quote/index-data'),
  ]);

  const lines = [];
  let dataDay = '';

  if (idxRes && idxRes.data && Array.isArray(idxRes.data)) {
    const want = ['上证指数', '深证成指', '创业板指'];
    const items = idxRes.data.filter(i => want.includes(i.name));
    if (items.length) {
      if (items[0].date) dataDay = items[0].date.split(' ')[0].slice(5);
      const parts = items.map(i => {
        const d = Number(i.dir) || 0;
        return `${i.name.replace('指数','')} ${Number(i.v).toFixed(0)} ${d >= 0 ? '+' : ''}${d.toFixed(2)}%`;
      });
      lines.push('大盘 ' + parts.join(' | '));
    }
  }

  if (!dataDay && vipRes && vipRes.data && vipRes.data.day) {
    dataDay = vipRes.data.day.slice(5);
  }
  if (dataDay) lines.unshift(`-- ${dataDay} 大盘数据 --`);

  let buyNum = 0, sellNum = 0;
  const rankings = [];
  if (vipRes && vipRes.data && Array.isArray(vipRes.data.list)) {
    for (const item of vipRes.data.list) {
      if (item.type === 'ranking') {
        buyNum = Number(item.buy_num) || 0;
        sellNum = Number(item.sell_num) || 0;
        if (Array.isArray(item.buy_data)) {
          item.buy_data.slice(0, 3).forEach(r => rankings.push(r));
        }
      }
    }
  }

  if (buyNum || sellNum) {
    const net = buyNum - sellNum;
    const fmtW = v => (v / 10000).toFixed(0) + '万';
    lines.push(`资金 流入${fmtW(buyNum)} / 流出${fmtW(sellNum)} 净${net >= 0 ? '流入' : '流出'}${fmtW(Math.abs(net))}`);
  }

  if (rankings.length) {
    lines.push('榜单 ' + rankings.map(r => `${r.name || r.fund_name}(${r.rate || r.growth_rate})`).slice(0, 3).join(' | '));
  }

  return lines;
}

async function runVipCron(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;
  if (!token) { $.msg('养基宝', '行情推送失败', '未获取 Authorization'); return; }

  const tradingDay = await checkTradingDay(token, ck.ua);
  if (!tradingDay) { $.log('[YJB] 非交易日,跳过行情推送'); return; }

  const lines = await fetchVipLines(token, ck.ua);
  if (!lines.length) { $.log('[YJB] 行情数据为空'); return; }

  $.setdata(JSON.stringify({ lines, ts: Date.now() }), STORE_VIP);
  $.setdata(String(Date.now()), STORE_VIP_TS);

  $.msg('养基宝 · 行情', formatTime(new Date()), lines.join('\n'));
}

async function fetchAccountCollect(token, ua) {
  const path = '/account_collect';
  const url = HOST + path;
  const ts = String(Math.floor(Date.now() / 1000));
  const pureToken = token.replace(/^\w+:/, '');
  const sign = md5(url + pureToken + SECRET + ts);

  const opts = {
    url,
    method: 'GET',
    headers: {
      'Host': 'app-api.yangjibao.com',
      'Accept': '*/*',
      'Accept-Language': 'zh-Hans-CN;q=1.0',
      'Authorization': token,
      'Request-Sign': sign,
      'Request-Time': ts,
      'Content-Type': 'application/json',
      'User-Agent': ua || '',
      'Connection': 'keep-alive',
    },
  };

  return new Promise((resolve) => {
    $task_get(opts, (err, resp, body) => {
      if (err) {
        $.logErr('[YJB] request error: ' + err);
        $.msg('养基宝', '网络错误', String(err));
        return resolve(null);
      }
      if (resp && resp.status && resp.status >= 400) {
        $.logErr(`[YJB] http ${resp.status}: ${body}`);
        $.msg('养基宝', `HTTP ${resp.status}`, (body || '').slice(0, 120));
        return resolve(null);
      }
      try { resolve(JSON.parse(body)); }
      catch (e) {
        $.logErr('[YJB] json parse fail: ' + e);
        resolve(null);
      }
    });
  });
}

function $task_get(opts, cb) {
  if (typeof $httpClient !== 'undefined') {
    $httpClient.get(opts, cb);
  } else if (typeof $task !== 'undefined') {
    $task.fetch(opts).then(
      (r) => cb(null, { status: r.statusCode }, r.body),
      (e) => cb(e, null, null)
    );
  } else {
    cb(new Error('不支持的运行环境'), null, null);
  }
}

function md5(s) {
  function safeAdd(x, y) { const lsw = (x & 0xffff) + (y & 0xffff); const msw = (x >> 16) + (y >> 16) + (lsw >> 16); return (msw << 16) | (lsw & 0xffff); }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  const utf8 = unescape(encodeURIComponent(s));
  const n = utf8.length;
  const blocks = [];
  for (let i = 0; i < n; i++) blocks[i >> 2] |= utf8.charCodeAt(i) << ((i & 3) << 3);
  blocks[n >> 2] |= 0x80 << ((n & 3) << 3);
  blocks[(((n + 8) >> 6) + 1) * 16 - 2] = n << 3;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < blocks.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    a = ff(a, b, c, d, blocks[i] | 0, 7, -680876936);
    d = ff(d, a, b, c, blocks[i + 1] | 0, 12, -389564586);
    c = ff(c, d, a, b, blocks[i + 2] | 0, 17, 606105819);
    b = ff(b, c, d, a, blocks[i + 3] | 0, 22, -1044525330);
    a = ff(a, b, c, d, blocks[i + 4] | 0, 7, -176418897);
    d = ff(d, a, b, c, blocks[i + 5] | 0, 12, 1200080426);
    c = ff(c, d, a, b, blocks[i + 6] | 0, 17, -1473231341);
    b = ff(b, c, d, a, blocks[i + 7] | 0, 22, -45705983);
    a = ff(a, b, c, d, blocks[i + 8] | 0, 7, 1770035416);
    d = ff(d, a, b, c, blocks[i + 9] | 0, 12, -1958414417);
    c = ff(c, d, a, b, blocks[i + 10] | 0, 17, -42063);
    b = ff(b, c, d, a, blocks[i + 11] | 0, 22, -1990404162);
    a = ff(a, b, c, d, blocks[i + 12] | 0, 7, 1804603682);
    d = ff(d, a, b, c, blocks[i + 13] | 0, 12, -40341101);
    c = ff(c, d, a, b, blocks[i + 14] | 0, 17, -1502002290);
    b = ff(b, c, d, a, blocks[i + 15] | 0, 22, 1236535329);

    a = gg(a, b, c, d, blocks[i + 1] | 0, 5, -165796510);
    d = gg(d, a, b, c, blocks[i + 6] | 0, 9, -1069501632);
    c = gg(c, d, a, b, blocks[i + 11] | 0, 14, 643717713);
    b = gg(b, c, d, a, blocks[i] | 0, 20, -373897302);
    a = gg(a, b, c, d, blocks[i + 5] | 0, 5, -701558691);
    d = gg(d, a, b, c, blocks[i + 10] | 0, 9, 38016083);
    c = gg(c, d, a, b, blocks[i + 15] | 0, 14, -660478335);
    b = gg(b, c, d, a, blocks[i + 4] | 0, 20, -405537848);
    a = gg(a, b, c, d, blocks[i + 9] | 0, 5, 568446438);
    d = gg(d, a, b, c, blocks[i + 14] | 0, 9, -1019803690);
    c = gg(c, d, a, b, blocks[i + 3] | 0, 14, -187363961);
    b = gg(b, c, d, a, blocks[i + 8] | 0, 20, 1163531501);
    a = gg(a, b, c, d, blocks[i + 13] | 0, 5, -1444681467);
    d = gg(d, a, b, c, blocks[i + 2] | 0, 9, -51403784);
    c = gg(c, d, a, b, blocks[i + 7] | 0, 14, 1735328473);
    b = gg(b, c, d, a, blocks[i + 12] | 0, 20, -1926607734);

    a = hh(a, b, c, d, blocks[i + 5] | 0, 4, -378558);
    d = hh(d, a, b, c, blocks[i + 8] | 0, 11, -2022574463);
    c = hh(c, d, a, b, blocks[i + 11] | 0, 16, 1839030562);
    b = hh(b, c, d, a, blocks[i + 14] | 0, 23, -35309556);
    a = hh(a, b, c, d, blocks[i + 1] | 0, 4, -1530992060);
    d = hh(d, a, b, c, blocks[i + 4] | 0, 11, 1272893353);
    c = hh(c, d, a, b, blocks[i + 7] | 0, 16, -155497632);
    b = hh(b, c, d, a, blocks[i + 10] | 0, 23, -1094730640);
    a = hh(a, b, c, d, blocks[i + 13] | 0, 4, 681279174);
    d = hh(d, a, b, c, blocks[i] | 0, 11, -358537222);
    c = hh(c, d, a, b, blocks[i + 3] | 0, 16, -722521979);
    b = hh(b, c, d, a, blocks[i + 6] | 0, 23, 76029189);
    a = hh(a, b, c, d, blocks[i + 9] | 0, 4, -640364487);
    d = hh(d, a, b, c, blocks[i + 12] | 0, 11, -421815835);
    c = hh(c, d, a, b, blocks[i + 15] | 0, 16, 530742520);
    b = hh(b, c, d, a, blocks[i + 2] | 0, 23, -995338651);

    a = ii(a, b, c, d, blocks[i] | 0, 6, -198630844);
    d = ii(d, a, b, c, blocks[i + 7] | 0, 10, 1126891415);
    c = ii(c, d, a, b, blocks[i + 14] | 0, 15, -1416354905);
    b = ii(b, c, d, a, blocks[i + 5] | 0, 21, -57434055);
    a = ii(a, b, c, d, blocks[i + 12] | 0, 6, 1700485571);
    d = ii(d, a, b, c, blocks[i + 3] | 0, 10, -1894986606);
    c = ii(c, d, a, b, blocks[i + 10] | 0, 15, -1051523);
    b = ii(b, c, d, a, blocks[i + 1] | 0, 21, -2054922799);
    a = ii(a, b, c, d, blocks[i + 8] | 0, 6, 1873313359);
    d = ii(d, a, b, c, blocks[i + 15] | 0, 10, -30611744);
    c = ii(c, d, a, b, blocks[i + 6] | 0, 15, -1560198380);
    b = ii(b, c, d, a, blocks[i + 13] | 0, 21, 1309151649);
    a = ii(a, b, c, d, blocks[i + 4] | 0, 6, -145523070);
    d = ii(d, a, b, c, blocks[i + 11] | 0, 10, -1120210379);
    c = ii(c, d, a, b, blocks[i + 2] | 0, 15, 718787259);
    b = ii(b, c, d, a, blocks[i + 9] | 0, 21, -343485551);

    a = safeAdd(a, oa);
    b = safeAdd(b, ob);
    c = safeAdd(c, oc);
    d = safeAdd(d, od);
  }
  const toHex = (n) => {
    let s = '';
    for (let j = 0; j < 4; j++) {
      const b = (n >> (j * 8)) & 0xff;
      s += (b < 16 ? '0' : '') + b.toString(16);
    }
    return s;
  };
  return toHex(a) + toHex(b) + toHex(c) + toHex(d);
}

function Env(name) {
  return new (class {
    constructor(n) { this.name = n; }
    log(s) { console.log(`[${this.name}] ${s}`); }
    logErr(e) { console.log(`[${this.name}][ERR] ${e && e.stack || e}`); }
    msg(t, st, body) {
      if (typeof $notification !== 'undefined') $notification.post(t, st, body);
      else if (typeof $notify !== 'undefined') $notify(t, st, body);
    }
    getdata(k) {
      if (typeof $persistentStore !== 'undefined') return $persistentStore.read(k);
      if (typeof $prefs !== 'undefined') return $prefs.valueForKey(k);
      return null;
    }
    setdata(v, k) {
      if (typeof $persistentStore !== 'undefined') return $persistentStore.write(v, k);
      if (typeof $prefs !== 'undefined') return $prefs.setValueForKey(v, k);
    }
    done() {
      if (this._panel_done) return;
      if (typeof $done === 'function') $done({});
    }
  })(name);
}