// Cloudflare Worker：读取两个 GTFS-Realtime 车辆位置接口，解析 protobuf，返回 JSON。
// 整个文件直接粘贴到 Cloudflare 网页编辑器即可，无需安装任何东西。

const FEEDS = {
  "rapid-bus-kl": "https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-kl",
  "rapid-bus-mrtfeeder": "https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-mrtfeeder",
};
const CACHE_SECONDS = 15;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

// ---------- 极简 protobuf 读取器 ----------
class Reader {
  constructor(buf, start = 0, end = buf.length) { this.b = buf; this.p = start; this.end = end; }
  varint() {
    let r = 0, s = 0, x;
    do { x = this.b[this.p++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80);
    return r;
  }
  fields(cb) {
    while (this.p < this.end) {
      const tag = this.varint(), f = Math.floor(tag / 8), wt = tag & 7;
      if (wt === 0) cb(f, wt, this.varint());
      else if (wt === 1) { cb(f, wt, new DataView(this.b.buffer, this.b.byteOffset + this.p, 8).getFloat64(0, true)); this.p += 8; }
      else if (wt === 5) { cb(f, wt, new DataView(this.b.buffer, this.b.byteOffset + this.p, 4).getFloat32(0, true)); this.p += 4; }
      else if (wt === 2) { const len = this.varint(); const s = this.p; this.p += len; cb(f, wt, [s, s + len]); }
      else throw new Error("unsupported wire type " + wt);
    }
  }
  sub(range) { return new Reader(this.b, range[0], range[1]); }
  str(range) { return new TextDecoder().decode(this.b.subarray(range[0], range[1])); }
}

function parseFeed(buf, cat) {
  const root = new Reader(new Uint8Array(buf));
  let headerTs = null; const out = [];
  root.fields((f, wt, v) => {
    if (f === 1 && wt === 2) root.sub(v).fields((f2, w2, v2) => { if (f2 === 3) headerTs = v2; });
    if (f === 2 && wt === 2) {
      const ent = root.sub(v); let id = null, veh = null;
      ent.fields((f2, w2, v2) => {
        if (f2 === 1 && w2 === 2) id = ent.str(v2);
        if (f2 === 4 && w2 === 2) veh = parseVehicle(ent.sub(v2));
      });
      if (veh && veh.lat != null) out.push({ cat, eid: id, ...veh });
    }
  });
  return { headerTs, vehicles: out };
}

function parseVehicle(r) {
  const v = {};
  r.fields((f, wt, val) => {
    if (f === 1 && wt === 2) { const t = r.sub(val); t.fields((f2, w2, v2) => {
      if (f2 === 1) v.trip = t.str(v2); if (f2 === 5) v.route = t.str(v2); if (f2 === 6) v.dir = v2; }); }
    if (f === 8 && wt === 2) { const d = r.sub(val); d.fields((f2, w2, v2) => {
      if (f2 === 1) v.id = d.str(v2); if (f2 === 2) v.label = d.str(v2); if (f2 === 3) v.plate = d.str(v2); }); }
    if (f === 2 && wt === 2) { const p = r.sub(val); p.fields((f2, w2, v2) => {
      if (f2 === 1) v.lat = v2; if (f2 === 2) v.lon = v2; if (f2 === 3) v.bearing = v2; if (f2 === 5) v.speed = v2; }); }
    if (f === 5 && wt === 0) v.ts = val;
    if (f === 7 && wt === 2) v.stop = r.str(val);
    if (f === 3 && wt === 0) v.seq = val;
  });
  return v;
}

async function build() {
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.all(Object.entries(FEEDS).map(async ([cat, url]) => {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "rapid-bus-tracker-worker" } });
      if (!res.ok) return { cat, error: "HTTP " + res.status, vehicles: [] };
      const p = parseFeed(await res.arrayBuffer(), cat);
      return { cat, headerTs: p.headerTs, vehicles: p.vehicles };
    } catch (e) { return { cat, error: String(e), vehicles: [] }; }
  }));
  return {
    serverTime: now,
    feeds: results.map(r => ({ cat: r.cat, headerTs: r.headerTs || null, count: r.vehicles.length, error: r.error || null })),
    vehicles: results.flatMap(r => r.vehicles),
  };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/debug") {           // 排查用：看原始解析结果的前 5 辆车
      const d = await build(); d.vehicles = d.vehicles.slice(0, 5);
      return new Response(JSON.stringify(d, null, 2), { headers: CORS });
    }
    const cache = caches.default;
    const key = new Request(url.origin + "/vehicles-cache");
    let res = await cache.match(key);
    if (!res) {
      res = new Response(JSON.stringify(await build()), {
        headers: { ...CORS, "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
      });
      ctx.waitUntil(cache.put(key, res.clone()));
    }
    return res;
  },
};
