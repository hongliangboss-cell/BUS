// ===== 唯一需要你手动修改的地方 =====
// 部署好 Cloudflare Worker 后，把它的网址粘贴到下面引号里（结尾不要加斜杠）
// 例如："https://rapid-bus.abc123.workers.dev"
window.APP_CONFIG = {
  WORKER_URL: "https://bus.hongliangboss.workers.dev",
  DEFAULT_ROUTES: ["T450", "T451"],   // 第一次打开时默认关注的线路
  REFRESH_SECONDS: 30,
  STALE_SECONDS: 180,                 // 超过 3 分钟没更新的车显示灰色
};
