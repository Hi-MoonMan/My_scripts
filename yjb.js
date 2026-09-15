// 养基宝

const $ = new Env('养基宝');

const HOST = 'https://app-api.yangjibao.com';
const SECRET = 'Zk0w9mX7IKFGo5qp5jyDwJKnU7ZJZZJwGhs5myg4vlv4lKEHFKxGe6jlb84KOLkx';

const EASTMONEY_QUOTE_HOST = 'https://push2.eastmoney.com';
const EASTMONEY_HISTORY_HOST = 'https://push2his.eastmoney.com';
const EASTMONEY_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

const STORE_CK = 'yjb_ck';
const STORE_DATA = 'yjb_account_collect';
const STORE_TS = 'yjb_last_ts';
const STORE_VIP = 'yjb_vip_data';
const STORE_VIP_TS = 'yjb_vip_ts';
const STORE_DAYINFO = 'yjb_dayinfo_cache';

(async () => {
  const arg = parseArg();
  const mode = detectMode();

  $.log('[YJB] 2025-05-16');

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
  .catch((e) => {
    $.logErr(e);
  })
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
    if (i > 0) {
      out[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1));
    }
  });

  return out;
}

// CK
function sniffToken() {
  try {
    const headers = ($request && $request.headers) || {};
    const auth = headers.Authorization || headers.authorization;

    if (!auth) return;

    const ua = headers['User-Agent'] || headers['user-agent'] || '';
    const old = getCK();

    saveCK(auth, ua);

    if (auth !== old.auth) {
      $.msg(
        '养基宝',
        old.auth ? 'Authorization 已更新' : 'Authorization 获取成功',
        auth
      );
    }
  } catch (e) {
    $.logErr(e);
  }
}

function getCK() {
  try {
    return JSON.parse($.getdata(STORE_CK)) || {};
  } catch (e) {
    return {};
  }
}

function saveCK(auth, ua) {
  $.setdata(JSON.stringify({ auth, ua }), STORE_CK);
}

// 交易日判断
async function checkTradingDay(token, ua) {
  const todayKey = formatDateKey(new Date());

  // 同一天内有缓存就不重复请求 /day_info
  try {
    const cacheRaw = $.getdata(STORE_DAYINFO);

    if (cacheRaw) {
      const cache = JSON.parse(cacheRaw);

      if (cache.date === todayKey) {
        return cache.isMarketDay;
      }
    }
  } catch (e) {}

  const dayInfo = await fetchAPI(token, ua, '/day_info');

  if (
    !dayInfo ||
    !dayInfo.data ||
    typeof dayInfo.data.is_market_day === 'undefined'
  ) {
    $.log('[YJB] day_info 获取失败，本次默认按交易日处理');
    return true;
  }

  const isMarketDay = !!dayInfo.data.is_market_day;

  $.setdata(
    JSON.stringify({
      date: todayKey,
      isMarketDay
    }),
    STORE_DAYINFO
  );

  return isMarketDay;
}

function formatDateKey(d) {
  const p = (x) => String(x).padStart(2, '0');

  return (
    d.getFullYear() +
    '-' +
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate())
  );
}

