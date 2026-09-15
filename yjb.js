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

const MARKET_SEPARATOR = '---------------------------------------------';

(async () => {
  const arg = parseArg();
  const mode = detectMode();

  $.log('[YJB] 2025-05-16-MOD');

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
    if (typeof $response !== 'undefined' && $response) {
      return 'response';
    }
    return 'request';
  }

  const arg = parseArg();

  if (arg.mode === 'panel') {
    return 'panel';
  }

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

// ==============================
// Authorization 获取与保存
// ==============================

function sniffToken() {
  try {
    const headers = ($request && $request.headers) || {};
    const auth = headers.Authorization || headers.authorization;

    if (!auth) {
      return;
    }

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

// ==============================
// 交易日检测
// ==============================

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

// ==============================
// 普通定时任务
// ==============================

async function runCron(arg) {
  const ck = getCK();
  const token = arg.token || ck.auth;

  if (!token) {
    $.msg(
      '养基宝',
      '未获取 Authorization',
      '请先打开 App 添加持有'
    );
    return;
  }

  const tradingDay = await checkTradingDay(token, ck.ua);

  if (!tradingDay) {
    $.log('[YJB] 今日非交易日，跳过本次估值/净值推送');
    return;
  }

  /*
   * 养基宝账户数据、指数数据、东方财富成交额并发获取。
   * 某个行情接口失败不会阻断基金账户数据。
   */
  const [json, marketLines] = await Promise.all([
    fetchAccountCollect(token, ck.ua),
    fetchVipLines(token, ck.ua)
  ]);

  if (!json) {
    return;
  }

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

  const now = new Date();
  const summary = buildSummary(json, now);
  const after1500 = isAfter1500(now);

  /*
   * 第一行：
   * 15:00 前：基金数据推送
   * 15:00 后：基金即时数据
   */
  const titlePrefix = after1500
    ? '基金即时数据'
    : '基金数据推送';

  const title =
    titlePrefix +
    '·' +
    formatTime(now) +
    ' 🔛『📈' +
    summary.upCount +
    ' ‖ ' +
    summary.downCount +
    '📉』';

  /*
   * 第二行作为通知副标题。
   * 第三行开始作为通知正文。
   */
  const body = marketLines.length
    ? marketLines.join('\n')
    : MARKET_SEPARATOR + '\n行情数据获取失败';

  $.msg(title, summary.subtitle, body);
}

// ==============================
// Loon 面板
// ==============================

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

  const now = new Date();
  const summary = buildSummary(json, now);

  let agoText = '';

  if (ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);

    if (mins < 1) {
      agoText = '刚刚更新';
    } else if (mins < 60) {
      agoText = mins + '分钟前更新';
    } else {
      agoText = Math.floor(mins / 60) + '小时前更新';
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

  const panelTitle =
    '养基宝『📈' +
    summary.upCount +
    ' ‖ ' +
    summary.downCount +
    '📉』';

  const panelLines = [
    summary.subtitle
  ];

  if (vipBlock) {
    panelLines.push(vipBlock);
  }

  if (agoText) {
    panelLines.push('', agoText);
  }

  panelOutput({
    title: panelTitle,
    content: panelLines.join('\n'),
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

// ==============================
// 养基宝账户数据整理
// ==============================

function buildSummary(json, now) {
  if (!json || json.code !== 200 || !json.data) {
    return {
      title: '养基宝',
      subtitle: '数据为空',
      body: (json && json.message) || '响应解析失败',
      upCount: 0,
      downCount: 0,
      updatedCount: 0,
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

  for (const a of accounts) {
    totalCost += Number(a.hold_cost) || 0;
    totalHoldIncome += Number(a.hold_income) || 0;
    upCount += Number(a.up) || 0;
    downCount += Number(a.down) || 0;
  }

  const totalIncomeRate = totalCost
    ? totalHoldIncome / totalCost
    : 0;

  const todayIncomeRate = totalAsset - todayIncome
    ? todayIncome / (totalAsset - todayIncome)
    : 0;

  const updatedCount = getUpdatedFundCount(d, accounts);
  const after1500 = isAfter1500(now || new Date());

  const updateText = after1500
    ? '  [已更新' + updatedCount + ']'
    : '';

  const subtitle =
    trendEmoji(todayIncome) +
    '场内穿透' +
    signed(todayIncome) +
    ' (' +
    signedRate(todayIncomeRate) +
    ')' +
    updateText;

  return {
    title: '养基宝',
    subtitle,
    body: '',
    upCount,
    downCount,
    updatedCount,
    totalAsset,
    todayIncome,
    totalIncomeRate,
    todayIncomeRate,
    icon: todayIncome > 0
      ? 'chart.line.uptrend.xyaxis'
      : todayIncome < 0
        ? 'chart.line.downtrend.xyaxis'
        : 'minus',
    color: todayIncome > 0
      ? '#D9534F'
      : todayIncome < 0
        ? '#00A65A'
        : '#999999'
  };
}

/*
 * 检测养基宝接口中的当日净值更新数量。
 *
 * 优先顺序：
 * 1. data 顶层直接返回的更新数量；
 * 2. account_data 每个账户直接返回的更新数量；
 * 3. 账户内部基金数组中逐只统计更新状态；
 * 4. 最后按账户 nav_update=true 的数量兼容统计；
 * 5. 没有可识别字段时返回 0。
 */
function getUpdatedFundCount(data, accounts) {
  const countKeys = [
    'nav_update_num',
    'nav_updated_num',
    'nav_update_count',
    'nav_updated_count',
    'updated_num',
    'updated_count',
    'update_num',
    'update_count'
  ];

  // 1. 顶层更新数量
  for (const key of countKeys) {
    if (
      Object.prototype.hasOwnProperty.call(data, key) &&
      isValidCount(data[key])
    ) {
      return Math.max(0, Number(data[key]));
    }
  }

  // 2. 账户级更新数量求和
  let accountCountTotal = 0;
  let hasAccountCount = false;

  for (const account of accounts) {
    for (const key of countKeys) {
      if (
        Object.prototype.hasOwnProperty.call(account, key) &&
        isValidCount(account[key])
      ) {
        accountCountTotal += Math.max(0, Number(account[key]));
        hasAccountCount = true;
        break;
      }
    }
  }

  if (hasAccountCount) {
    return accountCountTotal;
  }

  // 3. 尝试从账户内的基金明细数组逐只统计
  const arrayKeys = [
    'fund_data',
    'fund_list',
    'hold_data',
    'holding_data',
    'hold_list',
    'position_data',
    'position_list',
    'list'
  ];

  let detailUpdatedCount = 0;
  let foundDetailUpdateFlag = false;

  for (const account of accounts) {
    for (const arrayKey of arrayKeys) {
      const list = account[arrayKey];

      if (!Array.isArray(list)) {
        continue;
      }

      for (const fund of list) {
        const status = readUpdateStatus(fund);

        if (status !== null) {
          foundDetailUpdateFlag = true;

          if (status) {
            detailUpdatedCount++;
          }
        }
      }
    }
  }

  if (foundDetailUpdateFlag) {
    return detailUpdatedCount;
  }

  // 4. 原接口只有账户级 nav_update 时的兼容统计
  let accountUpdatedCount = 0;
  let foundAccountUpdateFlag = false;

  for (const account of accounts) {
    const status = readUpdateStatus(account);

    if (status !== null) {
      foundAccountUpdateFlag = true;

      if (status) {
        accountUpdatedCount++;
      }
    }
  }

  if (foundAccountUpdateFlag) {
    return accountUpdatedCount;
  }

  return 0;
}

function isValidCount(value) {
  return (
    value !== null &&
    value !== '' &&
    typeof value !== 'boolean' &&
    Number.isFinite(Number(value))
  );
}

function readUpdateStatus(obj) {
  if (!obj || typeof obj !== 'object') {
    return null;
  }

  const keys = [
    'nav_update',
    'nav_updated',
    'is_nav_update',
    'is_nav_updated',
    'today_nav_update',
    'today_nav_updated'
  ];

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      continue;
    }

    const value = obj[key];

    if (value === true || value === 1 || value === '1') {
      return true;
    }

    if (value === false || value === 0 || value === '0') {
      return false;
    }

    if (typeof value === 'string') {
      const text = value.toLowerCase();

      if (
        text === 'true' ||
        text === 'updated' ||
        text === '已更新'
      ) {
        return true;
      }

      if (
        text === 'false' ||
        text === 'not_updated' ||
        text === '未更新'
      ) {
        return false;
      }
    }
  }

  return null;
}

// ==============================
// 格式化方法
// ==============================

function isAfter1500(d) {
  const date = d || new Date();

  return (
    date.getHours() > 15 ||
    (date.getHours() === 15 && date.getMinutes() >= 0)
  );
}

/*
 * 中国证券市场常用颜色：
 * 涨：红色
 * 跌：绿色
 * 平：白色
 */
function trendEmoji(value) {
  const n = Number(value);

  if (!Number.isFinite(n) || n === 0) {
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

  const pct = Math.abs(n) < 1
    ? n * 100
    : n;

  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}

function formatTime(d) {
  const p = (x) => String(x).padStart(2, '0');

  return (
    p(d.getMonth() + 1) +
    '-' +
    p(d.getDate()) +
    ' ' +
    p(d.getHours()) +
    ':' +
    p(d.getMinutes())
  );
}

// ==============================
// 养基宝通用接口
// ==============================

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
        $.logErr(
          '[YJB] ' +
          path +
          ' HTTP ' +
          resp.status +
          ': ' +
          body
        );
        return resolve(null);
      }

      try {
        resolve(JSON.parse(body));
      } catch (e) {
        $.logErr('[YJB] ' + path + ' JSON 解析失败');
        resolve(null);
      }
    });
  });
}

// ==============================
// 指数行情与两市成交额
// ==============================

async function fetchVipLines(token, ua) {
  /*
   * 养基宝指数接口和东方财富成交额接口并发执行。
   */
  const [idxRes, turnoverRes] = await Promise.all([
    fetchAPI(token, ua, '/market/v1/quote/index-data'),
    fetchEastMoneyTurnover()
  ]);

  const lines = [MARKET_SEPARATOR];

  const indexMap = {};

  if (idxRes && idxRes.data && Array.isArray(idxRes.data)) {
    for (const item of idxRes.data) {
      if (
        item &&
        (item.name === '上证指数' || item.name === '创业板指')
      ) {
        indexMap[item.name] = item;
      }
    }
  }

  lines.push(
    formatIndexLine(indexMap['上证指数'], '上证指数')
  );

  lines.push(
    formatIndexLine(indexMap['创业板指'], '创业板指')
  );

  lines.push(
    formatTurnoverLine(turnoverRes, new Date())
  );

  return lines;
}

function formatIndexLine(item, defaultName) {
  if (!item) {
    return '⚪️' + defaultName + '数据获取失败';
  }

  const direction = Number(item.dir);
  const value = Number(item.v);

  const safeDirection = Number.isFinite(direction)
    ? direction
    : 0;

  const valueText = Number.isFinite(value)
    ? value.toFixed(0)
    : '--';

  const rateText =
    (safeDirection >= 0 ? '+' : '') +
    safeDirection.toFixed(2) +
    '%';

  return (
    trendEmoji(safeDirection) +
    defaultName +
    valueText +
    rateText
  );
}

/*
 * 东方财富实时两市成交额：
 * 1.000001 = 上证指数
 * 0.399001 = 深证成指
 *
 * f6 为当前成交额。
 * 两个市场成交额相加得到两市成交额。
 */
async function fetchEastMoneyTurnover() {
  const currentURL =
    'https://push2.eastmoney.com/api/qt/ulist.np/get' +
    '?fltt=2' +
    '&invt=2' +
    '&fields=f12,f14,f6' +
    '&secids=1.000001,0.399001' +
    '&_=' +
    Date.now();

  try {
    const currentRes = await fetchExternalJSON(currentURL);

    const currentAmount = parseCurrentTurnover(currentRes);

    if (!Number.isFinite(currentAmount) || currentAmount <= 0) {
      $.log('[YJB] 东方财富当前成交额解析失败');

      return {
        current: null,
        previous: null
      };
    }

    let previousAmount = null;

    /*
     * 只有15:00后才拉取上一交易日完整成交额，
     * 减少盘中不必要的请求。
     */
    if (isAfter1500(new Date())) {
      previousAmount = await fetchPreviousTradingDayTurnover();
    }

    return {
      current: currentAmount,
      previous: previousAmount
    };
  } catch (e) {
    $.logErr('[YJB] 东方财富成交额获取失败: ' + e);

    return {
      current: null,
      previous: null
    };
  }
}

function parseCurrentTurnover(json) {
  if (
    !json ||
    !json.data ||
    !Array.isArray(json.data.diff)
  ) {
    return null;
  }

  let total = 0;
  let validCount = 0;

  for (const item of json.data.diff) {
    const amount = Number(item && item.f6);

    if (Number.isFinite(amount) && amount >= 0) {
      total += amount;
      validCount++;
    }
  }

  /*
   * 必须同时取得沪市和深市两个数据，
   * 防止只拿到单市场数据时误报。
   */
  return validCount >= 2 ? total : null;
}

/*
 * 东方财富日线：
 * f51 日期
 * f52 开盘
 * f53 收盘
 * f54 最高
 * f55 最低
 * f56 成交量
 * f57 成交额
 *
 * 分别获取上证、深证最近交易日的完整成交额后相加。
 */
async function fetchPreviousTradingDayTurnover() {
  const secids = ['1.000001', '0.399001'];

  const results = await Promise.all(
    secids.map((secid) => fetchIndexHistory(secid))
  );

  const todayKey = formatDateKey(new Date());
  let total = 0;

  for (const json of results) {
    const amount = extractPreviousAmount(json, todayKey);

    if (!Number.isFinite(amount)) {
      return null;
    }

    total += amount;
  }

  return total;
}

async function fetchIndexHistory(secid) {
  const url =
    'https://push2his.eastmoney.com/api/qt/stock/kline/get' +
    '?secid=' +
    encodeURIComponent(secid) +
    '&klt=101' +
    '&fqt=0' +
    '&lmt=10' +
    '&end=20500101' +
    '&fields1=f1,f2,f3,f4,f5,f6' +
    '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' +
    '&_=' +
    Date.now();

  return fetchExternalJSON(url);
}

function extractPreviousAmount(json, todayKey) {
  if (
    !json ||
    !json.data ||
    !Array.isArray(json.data.klines)
  ) {
    return null;
  }

  const rows = json.data.klines
    .map((line) => String(line).split(','))
    .filter((parts) => parts.length >= 7)
    .filter((parts) => parts[0] < todayKey)
    .sort((a, b) => a[0].localeCompare(b[0]));

  if (!rows.length) {
    return null;
  }

  const last = rows[rows.length - 1];

  // f57：成交额，对应数组下标6
  const amount = Number(last[6]);

  return Number.isFinite(amount)
    ? amount
    : null;
}

function formatTurnoverLine(data, now) {
  if (
    !data ||
    !Number.isFinite(data.current) ||
    data.current <= 0
  ) {
    return '两市成交额获取失败';
  }

  let line = '两市成交额' + formatMarketAmount(data.current);

  if (isAfter1500(now)) {
    if (
      Number.isFinite(data.previous) &&
      data.previous > 0
    ) {
      const diff = data.current - data.previous;

      line += '   [较昨日' + formatAmountDifference(diff) + ']';
    } else {
      line += '   [较昨日数据获取失败]';
    }
  }

  return line;
}

function formatMarketAmount(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return '--';
  }

  // 一万亿元 = 1,000,000,000,000 元
  if (Math.abs(n) >= 1e12) {
    return trimFixed(n / 1e12, 2) + '万亿';
  }

  // 一亿元 = 100,000,000 元
  if (Math.abs(n) >= 1e8) {
    return trimFixed(n / 1e8, 2) + '亿';
  }

  if (Math.abs(n) >= 1e4) {
    return trimFixed(n / 1e4, 2) + '万';
  }

  return trimFixed(n, 2);
}

