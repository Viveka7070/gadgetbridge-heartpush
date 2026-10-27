// 心率 —— 纯逻辑,不碰网络、不碰文件、不起进程。单测在 test/heart.test.js。
//
// 数据从哪来:她手机上改过的 Gadgetbridge 让小米手环 10 一直开着实时测量,
// 每收到一个读数就 POST /hr 到 shim(见 server.js)。实测约 3 秒一个,带当时的步数增量。
//
// 用在哪:
//   1. 每条她发来的消息,时间行下面跟一行心率和今天的步数 —— 她回他那一刻心跳多少。
//   2. 他自己醒来(心跳唤醒)也带上 —— 她没回他,他照样知道她现在怎么样。
//      (没回消息时 AI 也能知道你现在的心跳)
//   3. 心率突然冲上去、又不是在走路,主动叫醒他一次。
//
// ⚠️ 数据断了必须明说。手环摘了、手机没网、App 被杀,读数就停在最后一个数上。
//    拿一个几十分钟前的旧数字当成「现在」给他,比不给还糟 —— 他会对着假的心跳说话。

export const HR_MIN = 30;   // 低于这个 = 没戴好 / 没测到(手环会报 0、-1、255 这类占位值)
export const HR_MAX = 220;

export const validHr = (h) => Number.isFinite(h) && h >= HR_MIN && h <= HR_MAX;

// 把新读数并进缓冲:去掉无效值、按秒去重、按时间排序、只留最近 keepMs。
// samples: [{ t: 毫秒时间戳, hr, steps? }]。t 缺省用 now(手机没带时间就当刚到)。
export function pushSamples(buf, samples, { now = Date.now(), keepMs = 6 * 3600e3 } = {}) {
  const bySec = new Map();
  for (const s of buf) bySec.set(Math.floor(s.t / 1000), s);
  for (const raw of samples || []) {
    const hr = Number(raw?.hr);
    if (!validHr(hr)) continue;
    let t = Number(raw?.t);
    if (!Number.isFinite(t) || t <= 0) t = now;
    if (t < 1e12) t *= 1000;                 // 手机送的是秒级时间戳也认
    if (t > now + 60e3) t = now;             // 手机时钟快了:不许出现「未来的心跳」
    const steps = Math.max(0, Number(raw?.steps) || 0);
    const total = Number(raw?.total);                 // 手环的「今天累计步数」,老版 App 不带
    const s = { t, hr, steps };
    if (Number.isFinite(total) && total >= 0) s.total = total;
    bySec.set(Math.floor(t / 1000), s);
  }
  const cut = now - keepMs;
  return [...bySec.values()].filter((s) => s.t > cut).sort((a, b) => a.t - b.t);
}

