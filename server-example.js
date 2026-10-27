// 心率 / 睡眠接收端 —— 最小可运行示例(Node 20+,依赖 express)
//
//   npm install express
//   HR_TOKEN=换成你自己生成的随机串 node server-example.js
//
// 手机上的改版 Gadgetbridge 会:
//   POST /hr     每 ~3 秒一批实时心率   {"samples":[{"t":毫秒,"hr":72,"steps":0,"total":3458}, ...]}
//   POST /daily  每次和手环同步完一份   {"t":毫秒,"sleep":[...],"stages":[...],"mins":[...],"days":[...]}
// 都带 Authorization: Bearer <HR_TOKEN>
//
// 这里只演示「收数据 → 算出要塞进对话的那几行」。怎么把这几行拼进你的 AI 对话,
// 看教程第七步:每条用户消息前面加 heartNowLine() + dailyTake(),AI 自主醒来时加 heartNowLine()。

import express from "express";
import fs from "fs";
import { pushSamples, summarize, heartLine, detectSpike, spikePrompt } from "./heart.js";
import { dailyBlock } from "./daily.js";

const HR_TOKEN = process.env.HR_TOKEN || "";
const DATA_DIR = process.env.DATA_DIR || "./data";          // 要放在持久化的盘上,重启不丢
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: "2mb" }));
const authed = (req) => !!HR_TOKEN && (req.get("authorization") || "").replace(/^Bearer\s+/i, "") === HR_TOKEN;

// ---- 实时心率 ----
let heartBuf = [];               // 只在内存里留 6 小时,秒级
let lastSpikeAt = 0;
app.post("/hr", (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false });
  const b = req.body || {};
  heartBuf = pushSamples(heartBuf, Array.isArray(b.samples) ? b.samples : [b]);
  // 冲高检查:持续高了 5 分钟、前后没走路 → 叫醒 AI 一次(45 分钟冷却)
  const r = detectSpike(heartBuf, { lastFireAt: lastSpikeAt });
  if (r.fire) {
    lastSpikeAt = Date.now();
    wakeAI(spikePrompt(r, { bjNow: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }));
  }
  res.json({ ok: true });
});
// 每条消息带的那一行,例如:【心率 88 · 和她这半小时的平常(约85)差不多 · 今天 3458 步(最近一分钟 +12)】
export const heartNowLine = () => heartLine(summarize(heartBuf));

// ---- 睡眠 + 昨天全天 ----
const DAILY_FILE = `${DATA_DIR}/daily.json`, SENT_FILE = `${DATA_DIR}/daily-sent.json`;
let daily = null, sentWake = Date.now() - 6 * 3600e3;    // 第一次上线不把旧的几晚一股脑倒出来
try { daily = JSON.parse(fs.readFileSync(DAILY_FILE, "utf8")); } catch {}
try { sentWake = JSON.parse(fs.readFileSync(SENT_FILE, "utf8")).wake || sentWake; } catch {}
app.post("/daily", (req, res) => {
  if (!authed(req)) return res.status(401).json({ ok: false });
  const b = req.body || {};
  daily = { t: Date.now(), sleep: b.sleep || [], stages: b.stages || [], mins: b.mins || [], days: b.days || [] };
  fs.writeFileSync(DAILY_FILE, JSON.stringify(daily));
  res.json({ ok: true });
});
// 醒来后第一条消息才有内容,给过一次就记下,不重复给
export function dailyTake() {
  if (!daily) return "";
  const r = dailyBlock(daily, { sentWake });
  if (!r.text) return "";
  sentWake = r.wake;
  fs.writeFileSync(SENT_FILE, JSON.stringify({ wake: r.wake }));
  return r.text;
}

// ---- 接到你自己的 AI 上 ----
// 下面两个函数是占位:换成你的后端里「给 AI 发一轮消息」的那段代码
function wakeAI(text) { console.log("[叫醒 AI]", text); }
export function buildUserTurn(userText) {
  const lines = [heartNowLine(), dailyTake()].filter(Boolean).join("\n");
  return lines ? `${lines}\n${userText}` : userText;
}

app.get("/heart", (req, res) => {           // 排障用:看现在收到了什么
  if (!authed(req)) return res.status(401).json({ ok: false });
  res.json({ line: heartNowLine(), buffered: heartBuf.length, daily: daily && { at: daily.t, sleep: daily.sleep.length } });
});

const PORT = +process.env.PORT || 8080;
if (process.argv[1] && process.argv[1].endsWith("server-example.js")) {
  app.listen(PORT, () => console.log("listening on", PORT));
}