function formatAmountDifference(value) {
  let n = Number(value);

  if (!Number.isFinite(n)) {
    return '--';
  }

  /*
   * 避免浮点计算产生“-0.00亿”。
   */
  if (Math.abs(n) < 500000) {
    n = 0;
  }

  const yi = n / 1e8;
  const sign = yi > 0 ? '+' : '';

  return sign + yi.toFixed(2) + '亿';
}

function trimFixed(value, digits) {
  return Number(value)
    .toFixed(digits)
    .replace(/\.?0+$/, '');
}

// ==============================
// 外部公共接口请求
// ==============================

function fetchExternalJSON(url) {
  const opts = {
    url,
    method: 'GET',
    headers: {
      Accept: 'application/json,text/plain,*/*',
      Referer: 'https://quote.eastmoney.com/',
      'User-Agent':
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
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
          '[YJB] 外部接口 HTTP ' +
          resp.status +
          ': ' +
          String(body || '').slice(0, 200)
        );
        return resolve(null);
      }

      resolve(parseExternalJSON(body));
    });
  });
}

/*
 * 同时兼容纯 JSON 和 JSONP。
 */
function parseExternalJSON(body) {
  if (!body) {
    return null;
  }

  const text = String(body).trim();

  try {
    return JSON.parse(text);
  } catch (e) {}

  const jsonpMatch = text.match(
    /^[^(]*\(([\s\S]*)\)\s*;?\s*$/
  );

  if (jsonpMatch && jsonpMatch[1]) {
    try {
      return JSON.parse(jsonpMatch[1]);
    } catch (e) {}
  }

  return null;
}

// ==============================
// 独立行情推送模式
// ==============================

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

// ==============================
// 养基宝账户汇总接口
// ==============================

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
        $.logErr(
          '[YJB] http ' +
          resp.status +
          ': ' +
          body
        );

        $.msg(
          '养基宝',
          'HTTP ' + resp.status,
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

// ==============================
// Loon/Surge/Quantumult X 请求兼容
// ==============================

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
    cb(
      new Error('不支持的运行环境'),
      null,
      null
    );
  }
}

