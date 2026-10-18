# 🚌 吉隆坡 Rapid 公交实时追踪

自用网页 App（PWA），适合鸿蒙 NEXT 等没有谷歌服务的手机：用浏览器打开，可"添加到桌面"。

- 地图：Leaflet + OpenStreetMap（不用谷歌）
- 数据：马来西亚政府开放数据 api.data.gov.my（Rapid KL 巴士 + MRT 接驳巴士，免费、无需密钥）
- 全部免费：GitHub Pages（网页）+ GitHub Actions（每天更新线路资料）+ Cloudflare Workers（实时数据中转），都不需要信用卡

## 工作原理

```
          每天凌晨 3 点                                     每 30 秒
GitHub Actions ──下载静态 GTFS zip──► data/*.json     手机浏览器 ──► Cloudflare Worker ──► api.data.gov.my
（scripts/build_static.py 精简成小 JSON）  │                     ▲        （解析 protobuf，缓存 15 秒，返回 JSON）
                                          └──GitHub Pages 网页──┘
```

| 文件 | 作用 |
|---|---|
| `index.html` `style.css` `app.js` | 网页本体 |
| `config.js` | **唯一需要手改的文件**：填 Worker 网址、默认关注线路 |
| `manifest.webmanifest` `sw.js` `icons/` | 让网页能"添加到桌面"像 App 一样用 |
| `scripts/build_static.py` | 把静态 GTFS 解析成 `data/routes.json`、`data/stops.json`、`data/route/*.json` |
| `.github/workflows/update-gtfs.yml` | 每天自动运行上面的脚本并提交 |
| `worker/worker.js` | Cloudflare Worker 代码（直接粘贴到网页编辑器） |
| `vendor/leaflet/` | 地图库（放在仓库里，加载更快） |

---

## 部署步骤

### 第 1 步：GitHub 账号和仓库

1. 打开 https://github.com/signup ，用邮箱注册（免费，不要信用卡），按提示验证邮箱。
2. 登录后，点右上角 **＋** → **New repository**。
3. **Repository name** 填 `rapid-bus`；选 **Public**（免费的 Pages 需要公开仓库）；其它不要勾；点绿色 **Create repository**。
4. 把代码放进仓库（二选一）：
   - **让 Claude 帮你推送**（推荐）：把你的 GitHub 用户名告诉 Claude。
   - **自己上传**：在仓库页面点 **uploading an existing file**，把解压后文件夹里的所有文件和文件夹拖进去，点 **Commit changes**。
     注意：`.github` 文件夹是隐藏的，可能拖不上去。如果仓库里看不到 `.github`，就点 **Add file → Create new file**，文件名一栏输入
     `.github/workflows/update-gtfs.yml`（输入 `/` 会自动变成文件夹），把本仓库里同名文件的内容粘贴进去，点 **Commit changes**。

### 第 2 步：生成线路资料 + 开启网页

1. 仓库页面上方点 **Settings**（齿轮）→ 左边 **Actions** → **General** → 拉到 **Workflow permissions**，选 **Read and write permissions** → **Save**。
2. 上方点 **Actions** 标签。如果看到提示要启用工作流，点绿色按钮启用。
3. 左边点 **每日更新线路资料** → 右边 **Run workflow** → 再点绿色 **Run workflow**。等 1～3 分钟，出现绿色 ✅ 就成功了（红色 ❌ 见下面"排查"）。
4. 点 **Settings** → 左边 **Pages** → **Source** 选 **Deploy from a branch** → **Branch** 选 `main`、文件夹 `/ (root)` → **Save**。
5. 等 1～2 分钟刷新这个页面，顶部会显示网址：`https://你的用户名.github.io/rapid-bus/`。

### 第 3 步：Cloudflare Worker（实时数据中转）

为什么需要它：政府接口返回的是二进制 protobuf 格式，而且不一定允许网页跨域读取。Worker 在中间帮忙读取、解析成 JSON、加上跨域许可，并缓存 15 秒。免费额度每天 10 万次请求，自用远远够。

1. 打开 https://dash.cloudflare.com/sign-up ，邮箱注册（不要信用卡），验证邮箱。
2. 登录后左边菜单点 **Compute (Workers)**（旧版界面叫 **Workers & Pages**）。
3. 点 **Create**（或 **Create application**）→ 选 **Start with Hello World!** → 名字填 `rapid-bus` → **Deploy**。
4. 部署完点 **Edit code**。左边是代码编辑器：**全选删掉**里面的代码，把本仓库 `worker/worker.js` 的全部内容粘贴进去 → 右上角点 **Deploy**。
5. 页面上会显示网址，类似 `https://rapid-bus.你的名字.workers.dev`。
6. 测试：在浏览器打开 `https://rapid-bus.你的名字.workers.dev/debug`，应看到文字，`feeds` 里两项的 `count` 是车辆数、`error` 是 `null`。
7. 回到 GitHub 仓库 → 点 `config.js` → 右上角 ✏️ 铅笔图标 → 把 `WORKER_URL: ""` 改成
   `WORKER_URL: "https://rapid-bus.你的名字.workers.dev"` → **Commit changes**。等 1～2 分钟网页自动更新。