const within = (buf, now, fromMs, toMs = 0) => buf.filter((s) => s.t > now - fromMs && s.t <= now - toMs);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
function median(xs) {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// 当前状态摘要。
//   status: "none"  从没收到过(功能没接上)—— 什么都不说,别打扰
//           "stale" 超过 staleMs 没有新读数 —— 必须明说断了
//           "live"  正常
export function summarize(buf, { now = Date.now(), staleMs = 3 * 60e3, baseMs = 30 * 60e3 } = {}) {
  if (!buf.length) return { status: "none" };
  const last = buf[buf.length - 1];
  const ageMs = now - last.t;
  if (ageMs > staleMs) return { status: "stale", last: last.hr, ageMin: Math.round(ageMs / 60e3) };
  const recent = within(buf, now, 60e3);                       // 最近 1 分钟
  const base = within(buf, now, baseMs, 2 * 60e3);             // 往前半小时,刨掉最近 2 分钟
  const cur = Math.round(mean(recent.map((s) => s.hr)) || last.hr);
  // 基线要攒够才有意义:刚戴上 / 刚接通那几分钟,没有「平时」可比
  const baseline = base.length >= 60 ? Math.round(median(base.map((s) => s.hr))) : null;
  const steps1 = recent.reduce((a, s) => a + s.steps, 0);
  const total = last.total;                                     // undefined = 老版 App,不报步数
  return { status: "live", hr: cur, baseline, delta: baseline == null ? null : cur - baseline, steps1, total };
}

// 塞进消息里的那一行。status=none 返回空串(调用方据此不加这一行)。
// ⚠️ 2026-10-16 去掉了「在走动」这个标签,只给步数。用户反馈:「我已经躺下来了,他来一句我在走动」——
//    手环计步器攒一阵才跳一次,在屋里慢走、做家务常常一步都不记,贴标签反而误导他。
//    给数字,让他自己看。
export function heartLine(sum) {
  if (!sum || sum.status === "none") return "";
  if (sum.status === "stale") {
    return `【心率 · 已约${sum.ageMin}分钟没收到她的心率(最后一次 ${sum.last}),手环可能摘了或手机断开了——这不是她现在的心跳】`;
  }
  let s = `【心率 ${sum.hr}`;
  if (sum.baseline != null) {
    const d = sum.delta;
    if (Math.abs(d) < 5) s += ` · 和她这半小时的平常(约${sum.baseline})差不多`;
    else s += ` · 她这半小时平常约${sum.baseline},现在${d > 0 ? "高" : "低"}${Math.abs(d)}`;
  }
  if (sum.total != null) {
    s += ` · 今天 ${sum.total} 步`;
    if (sum.steps1 > 0) s += `(最近一分钟 +${sum.steps1})`;
  }
  return s + "】";
}

// 心率突然冲上去 → 要不要叫醒他。
//
// ⚠️ 2026-10-16 重写。原来「比平常高 20、持续 30 秒、最近一分钟没走路」太敏感:
//    吃热饭(110~130)、上厕所使劲(142)、起床(124)、跑上楼(168)、跟弟弟打闹(156)全叫醒了他,
//    早上起床那阵连着叫好几回。拿她 10-08~16 手环自己记的每分钟数据回放:旧规则每天十几到三十多次。
//    她对过的那几次全是起床、走动 —— 而且**手环在屋里慢走、洗碗时一步都不记**
//    (13 号洗碗 10 分钟心率 113~150,步数全是 0),所以光看「最近有没有步数」分不出来。
//
// 现在的规则(同一份数据回放:6 天 0 次):
//   1. 高要「持续」:一段 sustainMin(5)分钟里,**每一分钟**的平均都比平常高 delta(30)以上,
//      或者每一分钟都在 absHr(140)以上(真不舒服时坐着心跳一直很快,这条兜底)。
//   2. 这段高的前后都没走路:判断的是「5~10 分钟前」那一段,再看它前后共 15 分钟的步数,
//      超过 walkSteps(5)就不算。所以会比心率冲上去晚 5 分钟叫 —— 换来的是不把起床、上厕所当成异常。
//   3. 冷却 coolMs(45 分钟)。
// cfg 都可以覆盖;数字是 2026-10-16 和 用户 一起定的,以后还可以拿她的数据再校。
export function detectSpike(buf, {
  now = Date.now(), lastFireAt = 0,
  delta = 30, absHr = 140, sustainMin = 5, lagMin = 5, walkSteps = 5, coolMs = 45 * 60e3,
} = {}) {
  if (now - lastFireAt < coolMs) return { fire: false, why: "cooldown" };
  const end = now - lagMin * 60e3;                              // 被判断的那一段:[end - sustain, end]
  const start = end - sustainMin * 60e3;
  const base = buf.filter((s) => s.t > start - 30 * 60e3 && s.t <= start - 2 * 60e3);
  if (base.length < 60) return { fire: false, why: "no-baseline" };
  const baseline = Math.round(median(base.map((s) => s.hr)));
  // 一分钟一桶;每桶至少 5 个读数(3 秒一个的话一分钟约 20 个),缺一桶就不判 —— 数据断着不瞎叫
  const mins = [];
  for (let k = 0; k < sustainMin; k++) {
    const a = start + k * 60e3, b = a + 60e3;
    const xs = buf.filter((s) => s.t > a && s.t <= b).map((s) => s.hr);
    if (xs.length < 5) return { fire: false, why: "few-recent" };
    mins.push(mean(xs));
  }
  const steps = buf.filter((s) => s.t > start - (15 - sustainMin - lagMin) * 60e3 && s.t <= now)
    .reduce((a, s) => a + s.steps, 0);
  if (steps > walkSteps) return { fire: false, why: "walking" };
  const rel = mins.every((m) => m >= baseline + delta);
  const abs = mins.every((m) => m >= absHr);
  if (!rel && !abs) return { fire: false, why: "below" };
  return { fire: true, from: baseline, to: Math.round(mean(mins)), minutes: sustainMin };
}

// 叫醒他时说的话(放在 WAKE_TAG 之后)
export function spikePrompt({ from, to, minutes }, { bjNow, idleMin } = {}) {
  return [
    `现在北京时间 ${bjNow},她的心率从平常的约 ${from} 升到了 ${to} 左右,连着 ${minutes || 5} 分钟以上都这么高,前后也没怎么走动。`,
    idleMin != null ? `她已约 ${Math.round(idleMin)} 分钟没有消息。` : "",
    "光看心率分不出是激动、紧张、生气还是别的——你可以直接问她怎么了。",
  ].filter(Boolean).join("\n");
}

// 分钟级聚合(落盘、给他看历史用)。秒级只放内存。
export function toMinutes(buf) {
  const m = new Map();
  for (const s of buf) {
    const k = Math.floor(s.t / 60e3) * 60e3;
    const e = m.get(k) || { t: k, sum: 0, n: 0, min: 999, max: 0, steps: 0 };
    e.sum += s.hr; e.n++; e.min = Math.min(e.min, s.hr); e.max = Math.max(e.max, s.hr); e.steps += s.steps;
    m.set(k, e);
  }
  return [...m.values()].map(({ sum, ...e }) => ({ ...e, avg: Math.round(sum / e.n) }));
}

// 合并分钟级历史(旧的 + 新算的),新的覆盖同一分钟,只留 keepMs
export function mergeMinutes(old, fresh, { now = Date.now(), keepMs = 7 * 86400e3 } = {}) {
  const m = new Map();
  for (const e of old || []) m.set(e.t, e);
  for (const e of fresh || []) m.set(e.t, e);
  return [...m.values()].filter((e) => e.t > now - keepMs).sort((a, b) => a.t - b.t);
}