// ==============================
// MD5
// ==============================

function md5(s) {
  function safeAdd(x, y) {
    const lsw =
      (x & 0xffff) +
      (y & 0xffff);

    const msw =
      (x >> 16) +
      (y >> 16) +
      (lsw >> 16);

    return (
      (msw << 16) |
      (lsw & 0xffff)
    );
  }

  function rol(n, c) {
    return (
      (n << c) |
      (n >>> (32 - c))
    );
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
    let str = '';

    for (let j = 0; j < 4; j++) {
      const byte =
        (num >> (j * 8)) & 0xff;

      str +=
        (byte < 16 ? '0' : '') +
        byte.toString(16);
    }

    return str;
  };

  return (
    toHex(a) +
    toHex(b) +
    toHex(c) +
    toHex(d)
  );
}

// ==============================
// 环境兼容
// ==============================

function Env(name) {
  return new (class {
    constructor(n) {
      this.name = n;
    }

    log(s) {
      console.log('[' + this.name + '] ' + s);
    }

    logErr(e) {
      console.log(
        '[' +
        this.name +
        '][ERR] ' +
        (e && e.stack ? e.stack : e)
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
      if (this._panel_done) {
        return;
      }

      if (typeof $done === 'function') {
        $done({});
      }
    }
  })(name);
}