async function runCron(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;

  if (!token) {
    $.msg('养基宝', '未获取 Authorization', '请先打开 App 添加持有');
    return;
  }

  // 非交易日直接跳过
  const tradingDay = await checkTradingDay(token, ck.ua);

  if (!tradingDay) {
    $.log('[YJB] 今日非交易日，跳过本次估值/净值推送');
    return;
  }

  const [json, vipLines] = await Promise.all([
    fetchAccountCollect(token, ck.ua),
    fetchVipLines(token, ck.ua)
  ]);

  if (!json) return;

  $.setdata(JSON.stringify(json), STORE_DATA);
  $.setdata(String(Date.now()), STORE_TS);

  if (vipLines.length) {
    $.setdata(
      JSON.stringify({
        lines: vipLines,
        ts: Date.now()
      }),
      STORE_VIP
    );
  }

  const summary = buildSummary(json);

  // 行情信息优先显示，账户明细放在行情信息之后
  const bodyParts = [];

  if (vipLines.length) {
    bodyParts.push(vipLines.join('\n'));
  }

  if (summary.body) {
    bodyParts.push(summary.body);
  }

  const title =
    `场内穿透 · ${formatTime(new Date())}` +
    ` ‖ ${summary.upCount}📈/${summary.downCount}📉`;

  $.msg(
    title,
    summary.subtitle,
    bodyParts.join('\n')
  );
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
    } catch (e) {
      $.logErr(e);
    }
  }

  const cached = $.getdata(STORE_DATA);
  const ts = Number($.getdata(STORE_TS) || 0);

  if (!cached) {
    panelOutput({
      title: '养基宝',
      content: token
        ? '首次拉取中，请稍后重新点击面板'
        : '请先打开 App 让 MITM 嗅探 token',
      icon: 'chart.bar.fill',
      'icon-color': '#FF8C00'
    });
    return;
  }

  let json;

  try {
    json = JSON.parse(cached);
  } catch (e) {
    json = null;
  }

  const summary = buildSummary(json);

  let agoText = '';

  if (ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);

    if (mins < 1) {
      agoText = '刚刚更新';
    } else if (mins < 60) {
      agoText = `${mins}分钟前更新`;
    } else {
      agoText = `${Math.floor(mins / 60)}小时前更新`;
    }
  }

  let vipBlock = '';

  try {
    const vipRaw = $.getdata(STORE_VIP);

    if (vipRaw) {
      const vd = JSON.parse(vipRaw);

      if (vd.lines && vd.lines.length) {
        vipBlock = vd.lines.join('\n');
      }
    }
  } catch (e) {}

  const contentParts = [];

  if (summary.subtitle) {
    contentParts.push(summary.subtitle);
  }

  if (vipBlock) {
    contentParts.push(vipBlock);
  }

  if (summary.body) {
    contentParts.push(summary.body);
  }

  if (agoText) {
    contentParts.push(agoText);
  }

  panelOutput({
    title:
      `${summary.title || '养基宝'}` +
      ` ‖ ${summary.upCount}📈/${summary.downCount}📉`,
    content: contentParts.join('\n'),
    icon: summary.icon || 'chart.bar.fill',
    'icon-color': summary.color || '#FF8C00'
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
    return {
      title: '养基宝',
      subtitle: '数据为空',
      body: (json && json.message) || '响应解析失败',
      upCount: 0,
      downCount: 0
    };
  }

  const d = json.data;
  const totalAsset = Number(d.assets_collect) || 0;
  const todayIncome = Number(d.today_income) || 0;
  const accounts = Array.isArray(d.account_data) ? d.account_data : [];

  let totalCost = 0;
  let totalHoldIncome = 0;
  let upCount = 0;
  let downCount = 0;
  let navUpdated = true;

  for (const a of accounts) {
    totalCost += Number(a.hold_cost) || 0;
    totalHoldIncome += Number(a.hold_income) || 0;
    upCount += Number(a.up) || 0;
    downCount += Number(a.down) || 0;

    if (a.nav_update === false) {
      navUpdated = false;
    }
  }

  const totalIncomeRate = totalCost
    ? totalHoldIncome / totalCost
    : 0;

  const todayIncomeRate = totalAsset - todayIncome
    ? todayIncome / (totalAsset - todayIncome)
    : 0;

  const emoji = trendEmoji(todayIncome);
  const up = todayIncome > 0;

  const subtitle =
    `${emoji}当前估值${signed(todayIncome)}` +
    ` (${signedRate(todayIncomeRate)})` +
    `${navUpdated ? '' : ' [未更新]'}`;

  const lines = [];

  /*
  lines.push(`总资产     ${fmt(totalAsset)}`);
  lines.push(`本    金     ${fmt(totalCost)}`);
  lines.push(
    `累计收益  ${signed(totalHoldIncome)} ` +
    `(${signedRate(totalIncomeRate)})`
  );
  */

  // “基金涨跌”不再放在正文中，已移动到通知标题后面。

  // 多账户明细功能保留，但放到行情数据之后。
  if (accounts.length > 1) {
    for (const a of accounts) {
      const r = Number(a.today_income_rate) || 0;

      lines.push(
        `${a.title.padEnd(4, '\u3000')}  ` +
        `${signed(a.today_income)} (${signedRate(r)})`
      );
    }
  }

  return {
    title: '养基宝',
    subtitle,
    body: lines.join('\n'),
    upCount,
    downCount,
    icon: up
      ? 'chart.line.uptrend.xyaxis'
      : todayIncome < 0
        ? 'chart.line.downtrend.xyaxis'
        : 'chart.line.flattrend.xyaxis',
    color: up
      ? '#D9534F'
      : todayIncome < 0
        ? '#00A65A'
        : '#A0A0A0'
  };
}

