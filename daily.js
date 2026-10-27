// 睡眠 + 昨天全天 —— 纯逻辑,单测在 test/daily.test.js。
//
// 数据从哪来:她手机上的 Gadgetbridge 每次跟手环同步完,把最近 36 小时的睡眠
// (每段带手环自己记的整夜心率/血氧)和最近两天的日汇总 POST 到 /daily(见 gadgetbridge/ 补丁)。
//
// 用在哪(作者定的):**她醒来之后发的第一条消息**,心率行下面附一段昨晚的睡眠。
// 只给一次,不是每条都带 —— 一整天都一样,每条带只是白占他的上下文。
// 手环要醒来后同步一次才有睡眠结果,所以准确说是「睡眠数据到了之后她的第一条消息」。

const BJ = 8 * 3600e3;
const pad = (n) => String(n).padStart(2, "0");
const hm = (ms) => { const d = new Date(ms + BJ); return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
const bjDay = (ms) => new Date(ms + BJ).toISOString().slice(0, 10);
export function dur(min) {
  min = Math.round(min || 0);
  const h = Math.floor(min / 60), m = min % 60;
  return h ? (m ? `${h}小时${m}分` : `${h}小时`) : `${m}分钟`;
}
const num = (x) => (x == null || !Number.isFinite(+x) ? null : +x);

// 还没给他看过的睡眠段:醒来时间晚于 sentWake、而且是最近 18 小时内醒的(太旧的不提)
export function pendingSleep(daily, { now = Date.now(), sentWake = 0 } = {}) {
  const list = Array.isArray(daily?.sleep) ? daily.sleep : [];
  return list
    .filter((s) => num(s.start) && num(s.wake) && s.wake > sentWake && s.wake > now - 18 * 3600e3 && s.wake <= now + 60e3)
    .sort((a, b) => a.start - b.start);
}

// 分期(App 第 8 版起才有):每条是「从 t 起换成 st」,5 醒 3 浅 2 深 4 REM,0/1 不在睡。
// 把一段睡眠里的分期切成几段连续的睡:中间醒着/不在睡 ≥ SPLIT_MIN 分钟就断开。
// 为什么要:她睡了回笼觉,手环会把回笼觉并进同一晚、整段重算(比如 02:33–06:52 变成 02:33–09:59),
// 汇总里分不出哪段是夜里的。分期是一直在的,靠它拆回来。
const SPLIT_MIN = 20;
const ASLEEP = new Set([2, 3, 4]);
export function sleepParts(s, stages) {
  const pts = (Array.isArray(stages) ? stages : [])
    .filter((x) => num(x.t) != null && x.t >= s.start - 60e3 && x.t < s.wake)
    .sort((a, b) => a.t - b.t);
  if (!pts.length) return [];
  const runs = pts.map((x, i) => ({ st: +x.st, from: x.t, to: Math.min(i + 1 < pts.length ? pts[i + 1].t : s.wake, s.wake) }))
    .filter((r) => r.to > r.from);
  const parts = [];
  let cur = null;
  for (const r of runs) {
    const min = (r.to - r.from) / 60e3;
    if (ASLEEP.has(r.st)) {
      if (!cur) parts.push((cur = { start: r.from, end: r.to, deep: 0, light: 0, rem: 0, awake: 0, pend: 0 }));
      cur.awake += cur.pend; cur.pend = 0; cur.end = r.to;
      cur[r.st === 2 ? "deep" : r.st === 3 ? "light" : "rem"] += min;
    } else if (cur) {
      cur.pend += min;                                           // 醒着:先记着,后面又睡着了才算「中间醒着」
      if (cur.pend >= SPLIT_MIN) cur = null;
    }
  }
  return parts.map(({ pend, ...p }) => ({ ...p, total: p.deep + p.light + p.rem }));
}

const stageText = (p) => `深睡${dur(p.deep)} 浅睡${dur(p.light)} REM ${dur(p.rem)}` + (Math.round(p.awake) ? ` · 中间醒着${dur(p.awake)}` : "");

// 这一段里手环记的心率/血氧(mins 是 App 第 8 版起送的睡眠期间每分钟数据,t 是秒)
const vitalsText = (mins, from, to) => {
  const xs = (Array.isArray(mins) ? mins : []).filter((m) => m.t * 1000 >= from && m.t * 1000 <= to);
  const hr = xs.map((m) => num(m.hr)).filter((v) => v != null), o = xs.map((m) => num(m.o)).filter((v) => v != null);
  const avg = (a) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  let t = "";
  if (hr.length) t += ` · 心率 ${Math.min(...hr)}~${Math.max(...hr)},平均${avg(hr)}`;
  if (o.length) t += ` · 血氧平均${avg(o)}、最低${Math.min(...o)}`;
  return t;
};

function sleepLine(s, stages, mins) {
  const main = (s.total || 0) >= 180;                          // 3 小时以上算正经睡,以下算小睡/回笼觉
  const parts = sleepParts(s, stages).filter((p) => p.total >= 10);
  let t = `【${main ? "睡眠" : "小睡"} ${hm(s.start)}–${hm(s.wake)} · 睡着${dur(s.total)}`;
  if (s.deep || s.light || s.rem) t += `(${stageText(s)})`;
  else if (parts.length) {                                      // 手环汇总没分期(短觉常这样),用分期自己算
    const sum = parts.reduce((a, p) => ({ deep: a.deep + p.deep, light: a.light + p.light, rem: a.rem + p.rem, awake: 0 }), { deep: 0, light: 0, rem: 0 });
    t += `(${stageText(sum)})`;
  }
  if (num(s.hr_min) != null) t += ` · 这段时间心率 ${s.hr_min}~${s.hr_max},平均${Math.round(s.hr_avg)}`;
  // 血氧给平均和最低:平均看整体,最低看有没有掉下去过。最高没意义(正常都在 96~99)
  if (num(s.spo2_min) != null) {
    t += num(s.spo2_avg) != null ? ` · 血氧平均${Math.round(s.spo2_avg)}、最低${s.spo2_min}` : ` · 血氧最低${s.spo2_min}`;
  }
  t += "】";
  if (parts.length >= 2) {
    // 合并的那行留着,下面每段单独一行,各带各的分期、心率、血氧
    parts.forEach((p, i) => {
      const name = main ? (i === 0 ? "夜里" : "回笼觉") : `第${i + 1}段`;
      const gap = i ? ` · 前面醒了${dur((p.start - parts[i - 1].end) / 60e3)}` : "";
      t += `\n【分段${"①②③④⑤⑥"[i] || i + 1} ${name} ${hm(p.start)}–${hm(p.end)}${gap} · 睡着${dur(p.total)}(${stageText(p)})${vitalsText(mins, p.start, p.end)}】`;
    });
  }
  return t;
}

function dayLine(d, label) {
  const parts = [];
  if (num(d.steps) != null) parts.push(`${d.steps} 步`);
  if (num(d.hr_resting) != null) parts.push(`静息心率${d.hr_resting}`);
  if (num(d.stress_avg) != null) parts.push(`压力平均${d.stress_avg}(最高${d.stress_max ?? "?"})`);
  if (num(d.spo2_avg) != null) parts.push(`血氧平均${d.spo2_avg}`);
  if (num(d.calories) != null) parts.push(`活动消耗${d.calories}千卡`);
  return parts.length ? `【${label}全天 · ${parts.join(" · ")}】` : "";
}

// 返回 { text, wake }:text 塞进消息,wake 记下来当下次的 sentWake。没有新睡眠 → text 为空。
export function dailyBlock(daily, { now = Date.now(), sentWake = 0 } = {}) {
  const pend = pendingSleep(daily, { now, sentWake });
  if (!pend.length) return { text: "", wake: sentWake };
  const lines = pend.map((s) => sleepLine(s, daily.stages, daily.mins));
  // 有正经睡的那段,才顺带给「昨天全天」—— 小睡/午睡不重复报
  if (pend.some((s) => (s.total || 0) >= 180)) {
    const yday = bjDay(now - 86400e3);
    const d = (Array.isArray(daily?.days) ? daily.days : []).find((x) => num(x.day) && bjDay(x.day) === yday);
    const dl = d && dayLine(d, "昨天");
    if (dl) lines.push(dl);
  }
  return { text: lines.join("\n"), wake: Math.max(...pend.map((s) => s.wake)) };
}
