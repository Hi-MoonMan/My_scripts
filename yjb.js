// 养基宝

const $ = new Env('养基宝');

const HOST = 'https://app-api.yangjibao.com';
const SECRET = 'Zk0w9mX7IKFGo5qp5jyDwJKnU7ZJZZJwGhs5myg4vlv4lKEHFKxGe6jlb84KOLkx';

const EASTMONEY_QUOTE_API =
  'https://push2.eastmoney.com/api/qt/ulist.np/get' +
  '?fltt=2&invt=2&fields=f12,f14,f2,f3,f6' +
  '&secids=1.000001,0.399001';

const STORE_CK = 'yjb_ck';
const STORE_DATA = 'yjb_account_collect';
const STORE_TS = 'yjb_last_ts';
const STORE_VIP = 'yjb_vip_data';
const STORE_VIP_TS = 'yjb_vip_ts';
const STORE_DAYINFO = 'yjb_dayinfo_cache';

(async () => {
  const arg = parseArg();
  const mode = detectMode();

  $.log('[YJB] 2025-05-16-custom');

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

  raw
    .split('&')
    .filter(Boolean)
    .forEach((kv) => {
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

// 定时任务
async function runCron(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;

  if (!token) {
    $.msg('养基宝', '未获取 Authorization', '请先打开 App 添加持有');
    return;
  }

  const tradingDay = await checkTradingDay(token, ck.ua);

  if (!tradingDay) {
    $.log('[YJB] 今日非交易日，跳过本次估值/净值推送');
    return;
  }

  // 同时拉取基金账户数据、指数行情及成交额
  const [json, marketLines] = await Promise.all([
    fetchAccountCollect(token, ck.ua),
    fetchVipLines(token, ck.ua)
  ]);

  if (!json) return;

  $.setdata(JSON.stringify(json), STORE_DATA);
  $.setdata(String(Date.now()), STORE_TS);

  if (marketLines.length) {
    $.setdata(
      JSON.stringify({
        lines: marketLines,
        ts: Date.now()
      }),
      STORE_VIP
    );
  }

  const summary = buildSummary(json);
  const now = new Date();

  // 第一行：
  // 基金数据·09-15 11:00 『📈6 ‖ 5📉』
  const title =
    `基金数据·${formatTime(now)} ` +
    `『📈${summary.upCount} ‖ ${summary.downCount}📉』`;

  // 第二行：场内穿透
  const subtitle = summary.subtitle;

  // 第三行以后：分隔线、指数及成交额
  const body = marketLines.length
    ? marketLines.join('\n')
    : '——————————\n行情数据暂无';

  $.msg(title, subtitle, body);
}

// 面板
async function runPanel(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;

  if (token) {
    try {
      const [json, marketLines] = await Promise.all([
        fetchAccountCollect(token, ck.ua),
        fetchVipLines(token, ck.ua)
      ]);

      if (json) {
        $.setdata(JSON.stringify(json), STORE_DATA);
        $.setdata(String(Date.now()), STORE_TS);
      }

      if (marketLines.length) {
        $.setdata(
          JSON.stringify({
            lines: marketLines,
            ts: Date.now()
          }),
          STORE_VIP
        );
      }
    } catch (e) {
      $.logErr(e);
    }
  }

  const cached = $.getdata(STORE_DATA);

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

  let marketBlock = '';

  try {
    const marketRaw = $.getdata(STORE_VIP);

    if (marketRaw) {
      const marketData = JSON.parse(marketRaw);

      if (
        marketData.lines &&
        Array.isArray(marketData.lines) &&
        marketData.lines.length
      ) {
        marketBlock = '\n' + marketData.lines.join('\n');
      }
    }
  } catch (e) {}

  const title =
    `基金数据·${formatTime(new Date())} ` +
    `『📈${summary.upCount} ‖ ${summary.downCount}📉』`;

  panelOutput({
    title,
    content: summary.subtitle + marketBlock,
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

// 生成基金摘要
function buildSummary(json) {
  if (!json || json.code !== 200 || !json.data) {
    return {
      title: '养基宝',
      subtitle: '基金数据为空',
      body: (json && json.message) || '响应解析失败',
      upCount: 0,
      downCount: 0,
      navUpdated: false,
      icon: 'chart.bar.fill',
      color: '#FF8C00'
    };
  }

  const d = json.data;
  const totalAsset = Number(d.assets_collect) || 0;
  const todayIncome = Number(d.today_income) || 0;
  const accounts = Array.isArray(d.account_data)
    ? d.account_data
    : [];

  let totalCost = 0;
  let totalHoldIncome = 0;
  let upCount = 0;
  let downCount = 0;

  // 至少有一个账户，并且没有任何账户明确返回 nav_update=false，
  // 才显示“更新完成”。
  let navUpdated = accounts.length > 0;

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

  // 未全部更新时不显示任何状态文字
  const updateText = navUpdated ? ' [更新完成]' : '';

  const subtitle =
    `${emoji}场内穿透 ` +
    `${signed(todayIncome)} (${signedRate(todayIncomeRate)})` +
    updateText;

  const up = todayIncome > 0;

  return {
    title: '养基宝',
    subtitle,
    body: '',
    upCount,
    downCount,
    navUpdated,
    totalCost,
    totalHoldIncome,
    totalIncomeRate,
    todayIncome,
    todayIncomeRate,
    icon:
      todayIncome > 0
        ? 'chart.line.uptrend.xyaxis'
        : todayIncome < 0
          ? 'chart.line.downtrend.xyaxis'
          : 'chart.line.flattrend.xyaxis',
    color:
      todayIncome > 0
        ? '#D9534F'
        : todayIncome < 0
          ? '#00A65A'
          : '#A0A0A0'
  };
}

function fmt(v) {
  const n = Number(v);

  if (isNaN(n)) return String(v);

  return n.toLocaleString('zh-CN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2
  });
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

function trendEmoji(value) {
  const n = Number(value);

  if (!isFinite(n) || n === 0) return '⚪️';
  return n > 0 ? '🔴' : '🟢';
}

function formatTime(d) {
  const p = (x) => String(x).padStart(2, '0');

  return (
    `${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

// 15:00及以后显示“较昨日”
function isAfter1500(d) {
  return d.getHours() >= 15;
}

// 养基宝通用接口
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
        $.logErr('[YJB] ' + path + ' error: ' + err);
        return resolve(null);
      }

      if (resp && resp.status && resp.status >= 400) {
        $.logErr(`[YJB] ${path} HTTP ${resp.status}`);
        return resolve(null);
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        $.logErr(`[YJB] ${path} JSON 解析失败`);
        resolve(null);
      }
    });
  });
}

// 获取指数和成交额显示行
async function fetchVipLines(token, ua) {
  const [idxRes, turnover] = await Promise.all([
    fetchAPI(token, ua, '/market/v1/quote/index-data'),
    fetchEastMoneyTurnover()
  ]);

  const lines = [];

  // 第三行固定分隔线
  lines.push('——————————');

  // 只显示上证指数和创业板指，删除深证成指
  const indexMap = {};

  if (idxRes && idxRes.data && Array.isArray(idxRes.data)) {
    for (const item of idxRes.data) {
      if (item && item.name) {
        indexMap[item.name] = item;
      }
    }
  }

  const indexNames = ['上证指数', '创业板指'];

  for (const name of indexNames) {
    const item = indexMap[name];

    if (!item) {
      lines.push(`⚪️${name} 暂无数据`);
      continue;
    }

    const point = Number(item.v);
    const changeRate = Number(item.dir);

    const pointText = isFinite(point)
      ? point.toFixed(0)
      : '--';

    const rateText = isFinite(changeRate)
      ? `${changeRate >= 0 ? '+' : ''}${changeRate.toFixed(2)}%`
      : '--';

    lines.push(
      `${trendEmoji(changeRate)}${name} ` +
      `${pointText}🔛${rateText}`
    );
  }

  // 成交额
  if (turnover && isFinite(turnover.today)) {
    let turnoverLine =
      `总成交额  ${formatTurnoverAmount(turnover.today)}`;

    if (
      isAfter1500(new Date()) &&
      isFinite(turnover.yesterday)
    ) {
      const difference = turnover.today - turnover.yesterday;

      turnoverLine +=
        `   [较昨日${formatTurnoverDifference(difference)}]`;
    }

    lines.push(turnoverLine);
  } else {
    lines.push('总成交额  暂无数据');
  }

  return lines;
}

// mode=vip 时也使用相同的完整通知格式，避免显示旧版行情内容
async function runVipCron(arg) {
  await runCron(arg);
}

// 东方财富：获取当前两市成交额及上一交易日成交额
async function fetchEastMoneyTurnover() {
  try {
    const currentRes = await fetchExternalJSON(
      EASTMONEY_QUOTE_API
    );

    const currentItems =
      currentRes &&
      currentRes.data &&
      Array.isArray(currentRes.data.diff)
        ? currentRes.data.diff
        : [];

    let shCurrent = NaN;
    let szCurrent = NaN;

    for (const item of currentItems) {
      if (!item) continue;

      const code = String(item.f12 || '');
      const amount = Number(item.f6);

      if (!isFinite(amount)) continue;

      if (code === '000001') {
        shCurrent = amount;
      } else if (code === '399001') {
        szCurrent = amount;
      }
    }

    const today =
      (isFinite(shCurrent) ? shCurrent : 0) +
      (isFinite(szCurrent) ? szCurrent : 0);

    if (!isFinite(today) || today <= 0) {
      $.log('[YJB] 东方财富实时成交额为空');
      return null;
    }

    let yesterday = NaN;

    // 只有15:00以后才查询昨日成交额，减少接口请求
    if (isAfter1500(new Date())) {
      const [shYesterday, szYesterday] = await Promise.all([
        fetchPreviousMarketTurnover('1.000001'),
        fetchPreviousMarketTurnover('0.399001')
      ]);

      if (
        isFinite(shYesterday) &&
        isFinite(szYesterday)
      ) {
        yesterday = shYesterday + szYesterday;
      }
    }

    return {
      today,
      yesterday
    };
  } catch (e) {
    $.logErr('[YJB] 东方财富成交额获取失败: ' + e);
    return null;
  }
}

// 查询某个市场指数最近的日K成交额，并取今天以前的最新一条
async function fetchPreviousMarketTurnover(secid) {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    `?secid=${encodeURIComponent(secid)}` +
    '&klt=101' +
    '&fqt=0' +
    '&lmt=10' +
    '&end=20500101' +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57';

  const json = await fetchExternalJSON(url);

  const klines =
    json &&
    json.data &&
    Array.isArray(json.data.klines)
      ? json.data.klines
      : [];

  if (!klines.length) return NaN;

  const todayKey = formatDateKey(new Date());
  const records = [];

  for (const line of klines) {
    const parts = String(line).split(',');

    // fields2：
    // f51 日期
    // f52 开盘
    // f53 收盘
    // f54 最高
    // f55 最低
    // f56 成交量
    // f57 成交额
    const date = parts[0];
    const amount = Number(parts[6]);

    if (
      date &&
      date < todayKey &&
      isFinite(amount)
    ) {
      records.push({
        date,
        amount
      });
    }
  }

  if (!records.length) return NaN;

  records.sort((a, b) => {
    return a.date < b.date ? 1 : -1;
  });

  return records[0].amount;
}

// 东方财富等外部JSON接口
function fetchExternalJSON(url) {
  const opts = {
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://quote.eastmoney.com/',
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 Mobile/15E148'
    }
  };

  return new Promise((resolve) => {
    $task_get(opts, (err, resp, body) => {
      if (err) {
        $.logErr('[YJB] 外部接口请求失败: ' + err);
        return resolve(null);
      }

      if (resp && resp.status && resp.status >= 400) {
        $.logErr(
          `[YJB] 外部接口 HTTP ${resp.status}: ${url}`
        );
        return resolve(null);
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        $.logErr('[YJB] 外部接口 JSON 解析失败: ' + url);
        resolve(null);
      }
    });
  });
}

// 成交额显示：不足1万亿显示“亿”，达到1万亿显示“万亿”
function formatTurnoverAmount(value) {
  const n = Number(value);

  if (!isFinite(n)) return '--';

  if (Math.abs(n) >= 1000000000000) {
    return trimTrailingZeros(n / 1000000000000, 2) + '万亿';
  }

  return trimTrailingZeros(n / 100000000, 2) + '亿';
}

// 较昨日固定使用“亿”
function formatTurnoverDifference(value) {
  const n = Number(value);

  if (!isFinite(n)) return '--';

  const amount = n / 100000000;

  return (
    (amount >= 0 ? '+' : '') +
    amount.toFixed(2) +
    '亿'
  );
}

function trimTrailingZeros(value, digits) {
  return Number(value).toFixed(digits)
    .replace(/\.?0+$/, '');
}

// 养基宝账户汇总
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
        $.logErr('[YJB] request error: ' + err);
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
      (r) => {
        cb(
          null,
          { status: r.statusCode },
          r.body
        );
      },
      (e) => {
        cb(e, null, null);
      }
    );
  } else {
    cb(new Error('不支持的运行环境'), null, null);
  }
}

function md5(s) {
  function safeAdd(x, y) {
    const lsw = (x & 0xffff) + (y & 0xffff);
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
    0x80 << ((n & 3) << 3);

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

  const toHex = (n) => {
    let s = '';

    for (let j = 0; j < 4; j++) {
      const value =
        (n >> (j * 8)) & 0xff;

      s +=
        (value < 16 ? '0' : '') +
        value.toString(16);
    }

    return s;
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
        `[${this.name}][ERR] ${
          (e && e.stack) || e
        }`
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