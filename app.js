// 吉隆坡 Rapid 公交实时追踪 —— 前端主程序
const CFG = window.APP_CONFIG;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---------- 本地存储 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  routes: [],            // 全部线路（routes.json）
  follow: [],            // 关注的线路 key
  current: null,         // 当前线路 key
  routeData: {},         // key -> 线路详情
  dirIdx: 0,             // 当前方向
  myStops: store.get("myStops", {}),   // key -> stopId
  live: null,            // 最近一次实时数据
  liveAt: 0,             // 收到实时数据时的本机时间（秒）
  liveError: null,
  stops: null,           // 全部车站（附近车站用）
};

// ---------- 地图 ----------
const map = L.map("map", { zoomControl: true }).setView([3.139, 101.687], 12);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "© OpenStreetMap",
}).addTo(map);
const layers = { route: L.layerGroup().addTo(map), buses: L.layerGroup().addTo(map), me: L.layerGroup().addTo(map) };

// ---------- 工具 ----------
const nowSec = () => Date.now() / 1000;
function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// 把点投影到折线上：返回 {along: 沿线距离米, off: 偏离距离米}
function project(shape, p) {
  const kx = Math.cos(p[0] * Math.PI / 180) * 111320, ky = 110540;
  let best = { along: 0, off: Infinity }, cum = 0;
  for (let i = 0; i < shape.length - 1; i++) {
    const ax = shape[i][1] * kx, ay = shape[i][0] * ky, bx = shape[i + 1][1] * kx, by = shape[i + 1][0] * ky;
    const px = p[1] * kx, py = p[0] * ky, dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, seg = Math.sqrt(L2);
    const t = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
    const off = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
    if (off < best.off) best = { along: cum + t * seg, off };
    cum += seg;
  }
  return best;
}
function agoText(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒前`;
  return `${Math.floor(s / 3600)} 小时前`;
}
function klNow() { // 吉隆坡时间（UTC+8），返回 {mins, day}
  const d = new Date(Date.now() + 8 * 3600e3);
  return { mins: d.getUTCHours() * 60 + d.getUTCMinutes(), day: d.getUTCDay() };
}
const hhmm = m => { m = Math.round(m) % 1440; return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); };
const routeByKey = k => state.routes.find(r => r.key === k);
const safeKey = k => k.replace(/[^A-Za-z0-9\-_~]/g, "_");

// ---------- 载入数据 ----------
async function loadRoutes() {
  const res = await fetch("data/routes.json?t=" + Math.floor(Date.now() / 3600e3));
  if (!res.ok) throw new Error("routes.json 载入失败");
  const j = await res.json();
  state.routes = j.routes;
  state.staticUpdated = j.updated;
  let follow = store.get("follow", null);
  if (!follow) {
    follow = CFG.DEFAULT_ROUTES.map(s => state.routes.find(r => r.short.toUpperCase() === s.toUpperCase()))
      .filter(Boolean).map(r => r.key);
    store.set("follow", follow);
  }
  // 默认线路以后才出现在资料里（例如 T451）时，自动补关注一次
  const applied = store.get("defaultsApplied", []);
  CFG.DEFAULT_ROUTES.filter(s => !applied.includes(s)).forEach(s => {
    const r = state.routes.find(r => r.short.toUpperCase() === s.toUpperCase());
    if (!r) return;
    if (!follow.includes(r.key)) follow.push(r.key);
    applied.push(s);
  });
  store.set("defaultsApplied", applied); store.set("follow", follow);
  state.follow = follow.filter(routeByKey);
  state.current = store.get("current", null);
  if (!state.follow.includes(state.current)) state.current = state.follow[0] || null;
}

async function loadRouteData(key) {
  if (state.routeData[key]) return state.routeData[key];
  const res = await fetch(`data/route/${safeKey(key)}.json`);
  if (!res.ok) throw new Error("线路资料载入失败");
  const d = await res.json();
  d.directions.forEach(dir => { dir.tripSet = new Set(dir.trips); });
  state.routeData[key] = d;
  return d;
}

async function loadLive() {
  if (!CFG.WORKER_URL) { state.liveError = "尚未设置 Worker 网址（见 README 第 3 步）"; return; }
  try {
    const res = await fetch(CFG.WORKER_URL.replace(/\/$/, "") + "/vehicles", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    state.live = await res.json();
    state.liveAt = nowSec();
    state.liveError = null;
    const bad = state.live.feeds.filter(f => f.error);
    if (bad.length) state.liveError = "部分数据源出错：" + bad.map(f => `${f.cat} ${f.error}`).join("；");
  } catch (e) {
    state.liveError = "实时数据获取失败：" + e.message;
  }
}

// ---------- 车辆匹配 ----------
function vehicleAge(v) {
  if (!state.live || !v.ts) return Infinity;
  return state.live.serverTime - v.ts + (nowSec() - state.liveAt);
}
function vehiclesFor(route, data) {
  if (!state.live) return [];
  const allTrips = data ? data.directions.map(d => d.tripSet) : [];
  return state.live.vehicles.filter(v => {
    if (v.cat !== route.cat) return false;
    // 实时数据的 route 可能是 "U7720"（同静态 id）或 "T155 Inbound"（线路号 + 方向）
    if (v.route && (v.route === route.id || v.route.split(" ")[0].toUpperCase() === route.short.toUpperCase())) return true;
    return v.trip && allTrips.some(s => s.has(v.trip));
  });
}
function dirOf(v, data) {
  const byTrip = data.directions.findIndex(d => v.trip && d.tripSet.has(v.trip));
  if (byTrip >= 0) return byTrip;
  if (v.dir != null) { const i = data.directions.findIndex(d => d.dir === String(v.dir)); if (i >= 0) return i; }
  let best = 0, bestOff = Infinity;
  data.directions.forEach((d, i) => { const p = project(d.shape, [v.lat, v.lon]); if (p.off < bestOff) { bestOff = p.off; best = i; } });
  return best;
}
// 估算到我的车站：返回 {stops, mins} 或 {passed:true}
function etaTo(v, dir, stopId) {
  const idx = dir.stops.findIndex(s => s.id === stopId);
  if (idx < 0) return null;
  const target = dir.stops[idx];
  // 沿线位置：先投影到形状，再按比例换算到车站距离刻度
  const p = project(dir.shape, [v.lat, v.lon]);
  const scale = dir.len / shapeLen(dir.shape);   // 精简后的形状与原始长度略有差别，按比例换算
  const along = p.along * (isFinite(scale) && scale > 0 ? scale : 1);
  if (along > target.d + 50) return { passed: true };
  const n = dir.stops.filter(s => s.d > along + 30 && s.d <= target.d).length;
  // 实测接口的 speed 是公里/小时（规范写米/秒，但数值如 74 只能是公里/小时），换算成米/秒
  const mps = (v.speed || 0) / 3.6;
  const speed = mps > 1.5 ? Math.min(Math.max(mps, 4), 11) : 5;      // 默认约 18 公里/小时
  const mins = Math.max(0, (target.d - along) / speed / 60 + n * 0.3);  // 每站约停 20 秒
  return { stops: n, mins: Math.round(mins) };
}
// 行驶方向（0=北，顺时针）：有 GPS 方位角就用它；停着且方位为 0 时多半无效
function headingOf(v) {
  if (v.bearing == null || (v.bearing === 0 && !(v.speed > 0))) return null;
  return v.bearing;
}
const compass = b => ["北", "东北", "东", "东南", "南", "西南", "西", "西北"][Math.round(((b % 360) + 360) % 360 / 45) % 8];
const shapeLenCache = new WeakMap();
function shapeLen(shape) {
  if (shapeLenCache.has(shape)) return shapeLenCache.get(shape);
  let s = 0; for (let i = 1; i < shape.length; i++) s += hav(shape[i - 1], shape[i]);
  shapeLenCache.set(shape, s); return s;
}

// ---------- 渲染 ----------
function renderChips() {
  const el = $("#chips");
  if (!state.follow.length) { el.innerHTML = `<span class="muted">还没有关注线路，点「➕ 线路」添加</span>`; return; }
  el.innerHTML = state.follow.map(k => {
    const r = routeByKey(k);
    const n = vehiclesFor(r, state.routeData[k]).length;
    return `<button class="chip ${k === state.current ? "on" : ""}" data-k="${esc(k)}">${esc(r.short)}<span class="cnt">${state.live ? n + " 辆" : ""}</span><span class="del" data-del="${esc(k)}">✕</span></button>`;
  }).join("");
  el.querySelectorAll(".chip").forEach(b => b.onclick = e => {
    const del = e.target.dataset.del;
    if (del) { if (confirm(`不再关注 ${routeByKey(del).short}？`)) toggleFollow(del); return; }
    selectRoute(b.dataset.k);
  });
}

let fitted = null;
function renderMap(route, data) {
  layers.route.clearLayers(); layers.buses.clearLayers();
  if (!data) return;
  const color = route.color ? "#" + route.color : "#0b5cab";
  const myStop = state.myStops[route.key];
  const bounds = [];
  data.directions.forEach((d, i) => {
    const active = i === state.dirIdx;
    L.polyline(d.shape, { color, weight: active ? 6 : 3, opacity: active ? .9 : .35, dashArray: active ? null : "6 8" }).addTo(layers.route);
    bounds.push(...d.shape);
    if (!active) return;
    d.stops.forEach((s, j) => {
      const mine = s.id === myStop;
      L.circleMarker([s.lat, s.lon], { radius: mine ? 10 : 6, color: mine ? "#e65100" : color, fillColor: mine ? "#ff9800" : "#fff", fillOpacity: 1, weight: 3 })
        .bindPopup(`<b>${j + 1}. ${esc(s.n)}</b>${mine ? "<br>⭐ 我的车站" : ""}<br><button onclick="setMyStop('${esc(s.id)}')">设为我的车站</button>`)
        .addTo(layers.route);
    });
  });
  vehiclesFor(route, data).forEach(v => {
    const stale = vehicleAge(v) > CFG.STALE_SECONDS;
    const name = v.plate || v.label || v.id || "?";
    const b = headingOf(v);
    const arrow = b == null ? "" : `<span class="arrow" style="transform:rotate(${b - 90}deg)">➤</span>`;
    const icon = L.divIcon({ className: "", html: `<div class="bus-icon ${stale ? "stale" : ""}">${arrow}🚌 ${esc(name)}</div>`, iconSize: null, iconAnchor: [40, 12] });
    L.marker([v.lat, v.lon], { icon, zIndexOffset: 1000 })
      .bindPopup(`<b>${esc(name)}</b><br>数据更新于 ${agoText(vehicleAge(v))}${stale ? "<br>⚠️ 超过 3 分钟未更新" : ""}`)
      .addTo(layers.buses);
  });
  if (fitted !== route.key && bounds.length) { map.fitBounds(bounds, { padding: [20, 20] }); fitted = route.key; }
}

function renderPanel(route, data) {
  const el = $("#panel");
  if (!route) { el.innerHTML = `<div class="card">请先点「➕ 线路」添加要关注的线路。</div>`; return; }
  if (!data) { el.innerHTML = `<div class="card">载入线路资料中…</div>`; return; }
  const myStop = state.myStops[route.key];
  const dirs = data.directions;
  let h = `<div class="card"><div class="plate">${esc(route.short)}</div><div class="muted">${esc(route.long)}</div>`;
  if (dirs.length > 1) h += `<div class="dirtabs">${dirs.map((d, i) => `<button class="${i === state.dirIdx ? "on" : ""}" data-i="${i}">往 ${esc(d.head)}</button>`).join("")}</div>`;
  const ms = myStop && dirs.flatMap(d => d.stops).find(s => s.id === myStop);
  h += `<div class="muted">我的车站：${ms ? "⭐ " + esc(ms.n) : "未设置（点「⭐ 我的站」或地图上的站点）"}</div></div>`;

  if (state.liveError) h += `<div class="warn">⚠️ ${esc(state.liveError)}</div>`;

  const vs = vehiclesFor(route, data).map(v => ({ v, age: vehicleAge(v), di: dirOf(v, data) }));
  if (state.live && !vs.length) {
    h += `<div class="warn"><b>该线路目前无实时数据</b><br>（可能无车运行或车辆未上传 GPS）</div>`;
    h += timetableHtml(data, myStop);
  } else {
    vs.sort((a, b) => (a.di === state.dirIdx ? 0 : 1) - (b.di === state.dirIdx ? 0 : 1) || a.age - b.age);
    vs.forEach(({ v, age, di }) => {
      const stale = age > CFG.STALE_SECONDS;
      const d = dirs[di];
      let eta = "";
      if (myStop) {
        const e = etaTo(v, d, myStop);
        if (!e) eta = `<div class="muted">此方向不经过我的车站</div>`;
        else if (e.passed) eta = `<div class="muted">已驶过我的车站</div>`;
        else eta = `<div class="eta">还有 ${e.stops} 站 · 约 ${e.mins} 分钟 <span class="muted">（按距离估算）</span></div>`;
      }
      h += `<div class="card ${stale ? "stale" : ""}" data-lat="${v.lat}" data-lon="${v.lon}">
        <div class="plate">🚌 ${esc(v.plate || v.label || v.id || "未知车牌")}</div>
        <div class="dir">➜ 开往 ${esc(d.head)}${headingOf(v) != null ? `（向${compass(headingOf(v))}行驶）` : ""}</div>
        <div class="muted">数据更新于 ${agoText(age)}${stale ? " ⚠️ 超过 3 分钟未更新" : ""}</div>${eta}</div>`;
    });
  }
  h += `<p class="muted">线路资料更新：${esc((state.staticUpdated || "").slice(0, 10))}。到站时间仅为按距离的粗略估算。</p>`;
  el.innerHTML = h;
  el.querySelectorAll(".dirtabs button").forEach(b => b.onclick = () => { state.dirIdx = +b.dataset.i; render(); });
  el.querySelectorAll(".card[data-lat]").forEach(c => c.onclick = () => map.setView([+c.dataset.lat, +c.dataset.lon], 16));
}

function timetableHtml(data, myStop) {
  const { mins, day } = klNow();
  const type = day === 0 ? "sun" : day === 6 ? "sat" : "wd";
  let h = "", any = false;
  data.directions.forEach(d => {
    const stop = d.stops.find(s => s.id === myStop) || d.stops[0];
    const starts = d.starts[type] || [];
    if (!starts.length || stop.o == null) return;
    const times = starts.map(m => m + stop.o).filter(m => m >= mins - 2).slice(0, 12);
    any = true;
    h += `<div class="card"><b>计划时刻表</b>（往 ${esc(d.head)}）<div class="muted">车站：${esc(stop.n)} · ${type === "wd" ? "平日" : type === "sat" ? "周六" : "周日"}</div>
      <div class="times">${times.length ? times.map(m => `<span>${hhmm(m)}</span>`).join("") : "今天已无班次"}</div></div>`;
  });
  return any ? h : `<div class="card muted">静态资料中没有此线路的计划时刻。</div>`;
}

function renderStatus() {
  let s = "";
  if (state.live) s = `实时数据：${agoText(nowSec() - state.liveAt)}获取 · 每 ${CFG.REFRESH_SECONDS} 秒刷新`;
  else s = state.liveError || "获取实时数据中…";
  $("#status").textContent = s;
}

function render() {
  const route = state.current && routeByKey(state.current);
  const data = route && state.routeData[route.key];
  if (data && state.dirIdx >= data.directions.length) state.dirIdx = 0;
  renderChips(); renderStatus(); renderMap(route, data); renderPanel(route, data);
}

async function selectRoute(key) {
  state.current = key; store.set("current", key); state.dirIdx = 0;
  render();
  try { await loadRouteData(key); } catch (e) { $("#panel").innerHTML = `<div class="warn">${esc(e.message)}</div>`; return; }
  const ms = state.myStops[key], d = state.routeData[key];
  if (ms) { const i = d.directions.findIndex(x => x.stops.some(s => s.id === ms)); if (i >= 0) state.dirIdx = i; }
  render();
}

window.setMyStop = function (id) {
  state.myStops[state.current] = id; store.set("myStops", state.myStops); map.closePopup(); closeModal(); render();
};

// ---------- 弹窗 ----------
function openModal(title, html) { $("#modalTitle").textContent = title; $("#modalBody").innerHTML = html; $("#modal").hidden = false; }
function closeModal() { $("#modal").hidden = true; }
$("#modalClose").onclick = closeModal;
$("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };

function openRouteManager() {
  openModal("管理关注线路", `<input type="search" id="q" placeholder="搜索线路号或地名，如 T450、KLCC">
    <div class="muted">已关注的线路排在前面。共 ${state.routes.length} 条线路。</div><div id="rlist"></div>`);
  const draw = () => {
    const q = $("#q").value.trim().toLowerCase();
    let list = state.routes.filter(r => !q || r.short.toLowerCase().includes(q) || r.long.toLowerCase().includes(q));
    list.sort((a, b) => state.follow.includes(b.key) - state.follow.includes(a.key));
    $("#rlist").innerHTML = list.slice(0, 120).map(r => {
      const on = state.follow.includes(r.key);
      return `<div class="row"><div class="name"><b>${esc(r.short)}</b> <span class="muted">${r.cat === "rapid-bus-mrtfeeder" ? "MRT接驳" : "Rapid KL"}</span><br><span class="muted">${esc(r.long)}</span></div>
        <button class="${on ? "" : "primary"}" data-k="${esc(r.key)}">${on ? "删除" : "添加"}</button></div>`;
    }).join("") || `<p class="muted">找不到线路</p>`;
    $("#rlist").querySelectorAll("button").forEach(b => b.onclick = () => toggleFollow(b.dataset.k, draw));
  };
  $("#q").oninput = draw; draw();
}
function toggleFollow(key, redraw) {
  if (state.follow.includes(key)) state.follow = state.follow.filter(k => k !== key);
  else state.follow.push(key);
  store.set("follow", state.follow);
  if (!state.follow.includes(state.current)) { state.current = state.follow[0] || null; if (state.current) selectRoute(state.current); }
  if (state.follow.length === 1 && !state.current) selectRoute(state.follow[0]);
  renderChips(); render(); redraw && redraw();
}

function openStopPicker() {
  const route = state.current && routeByKey(state.current), data = route && state.routeData[route.key];
  if (!data) return;
  const cur = state.myStops[route.key];
  openModal(`${route.short} · 选我的车站`, data.directions.map((d, i) => `<h3>往 ${esc(d.head)}</h3>` + d.stops.map((s, j) =>
    `<div class="row"><div class="name">${j + 1}. ${esc(s.n)}${s.id === cur ? " ⭐" : ""}</div><button data-id="${esc(s.id)}" data-i="${i}">选择</button></div>`).join("")).join("")
    + (cur ? `<p><button id="clearStop">清除我的车站</button></p>` : ""));
  $("#modalBody").querySelectorAll("button[data-id]").forEach(b => b.onclick = () => { state.dirIdx = +b.dataset.i; setMyStop(b.dataset.id); });
  const c = $("#clearStop"); if (c) c.onclick = () => { delete state.myStops[route.key]; store.set("myStops", state.myStops); closeModal(); render(); };
}

async function locate() {
  if (!navigator.geolocation) return alert("此浏览器不支持定位");
  $("#status").textContent = "定位中…";
  navigator.geolocation.getCurrentPosition(async pos => {
    const me = [pos.coords.latitude, pos.coords.longitude];
    layers.me.clearLayers();
    L.circle(me, { radius: pos.coords.accuracy, color: "#1e88e5", weight: 1, fillOpacity: .1 }).addTo(layers.me);
    L.circleMarker(me, { radius: 9, color: "#fff", weight: 3, fillColor: "#1e88e5", fillOpacity: 1 }).bindPopup("我在这里").addTo(layers.me);
    map.setView(me, 16);
    if (!state.stops) state.stops = await (await fetch("data/stops.json")).json();
    const near = state.stops.map(s => ({ s, d: hav(me, [s[2], s[3]]) })).sort((a, b) => a.d - b.d).slice(0, 8);
    near.forEach(({ s }) => L.circleMarker([s[2], s[3]], { radius: 7, color: "#1e88e5", fillColor: "#fff", fillOpacity: 1, weight: 3 }).bindPopup(esc(s[1])).addTo(layers.me));
    renderStatus();
    openModal("附近车站", near.map(({ s, d }) => `<div class="card"><b>${esc(s[1])}</b> <span class="muted">${Math.round(d)} 米</span>
      <div class="times">${s[4].map(k => { const r = routeByKey(k); return r ? `<button data-k="${esc(k)}" data-s="${esc(s[0])}">${esc(r.short)}${state.follow.includes(k) ? " ✓" : ""}</button>` : ""; }).join("")}</div></div>`).join("")
      + `<p class="muted">点线路号：加入关注并把该站设为我的车站。</p>`);
    $("#modalBody").querySelectorAll("button[data-k]").forEach(b => b.onclick = async () => {
      const k = b.dataset.k;
      if (!state.follow.includes(k)) { state.follow.push(k); store.set("follow", state.follow); }
      state.myStops[k] = b.dataset.s; store.set("myStops", state.myStops);
      closeModal(); await selectRoute(k);
    });
  }, err => { alert("无法定位：" + err.message + "\n请在浏览器设置里允许位置权限。"); renderStatus(); },
  { enableHighAccuracy: true, timeout: 15000 });
}

// ---------- 启动 ----------
$("#btnRoutes").onclick = openRouteManager;
$("#btnStop").onclick = openStopPicker;
$("#btnLocate").onclick = locate;
$("#btnRefresh").onclick = async () => { await loadLive(); render(); };

(async function start() {
  try { await loadRoutes(); } catch (e) { $("#panel").innerHTML = `<div class="warn">${esc(e.message)}（线路资料可能尚未生成，见 README 第 2 步）</div>`; return; }
  await Promise.all(state.follow.map(k => loadRouteData(k).catch(() => {})));
  if (state.current) await selectRoute(state.current); else render();
  await loadLive(); render();
  setInterval(async () => { if (document.hidden) return; await loadLive(); render(); }, CFG.REFRESH_SECONDS * 1000);
  setInterval(() => { renderStatus(); }, 5000);
  document.addEventListener("visibilitychange", async () => { if (!document.hidden) { await loadLive(); render(); } });
})();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