### 第 4 步：鸿蒙手机添加到桌面

1. 用鸿蒙自带 **浏览器** 打开 `https://你的用户名.github.io/rapid-bus/`。
2. 点底部（或右上角）的 **⋯ / 菜单** 按钮。
3. 选 **添加至桌面**（有的版本在 **工具箱** 或 **分享** 里，名字可能是"添加到桌面""添加快捷方式"）→ 确认。
4. 桌面出现蓝色巴士图标，以后点它就像 App 一样打开。
5. 第一次点 **📍 定位** 时浏览器会问是否允许位置权限，选 **允许**。

---

## 使用说明

- 顶部的线路按钮：点一下切换线路，数字是当前在跑的车辆数。
- **➕ 线路**：搜索全部吉隆坡 Rapid 巴士线路（含 T 开头的 MRT 接驳巴士），点"添加/删除"。保存在手机浏览器本地。
- **⭐ 我的站**：选一个站后，每辆车会显示"还有几站 · 约几分钟"。这是**按距离和车速的粗略估算**，不是官方到站时间。也可以直接点地图上的站点圆圈设置。
- 车辆卡片：显示车牌和"数据更新于 X 秒前"。超过 3 分钟没更新的车变灰。点卡片地图会跳到那辆车。
- 某线路没有车：显示"该线路目前无实时数据"，并显示静态资料里的计划时刻（若有）。
- **📍 定位**：显示你的位置和附近 8 个车站；点车站下的线路号可直接关注并设为我的车站。

## 怎么更新

- **线路资料**：每天自动更新，不用管。想马上更新：仓库 → Actions → 每日更新线路资料 → Run workflow。
- **改默认线路/刷新间隔**：改 `config.js`。（默认线路只在第一次打开时生效，之后以手机里保存的为准。）
- **改了代码手机没变化**：网页有离线缓存，关掉 App 重新打开一两次即可；还不行就在浏览器设置里清除该网站数据。
- **Worker 代码更新**：Cloudflare → Workers → rapid-bus → Edit code → 粘贴新代码 → Deploy。

## 出问题怎么排查

| 现象 | 原因 / 解决 |
|---|---|
| 网页显示"routes.json 载入失败"或线路列表为空 | 第 2 步的 Actions 还没成功运行过。去 Actions 看是否有红色 ❌ |
| Actions 红色 ❌，日志里有 `403` / `Permission denied` / `push` | 第 2 步第 1 点的 **Read and write permissions** 没开 |
| Actions 红色 ❌，日志里是下载错误 / `HTTP Error` | 政府接口临时故障，过几小时再手动运行；旧资料会保留不受影响 |
| 显示"尚未设置 Worker 网址" | 第 3 步第 7 点 `config.js` 没改，或改完还没过 2 分钟 |
| 显示"实时数据获取失败" | 浏览器打开 `Worker网址/debug` 看：打不开 → Worker 没部署好；`error` 不是 null → 政府接口出问题 |
| 某线路一直"无实时数据"，但路上明明有车 | 打开 `Worker网址/debug`，看车辆的 `route` 字段值，和 `data/routes.json` 里该线路的 `id` 是否一致。不一致请把两者截图发给 Claude 修 |
| 地图是灰的 | OpenStreetMap 图块加载慢或网络问题，稍等或换网络 |
| 定位不工作 | 浏览器设置里允许该网站使用位置；必须是 https 网址 |
| 到站分钟数不准 | 这是估算（按剩余距离和车速，堵车时会偏少），仅供参考 |

### 本地测试解析脚本（可选，懂电脑的人用）

```bash
python3 scripts/build_static.py                          # 从网上下载并生成 data/
python3 scripts/build_static.py --local 文件.zip:rapid-bus-kl   # 用本地 zip
```

## 数据来源

- 实时车辆位置（GTFS-Realtime，protobuf）：`https://api.data.gov.my/gtfs-realtime/vehicle-position/prasarana?category=rapid-bus-kl` 和 `...?category=rapid-bus-mrtfeeder`
- 静态线路（GTFS zip）：`https://api.data.gov.my/gtfs-static/prasarana?category=rapid-bus-kl` 和 `...?category=rapid-bus-mrtfeeder`
- 文档：https://developer.data.gov.my/realtime-api/gtfs-realtime
