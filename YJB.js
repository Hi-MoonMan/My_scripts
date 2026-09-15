// 养基宝

const $ = new Env('养基宝');

const HOST = 'https://app-api.yangjibao.com';
const SECRET = 'Zk0w9mX7IKFGo5qp5jyDwJKnU7ZJZZJwGhs5myg4vlv4lKEHFKxGe6jlb84KOLkx';
const EASTMONEY_QUOTE_API = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f12,f14,f2,f3,f6&secids=1.000001,0.399001';

const STORE_CK = 'yjb_ck';
const STORE_DATA = 'yjb_account_collect';
const STORE_TS = 'yjb_last_ts';
const STORE_VIP = 'yjb_vip_data';
const STORE_DAYINFO = 'yjb_dayinfo_cache';

(async () => {
  const arg = parseArg();
  const mode = detectMode();

  $.log(`[YJB] 2025-opt`);

  if (mode === 'response') {
    sniffToken();
  } else if (mode === 'panel') {
    await runPanel(arg);
  } else {
    await runCron(arg); // arg.mode === 'vip' 时也走同一套完整推送
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

async function checkTradingDay(token, ua) {
  const todayKey = formatDateKey(new Date());
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
    return true;
  }
  const isMarketDay = !!dayInfo.data.is_market_day;
  $.setdata(JSON.stringify({ date: todayKey, isMarketDay }), STORE_DAYINFO);
  return isMarketDay;
}

function formatDateKey(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------ 主流程 ------------------

async function runCron(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;
  if (!token) { $.msg('养基宝', '未获取 Authorization', '请先打开 App 添加持有'); return; }

  const tradingDay = await checkTradingDay(token, ck.ua);
  if (!tradingDay) { $.log('[YJB] 今日非交易日,跳过本次推送'); return; }

  const [json, lines] = await Promise.all([
    fetchAccountCollect(token, ck.ua),
    fetchMarketLines(token, ck.ua),
  ]);
  if (!json) return;

  $.setdata(JSON.stringify(json), STORE_DATA);
  $.setdata(String(Date.now()), STORE_TS);
  if (lines.length) $.setdata(JSON.stringify({ lines, ts: Date.now() }), STORE_VIP);

  const s = buildSummary(json);
  const title = `基金数据·${formatTime(new Date())} 『📈${s.upCount} ‖ ${s.downCount}📉』`;
  $.msg(title, s.subtitle, lines.join('\n'));
}

async function runPanel(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;

  if (token) {
    try {
      const [json, lines] = await Promise.all([
        fetchAccountCollect(token, ck.ua),
        fetchMarketLines(token, ck.ua),
      ]);
      if (json) {
        $.setdata(JSON.stringify(json), STORE_DATA);
        $.setdata(String(Date.now()), STORE_TS);
      }
      if (lines.length) $.setdata(JSON.stringify({ lines, ts: Date.now() }), STORE_VIP);
    } catch (e) { $.logErr(e); }
  }

  const cached = $.getdata(STORE_DATA);
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
  const s = buildSummary(json);

  let marketBlock = '';
  try {
    const vipRaw = $.getdata(STORE_VIP);
    if (vipRaw) {
      const vd = JSON.parse(vipRaw);
      if (vd.lines && vd.lines.length) marketBlock = '\n' + vd.lines.join('\n');
    }
  } catch (e) {}

  const title = `养基宝·${formatTime(new Date())} 『📈${s.upCount} ‖ ${s.downCount}📉』`;
  panelOutput({
    title,
    content: s.subtitle + marketBlock,
    icon: s.icon,
    'icon-color': s.color,
  });
}

function panelOutput(obj) {
  if (typeof $done === 'function') $done(obj);
  else $.log(JSON.stringify(obj));
  $._panel_done = true;
}

// 场内穿透摘要
function buildSummary(json) {
  if (!json || json.code !== 200 || !json.data) {
    return { subtitle: (json && json.message) || '数据为空', upCount: 0, downCount: 0, icon: 'chart.bar.fill', color: '#FF8C00' };
  }

  const d = json.data;
  const totalAsset = Number(d.assets_collect) || 0;
  const todayIncome = Number(d.today_income) || 0;
  const accounts = Array.isArray(d.account_data) ? d.account_data : [];

  let upCount = 0, downCount = 0;
  let navUpdated = accounts.length > 0;
  for (const a of accounts) {
    upCount += Number(a.up) || 0;
    downCount += Number(a.down) || 0;
    if (a.nav_update === false) navUpdated = false;
  }
  const rate = (totalAsset - todayIncome) ? todayIncome / (totalAsset - todayIncome) : 0;
  const subtitle = `${trendEmoji(todayIncome)}场内穿透 ${signed(todayIncome)} (${signedRate(rate)})${navUpdated ? ' [已更新☑️]' : ''}`;

  return {
    subtitle,
    upCount,
    downCount,
    icon: todayIncome > 0 ? 'chart.line.uptrend.xyaxis' : todayIncome < 0 ? 'chart.line.downtrend.xyaxis' : 'chart.line.flattrend.xyaxis',
    color: todayIncome > 0 ? '#D9534F' : todayIncome < 0 ? '#00A65A' : '#A0A0A0',
  };
}

// 涨🔴 跌🟢 平🔵
function trendEmoji(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '⚪️';
  return n > 0 ? '🔴' : '🟢';
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
function isAfter1500(d) { return d.getHours() >= 15; }

// ------------------ 大盘指数 + 成交额 ------------------

async function fetchMarketLines(token, ua) {
  const [idxRes, turnover] = await Promise.all([
    fetchAPI(token, ua, '/market/v1/quote/index-data'),
    fetchTurnover(),
  ]);

  const lines = ['-----------------------------'];
  const map = {};
  if (idxRes && Array.isArray(idxRes.data)) idxRes.data.forEach((i) => { if (i && i.name) map[i.name] = i; });

  for (const name of ['上证指数', '创业板指']) {
    const item = map[name];
    if (!item) { lines.push(`⚪️${name} 暂无数据`); continue; }
    const v = Number(item.v), r = Number(item.dir);
    const vText = isFinite(v) ? v.toFixed(0) : '--';
    const rText = isFinite(r) ? `${r >= 0 ? '+' : ''}${r.toFixed(2)}%` : '--';
    lines.push(`${trendEmoji(r)}${name} ${vText}🔛${rText}`);
  }

  if (turnover && isFinite(turnover.today)) {
    let line = `总成交额  ${fmtAmount(turnover.today)}`;
    if (isAfter1500(new Date()) && isFinite(turnover.yesterday)) {
      const diff = turnover.today - turnover.yesterday;
      line += `   [较昨日${(diff >= 0 ? '+' : '') + (diff / 1e8).toFixed(2)}亿]`;
    }
    lines.push(line);
  } else {
    lines.push('总成交额  暂无数据');
  }

  return lines;
}

function fmtAmount(n) {
  n = Number(n);
  if (!isFinite(n)) return '--';
  return Math.abs(n) >= 1e12 ? trimZero(n / 1e12) + '万亿' : trimZero(n / 1e8) + '亿';
}
function trimZero(v) {
  return Number(v).toFixed(2).replace(/\.?0+$/, '');
}

// 东方财富:两市实时成交额 + 昨日成交额(15点后才查询)
async function fetchTurnover() {
  try {
    const cur = await fetchExternalJSON(EASTMONEY_QUOTE_API);
    const items = (cur && cur.data && cur.data.diff) || [];
    let sh = NaN, sz = NaN;
    for (const it of items) {
      const amt = Number(it.f6);
      if (!isFinite(amt)) continue;
      if (String(it.f12) === '000001') sh = amt;
      else if (String(it.f12) === '399001') sz = amt;
    }
    const today = (isFinite(sh) ? sh : 0) + (isFinite(sz) ? sz : 0);
    if (!today) return null;

    let yesterday = NaN;
    if (isAfter1500(new Date())) {
      const [y1, y2] = await Promise.all([prevTurnover('1.000001'), prevTurnover('0.399001')]);
      if (isFinite(y1) && isFinite(y2)) yesterday = y1 + y2;
    }
    return { today, yesterday };
  } catch (e) {
    $.logErr('[YJB] 成交额获取失败: ' + e);
    return null;
  }
}

// 取指定指数最近一个非今日的日K成交额(即昨日盘后成交额)
async function prevTurnover(secid) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=0&lmt=5&end=20500101&fields1=f1,f2,f3&fields2=f51,f57`;
  const json = await fetchExternalJSON(url);
  const klines = (json && json.data && Array.isArray(json.data.klines)) ? json.data.klines : [];
  const todayKey = formatDateKey(new Date());

  let last = NaN, lastDate = '';
  for (const line of klines) {
    const p = String(line).split(',');
    if (p[0] < todayKey && p[0] > lastDate) { lastDate = p[0]; last = Number(p[1]); }
  }
  return last;
}

function fetchExternalJSON(url) {
  const opts = {
    url,
    method: 'GET',
    headers: {
      'Accept': 'application/json, */*',
      'Referer': 'https://quote.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
    },
  };
  return new Promise((resolve) => {
    $task_get(opts, (err, resp, body) => {
      if (err || (resp && resp.status >= 400)) return resolve(null);
      try { resolve(JSON.parse(body)); } catch (e) { resolve(null); }
    });
  });
}

// ------------------ 养基宝接口 ------------------

async function fetchAPI(token, ua, path) {
  const url = HOST + path;
  const basePath = path.split('?')[0];
  const ts = String(Math.floor(Date.now() / 1000));
  const pureToken = token.replace(/^\w+:/, '');
  const sign = md5(HOST + basePath + pureToken + SECRET + ts);

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
      catch (e) { $.logErr('[YJB] json parse fail: ' + e); resolve(null); }
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