function trendEmoji(v) {
  const n = Number(v);

  if (!isFinite(n) || n === 0) {
    return '⚪️';
  }

  return n > 0 ? '🔴' : '🟢';
}

function fmt(v) {
  const n = Number(v);

  if (isNaN(n)) {
    return String(v);
  }

  return n.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  });
}

function signed(v) {
  const n = Number(v);

  if (isNaN(n)) {
    return String(v);
  }

  return (n >= 0 ? '+' : '') + fmt(n);
}

function signedRate(v) {
  const n = Number(v);

  if (isNaN(n)) {
    return String(v);
  }

  const pct = Math.abs(n) < 1 ? n * 100 : n;
  const safePct = Math.abs(pct) < 0.005 ? 0 : pct;

  return (safePct >= 0 ? '+' : '') + safePct.toFixed(2) + '%';
}

function formatTime(d) {
  const p = (x) => String(x).padStart(2, '0');

  return (
    `${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
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
      Host: 'app-api.yangjibao.com',
      Accept: '*/*',
      Authorization: token,
      'Request-Sign': sign,
      'Request-Time': ts,
      'Content-Type': 'application/json',
      'User-Agent': ua || ''
    }
  };

  return new Promise((resolve) => {
    $task_get(opts, (err, resp, body) => {
      if (err) {
        $.logErr(`[YJB] ${path} error: ${err}`);
        return resolve(null);
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        resolve(null);
      }
    });
  });
}

/**
 * 行情数据
 *
 * 养基宝接口：
 * 1. 上证指数
 * 2. 创业板指
 * 3. VIP 榜单
 *
 * 东方财富公开行情接口：
 * 1. 沪深两市当前成交额
 * 2. 上一交易日成交额
 * 3. 当前上涨、下跌家数
 */
async function fetchVipLines(token, ua) {
  const [vipRes, idxRes, marketExtra] = await Promise.all([
    fetchAPI(token, ua, '/vip_information?page=1'),
    fetchAPI(token, ua, '/market/v1/quote/index-data'),
    fetchEastMoneyMarketData(ua)
  ]);

  const lines = [];

  // 删除原来的日期副标题。
  // 仅保留上证指数、创业板指，并分别单独占一行。
  if (idxRes && idxRes.data && Array.isArray(idxRes.data)) {
    const wantedNames = ['上证指数', '创业板指'];

    for (const name of wantedNames) {
      const item = idxRes.data.find((i) => i && i.name === name);

      if (!item) {
        lines.push(`${name}数据获取失败`);
        continue;
      }

      const value = Number(item.v);
      const direction = Number(item.dir);

      if (!isFinite(value) || !isFinite(direction)) {
        lines.push(`${name}数据获取失败`);
        continue;
      }

      lines.push(
        `${trendEmoji(direction)}` +
        `${name}${value.toFixed(0)}` +
        `${direction >= 0 ? '+' : ''}${normalizeZero(direction).toFixed(2)}%`
      );
    }
  } else {
    lines.push('上证指数数据获取失败');
    lines.push('创业板指数据获取失败');
  }

  // 替换原资金流入/流出数据。
  if (
    marketExtra &&
    isFinite(marketExtra.currentAmount) &&
    marketExtra.currentAmount >= 0
  ) {
    let amountLine =
      `两市成交额${formatMarketAmount(marketExtra.currentAmount)}`;

    if (
      isFinite(marketExtra.previousAmount) &&
      marketExtra.previousAmount >= 0
    ) {
      const amountDiff =
        marketExtra.currentAmount - marketExtra.previousAmount;

      amountLine +=
        `/成交额较昨日${formatSignedYi(amountDiff)}`;
    } else {
      amountLine += '/成交额较昨日获取失败';
    }

    lines.push(amountLine);
  } else {
    lines.push('两市成交额获取失败');
  }

  if (
    marketExtra &&
    Number.isFinite(marketExtra.riseCount) &&
    Number.isFinite(marketExtra.fallCount)
  ) {
    lines.push(
      `上涨${marketExtra.riseCount}家/` +
      `下跌${marketExtra.fallCount}家`
    );
  } else {
    lines.push('市场涨跌家数获取失败');
  }

  // 原脚本榜单功能保留
  const rankings = [];

  if (
    vipRes &&
    vipRes.data &&
    Array.isArray(vipRes.data.list)
  ) {
    for (const item of vipRes.data.list) {
      if (
        item.type === 'ranking' &&
        Array.isArray(item.buy_data)
      ) {
        item.buy_data
          .slice(0, 3)
          .forEach((r) => rankings.push(r));
      }
    }
  }

  if (rankings.length) {
    lines.push(
      '榜单 ' +
      rankings
        .map((r) => {
          const name = r.name || r.fund_name || '--';
          const rate = r.rate || r.growth_rate || '--';
          return `${name}(${rate})`;
        })
        .slice(0, 3)
        .join(' | ')
    );
  }

  return lines;
}

/**
 * 获取东方财富公开行情数据。
 */
async function fetchEastMoneyMarketData(ua) {
  const fs = [
    'm:0+t:6+f:!2',
    'm:0+t:80+f:!2',
    'm:1+t:2+f:!2',
    'm:1+t:23+f:!2'
  ].join(',');

  const liveAmountUrl =
    `${EASTMONEY_QUOTE_HOST}/api/qt/ulist.np/get` +
    `?fltt=2&invt=2` +
    `&fields=f2,f3,f6,f12,f14` +
    `&secids=1.000001,0.399001` +
    `&ut=${EASTMONEY_UT}` +
    `&_=${Date.now()}`;

  const shHistoryUrl =
    `${EASTMONEY_HISTORY_HOST}/api/qt/stock/kline/get` +
    `?secid=1.000001` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=0&end=20500101&lmt=10` +
    `&ut=${EASTMONEY_UT}` +
    `&_=${Date.now()}`;

  const szHistoryUrl =
    `${EASTMONEY_HISTORY_HOST}/api/qt/stock/kline/get` +
    `?secid=0.399001` +
    `&fields1=f1,f2,f3,f4,f5,f6` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61` +
    `&klt=101&fqt=0&end=20500101&lmt=10` +
    `&ut=${EASTMONEY_UT}` +
    `&_=${Date.now()}`;

  const breadthUrl =
    `${EASTMONEY_QUOTE_HOST}/api/qt/clist/get` +
    `?pn=1&pz=6000&po=1&np=1` +
    `&fltt=2&invt=2&fid=f3` +
    `&fs=${encodeURIComponent(fs)}` +
    `&fields=f3,f12,f14` +
    `&ut=${EASTMONEY_UT}` +
    `&_=${Date.now()}`;

  const [liveRes, shHistory, szHistory, breadthRes] =
    await Promise.all([
      fetchPublicJSON(liveAmountUrl, ua),
      fetchPublicJSON(shHistoryUrl, ua),
      fetchPublicJSON(szHistoryUrl, ua),
      fetchPublicJSON(breadthUrl, ua)
    ]);

  let currentAmount = NaN;
  let previousAmount = NaN;
  let riseCount = NaN;
  let fallCount = NaN;

  // 当前沪深两市成交额
  if (
    liveRes &&
    liveRes.data &&
    Array.isArray(liveRes.data.diff)
  ) {
    const amounts = liveRes.data.diff
      .map((item) => Number(item && item.f6))
      .filter((n) => isFinite(n) && n >= 0);

    if (amounts.length >= 2) {
      currentAmount = amounts.reduce((sum, n) => sum + n, 0);
    }
  }

  // 上一交易日沪深两市成交额
  const shPrevious = getPreviousTradingDayAmount(shHistory);
  const szPrevious = getPreviousTradingDayAmount(szHistory);

  if (isFinite(shPrevious) && isFinite(szPrevious)) {
    previousAmount = shPrevious + szPrevious;
  }

  // 当前上涨、下跌家数
  if (
    breadthRes &&
    breadthRes.data &&
    Array.isArray(breadthRes.data.diff)
  ) {
    let rise = 0;
    let fall = 0;

    for (const item of breadthRes.data.diff) {
      const rate = Number(item && item.f3);

      if (!isFinite(rate)) continue;

      if (rate > 0) {
        rise++;
      } else if (rate < 0) {
        fall++;
      }
    }

    riseCount = rise;
    fallCount = fall;
  }

  return {
    currentAmount,
    previousAmount,
    riseCount,
    fallCount
  };
}

/**
 * 从日 K 数据里获取上一交易日成交额。
 *
 * K 线字段顺序：
 * 日期,开盘,收盘,最高,最低,成交量,成交额,...
 */
function getPreviousTradingDayAmount(json) {
  if (
    !json ||
    !json.data ||
    !Array.isArray(json.data.klines) ||
    !json.data.klines.length
  ) {
    return NaN;
  }

  const today = formatDateKey(new Date());

  const rows = json.data.klines
    .map((line) => String(line).split(','))
    .filter((parts) => parts.length >= 7);

  // 排除今天，最后一条就是上一交易日。
  const previousRows = rows.filter((parts) => parts[0] !== today);

  if (!previousRows.length) {
    return NaN;
  }

  const last = previousRows[previousRows.length - 1];
  const amount = Number(last[6]);

  return isFinite(amount) ? amount : NaN;
}

function fetchPublicJSON(url, ua) {
  const opts = {
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Referer: 'https://quote.eastmoney.com/',
      'User-Agent':
        ua ||
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 Mobile/15E148'
    }
  };

  return new Promise((resolve) => {
    $task_get(opts, (err, resp, body) => {
      if (err) {
        $.logErr(`[YJB] 东方财富接口请求失败: ${err}`);
        return resolve(null);
      }

      if (resp && resp.status && resp.status >= 400) {
        $.logErr(`[YJB] 东方财富接口 HTTP ${resp.status}`);
        return resolve(null);
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        $.logErr(`[YJB] 东方财富接口 JSON 解析失败: ${e}`);
        resolve(null);
      }
    });
  });
}

function normalizeZero(v) {
  const n = Number(v);

  if (!isFinite(n)) {
    return 0;
  }

  return Math.abs(n) < 0.005 ? 0 : n;
}

function formatMarketAmount(v) {
  const n = Number(v);

  if (!isFinite(n)) {
    return '获取失败';
  }

  // 1 万亿元 = 10^12 元
  if (Math.abs(n) >= 1000000000000) {
    return trimTrailingZeros(n / 1000000000000, 2) + '万亿';
  }

  // 1 亿元 = 10^8 元
  return trimTrailingZeros(n / 100000000, 2) + '亿';
}

function formatSignedYi(v) {
  const n = Number(v);

  if (!isFinite(n)) {
    return '获取失败';
  }

  const yi = normalizeZero(n / 100000000);

  return (
    `${yi >= 0 ? '+' : ''}` +
    `${trimTrailingZeros(yi, 2)}亿`
  );
}

function trimTrailingZeros(v, digits) {
  const n = Number(v);

  if (!isFinite(n)) {
    return String(v);
  }

  return n
    .toFixed(digits)
    .replace(/\.?0+$/, '');
}

async function runVipCron(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;

  if (!token) {
    $.msg(
      '养基宝',
      '行情推送失败',
      '未获取 Authorization'
    );
    return;
  }

  const tradingDay = await checkTradingDay(token, ck.ua);

  if (!tradingDay) {
    $.log('[YJB] 非交易日，跳过行情推送');
    return;
  }

  const lines = await fetchVipLines(token, ck.ua);

  if (!lines.length) {
    $.log('[YJB] 行情数据为空');
    return;
  }

  $.setdata(
    JSON.stringify({
      lines,
      ts: Date.now()
    }),
    STORE_VIP
  );

  $.setdata(String(Date.now()), STORE_VIP_TS);

  $.msg(
    '养基宝 · 行情',
    formatTime(new Date()),
    lines.join('\n')
  );
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
      Host: 'app-api.yangjibao.com',
      Accept: '*/*',
      'Accept-Language': 'zh-Hans-CN;q=1.0',
      Authorization: token,
      'Request-Sign': sign,
      'Request-Time': ts,
      'Content-Type': 'application/json',
      'User-Agent': ua || '',
      Connection: 'keep-alive'
    }
  };

  return new Promise((resolve) => {
    $task_get(opts, (err, resp, body) => {
      if (err) {
        $.logErr(`[YJB] request error: ${err}`);
        $.msg('养基宝', '网络错误', String(err));
        return resolve(null);
      }

      if (resp && resp.status && resp.status >= 400) {
        $.logErr(`[YJB] http ${resp.status}: ${body}`);

        $.msg(
          '养基宝',
          `HTTP ${resp.status}`,
          (body || '').slice(0, 120)
        );

        return resolve(null);
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        $.logErr(`[YJB] json parse fail: ${e}`);
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
      (r) => cb(
        null,
        { status: r.statusCode },
        r.body
      ),
      (e) => cb(e, null, null)
    );
  } else {
    cb(
      new Error('不支持的运行环境'),
      null,
      null
    );
  }
}

function md5(s) {
  function safeAdd(x, y) {
    const lsw =
      (x & 0xffff) +
      (y & 0xffff);

    const msw =
      (x >> 16) +
      (y >> 16) +
      (lsw >> 16);

    return (msw << 16) | (lsw & 0xffff);
  }

  function rol(n, c) {
    return (n << c) | (n >>> (32 - c));
  }

  function cmn(q, a, b, x, s, t) {
    return safeAdd(
      rol(
        safeAdd(
          safeAdd(a, q),
          safeAdd(x, t)
        ),
        s
      ),
      b
    );
  }

  function ff(a, b, c, d, x, s, t) {
    return cmn(
      (b & c) | (~b & d),
      a,
      b,
      x,
      s,
      t
    );
  }

  function gg(a, b, c, d, x, s, t) {
    return cmn(
      (b & d) | (c & ~d),
      a,
      b,
      x,
      s,
      t
    );
  }

  function hh(a, b, c, d, x, s, t) {
    return cmn(
      b ^ c ^ d,
      a,
      b,
      x,
      s,
      t
    );
  }

  function ii(a, b, c, d, x, s, t) {
    return cmn(
      c ^ (b | ~d),
      a,
      b,
      x,
      s,
      t
    );
  }

  const utf8 = unescape(encodeURIComponent(s));
  const n = utf8.length;
  const blocks = [];

  for (let i = 0; i < n; i++) {
    blocks[i >> 2] |=
      utf8.charCodeAt(i) <<
      ((i & 3) << 3);
  }

  blocks[n >> 2] |=
    0x80 <<
    ((n & 3) << 3);

  blocks[
    (((n + 8) >> 6) + 1) * 16 - 2
  ] = n << 3;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < blocks.length; i += 16) {
    const oa = a;
    const ob = b;
    const oc = c;
    const od = d;

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

  const toHex = (num) => {
    let out = '';

    for (let j = 0; j < 4; j++) {
      const byte =
        (num >> (j * 8)) &
        0xff;

      out +=
        (byte < 16 ? '0' : '') +
        byte.toString(16);
    }

    return out;
  };

  return (
    toHex(a) +
    toHex(b) +
    toHex(c) +
    toHex(d)
  );
}

function Env(name) {
  return new (class {
    constructor(n) {
      this.name = n;
    }

    log(s) {
      console.log(`[${this.name}] ${s}`);
    }

    logErr(e) {
      console.log(
        `[${this.name}][ERR] ` +
        `${(e && e.stack) || e}`
      );
    }

    msg(t, st, body) {
      if (typeof $notification !== 'undefined') {
        $notification.post(t, st, body);
      } else if (typeof $notify !== 'undefined') {
        $notify(t, st, body);
      }
    }

    getdata(k) {
      if (typeof $persistentStore !== 'undefined') {
        return $persistentStore.read(k);
      }

      if (typeof $prefs !== 'undefined') {
        return $prefs.valueForKey(k);
      }

      return null;
    }

    setdata(v, k) {
      if (typeof $persistentStore !== 'undefined') {
        return $persistentStore.write(v, k);
      }

      if (typeof $prefs !== 'undefined') {
        return $prefs.setValueForKey(v, k);
      }
    }

    done() {
      if (this._panel_done) return;

      if (typeof $done === 'function') {
        $done({});
      }
    }
  })(name);
}