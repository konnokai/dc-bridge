# 小刻食堂（ceobecanteen）參考文件

> 這份是上游 [nonebot-bison](https://github.com/MountainDash/nonebot-bison) 的文件快照，放在本專案 `design/` 供未來追查。
> 來源：`docs/dev/ceobecanteen.md`，快照 commit `c891b92`（2026-11-20）。
> 授權：MIT（原文版權 felinae98，全文見文末）。
> 以下原文照錄（簡體、未改寫），只移除 VitePress 的 `prev`／`next` front matter。
> 上游文件可能已經更新；要看最新版請回上游 repo。

## dc-bridge 的實作對照

本專案的實作在 [`src/core/discord-ceobe.mjs`](../../src/core/discord-ceobe.mjs)，橋接端在
[`src/discord-bridge.js`](../../src/discord-bridge.js)。跟上游 Bison 的差異：

| 項目 | dc-bridge |
| --- | --- |
| 訂閱單位 | `discord.ceobe.channels`：每個 Discord 頻道一組來源 `unique_id` |
| 投遞方式 | 新餅丟進該頻道的 DSH 會話，由人格整理後用 `send_message` 發文 |
| 去重 | `(source.type, source.data, item.id)`，寫在 `state/discord-ceobe.json`；排進回合閘門就標已讀 |
| 舊餅 | 每個（頻道, 來源）有水位；第一次加入、停用後再開從當下開始。正常重啟保留水位與已讀，停機期間 24 小時內的餅會補送 |
| 圖片 | 第一版不抓；只送文字與原文連結，圖片交給 Discord 的連結預覽 |
| 截圖 | 不支援官網／公告頁截圖 |
| 限量 | 每輪最多 3 則、單則內文 800 字；超過下一分鐘再送 |
| 保底 | 模型完全沒送出時，橋接送來源＋第一行＋原文連結；漏連結只補一行 `-# 原文：…` |
| 工具 | 餅回合只開放 `send`、`react`、`unreact`；生圖、記憶、筆記、知識、回訪、語音、沙箱、安靜都擋 |

設定與操作說明在 [`docs/guides/DISCORD.md`](../guides/DISCORD.md) 的「小刻食堂（餅，選用）」。

---

# 小刻食堂（ceobecanteen）解析

小刻食堂不是一个「被爬」的站点，而是一个**聚合站**：B 站、微博、官网、游戏公告的抓取由小刻那边完成，Bison 只订阅它的「饼干」接口。

这篇文档拆解 `nonebot_bison/platform/ceobecanteen/` 的实现，并给出移植成独立服务（例如 Discord 通知 bot）时需要保留和替换的部分。

::: tip
只想接 Discord 的话，可以直接跳到[移植到 Discord](#移植到-discord)。前面的内容是它依赖的接口契约。
:::

## 结论先行

- 平台不持有 cookie，也不做登录。固定的 User-Agent 是 `MountainDash/Nonebot-Bison`。
- 订阅的对象是**小刻的数据源**，target 存的是 `unique_id`（一个 UUID），不是 B 站 uid 或微博 uid。
- 轮询分三级：数据源清单 → `comb_id` → `cookie_id`。只有 `cookie_id` 变了才拉饼干列表。
- 一次拉的是「全部数据源」的饼干，之后在本地按数据源分派给订阅者。
- 官网页和部分公告页会用 Playwright 截图，其余用接口给好的文字和图片。

## 接口契约

接口地址都定义在 `platform/ceobecanteen/const.py`。

| 用途 | 方法 | 地址 | 关键参数 | 响应模型 |
| --- | --- | --- | --- | --- |
| 数据源清单 | GET | `https://server.ceobecanteen.top/api/v1/canteen/config/datasource/list` | 无 | `DataSourceResponse` |
| 取组合 id | POST | `https://server.ceobecanteen.top/api/v1/canteen/user/getDatasourceComb` | `{"datasource_push": ["<unique_id>", ...]}` | `CombIdResponse` |
| 取最新 cookie id | GET | `https://cdn.ceobecanteen.top/datasource-comb/{comb_id}` | path 参数 | `CookieIdResponse` |
| 取饼干列表 | GET | `https://server-cdn.ceobecanteen.top/api/v1/cdn/cookie/mainList/cookieList` | `datasource_comb_id`、`cookie_id` | `CookiesResponse` |

所有请求都不需要鉴权。`process_response`（`utils.py`）会统一做三件事：`raise_for_status`、按模型校验、检查业务 `code`。`CookieIdResponse` 没有 `code` 字段，所以被单独跳过。

### 响应结构

```jsonc
// 数据源清单（code 是字符串 "00000"，pydantic 会转成 int）
{
  "code": "00000",
  "message": "Operate Success",
  "data": [
    {
      "platform": "bilibili",
      "datasource": "bilibili:dynamic-by-uid",
      "nickname": "明日方舟-B站",
      "avatar": "https://cdn.ceobecanteen.top/datasource-avatar/af174f25-1beb-41cd-a4de-2c3aadae9666",
      "unique_id": "7d23708b-e424-418b-b4c4-43c370c3b6d0",
      "db_unique_key": "161775300",
      "jump_url": "https://space.bilibili.com/161775300"
    }
  ]
}

// 组合 id
{ "code": "00000", "message": "Operate Success", "data": { "datasource_comb_id": "2" } }

// 最新 cookie id（没有 code 字段）
{ "cookie_id": "6537ad363b4a4fd2d7919ac2", "update_cookie_id": "6537ad363b4a4fd2d7919ac2" }

// 饼干列表
{
  "code": "00000",
  "message": "Operate Success",
  "data": {
    "cookies": [/* CeobeCookie */],
    "next_page_id": null
  }
}
```

## 数据模型

定义在 `platform/ceobecanteen/models.py`。

### CeobeTarget（数据源）

| 字段 | 说明 |
| --- | --- |
| `unique_id` | 数据源唯一标识，**订阅时存的 target** |
| `nickname` | 显示名，订阅时用户输入这个 |
| `datasource` | 数据源类型，例如 `bilibili:dynamic-by-uid`、`weibo:dynamic-by-uid` |
| `db_unique_key` | 数据源内部 id，与 `datasource` 一起用于反查 |
| `platform` | 原始平台代码，写进 `Post.description` |
| `avatar` | 数据源头像 |
| `jump_url` | 跳转链接，可为 `null` |

### CeobeCookie（一条饼干）

| 字段 | 说明 |
| --- | --- |
| `datasource` | 数据源名字，写进 `Post.nickname` |
| `icon` | 头像 |
| `timestamp` | 时间戳，见下 |
| `default_cookie` | 默认内容：`text` 和 `images` |
| `item` | 原始内容信息，具体字段随数据源变化 |
| `source` | `{data, type}`，用于反查数据源 |

`CeobeItem` 打开了 `extra = "allow"`，所以不同平台会带自己的字段。常用的有：

- `id`：饼干的唯一 id，去重靠它。
- `url`：原文链接。
- `is_retweeted` / `retweeted`：是否转发、转发的原文。
- `display_type`：公告类数据源才有，用于判断要不要截图。
- `type`：数据源自定义类型，Bison 目前没用。

`CeobeTimestamp` 的 `fetcher` 和 `platform` 都是**毫秒**。`platform_precision` 表示平台时间的精度。

## 订阅目标怎么来

`target` 就是数据源的 `unique_id`。

- `parse_target(nickname)`（`platform.py:145`）先按昵称精确匹配。匹配不到就用 rapidfuzz 的 `token_sort_ratio` 取前 3 个候选，把候选写进 `ParseTargetException.prompt`，让用户重输。
- `get_target_name`（`platform.py:140`）把 UUID 反查成昵称。
- 数据源清单有缓存（`cache.py:49`）：`ExpiringDict`，容量 100，每笔 1 天。查询未命中时才刷新，不会主动更新昵称或头像。

::: warning
昵称不是主键。用户改了昵称，旧 target 仍然是 UUID，订阅不会断；但显示名要等缓存刷新后才会变。
:::

## 三级 id 的轮询

整个平台的核心在 `platform.py:74-137`。

```text
数据源清单 ──(全部 unique_id)──> comb_id ──(每 15s)──> cookie_id
                                                      │
                                            变了才拉 ──┴──> cookies
```

1. **comb_id**：把所有数据源的 `unique_id` 打包 POST 给 `getDatasourceComb`，得到一个组合 id。缓存 12 小时。
2. **cookie_id**：每个 tick 打一次 `cdn.ceobecanteen.top/datasource-comb/{comb_id}`。这个接口很轻，只返回 id。
3. **cookies**：只有 `latest_cookie_id != self.cookie_id` 时才打 `cookieList`，拿完整列表。缓存 1 小时。

这样做的好处是：轮询成本固定在「一个轻请求」，完整列表只在有新内容时下载。

三个缓存都是 `CeobeCache` 描述符（`cache.py:31`）。`_cache` 是类变量，多个实例共享同一份；key 就是属性名（`comb_id`、`cookie_id`、`cookies`）。它们**不是**按 target 分开的，因为小刻返回的本来就是全量数据。

::: tip
`comb_id` 计算的是「全部数据源」的组合，不是当前订阅者的组合。所以一个进程里所有订阅共用同一次轮询，这也是 `use_batch = True` 的原因。
:::

::: warning
`comb_id` 缓存 12 小时。如果小刻新增了一个数据源，而你的 `comb_id` 还没过期，新数据源要等缓存过期后才会进列表。自己实现时，可以在「新增订阅」时主动清掉 `comb_id`。
:::

## 分派：一次抓取，按数据源拆开

`batch_get_sub_list`（`platform.py:129`）完全忽略传进来的 `targets`，它只负责拉全量饼干，然后：

```python
dispatched: defaultdict[Target, list[CeobeCookie]] = defaultdict(list)
for cookie in cookies:
    if ceobe_target := await self.data_source_cache.get_by_source(cookie.source):
        dispatched[Target(ceobe_target.unique_id)].append(cookie)

return [dispatched[target] for target in targets]
```

`get_by_source`（`cache.py:107`）用 `(db_unique_key, datasource)` 匹配。也就是说，饼干上的 `source.data` 不是 UUID，需要先映射一次。

Bison 的调度器对 batch 平台的处理是：这轮轮到该平台的任意一个 target，就把该平台所有 target 一起传进来（`scheduler.py:108-114`）。因此任何一次抓取都会更新该平台的全部订阅者。

## 新饼干判定

分派之后回到 `NewMessage` 的模板流程（`platform.py:291`）：

- `get_id` = `item.id`。
- `get_date` = `timestamp.fetcher`。
- `filter_common` 丢掉不支持的分类、以及「太旧」的饼干。
- `filter_common_with_diff` 用每个 target 的 `set` 做 id 差集。

第一次抓取只建立基线，不推送（`bison_init_filter=True` 时）。之后只推送集合里没有的 id。

分类只有两种（`platform.py:161`）：

- `item.is_retweeted == True` → `Category(2)`（转发）
- 否则 → `Category(1)`（普通）

::: warning
`get_date` 返回的是**毫秒**，但基类 `filter_common` 里的 2 小时判断是按**秒**算的（`platform.py:269-272`）。差值恒为负，所以这条时间过滤对小刻食堂实际不生效。自己实现时记得先 `/1000`。
:::

另外，Bison 的已读集合在内存里，重启会重建基线，停机期间的饼干不会补推。移植时建议持久化。

## 解析：什么时候截图

`take_snapshot`（`platform.py:262`）按 `source.type` 分流：

| `source.type` | 条件 | 处理 |
| --- | --- | --- |
| `arknights-website:official-website` | 总是 | 打开官网，截整块内容 |
| `arknights-game:bulletin-list` | `item.display_type != 2` | 截公告列表 |
| 其他 | — | 不截图，用 `default_cookie` |

`display_type == 2` 表示公告本身就有可用的文字内容，不需要截图。测试 `test_ceobe_snapshot` 里三个 case 分别覆盖这两种截图和普通饼干。

截图依赖：

- `bison_use_browser` 必须打开。
- 需要 `nonebot_plugin_htmlrender`。
- 官网截图的 xpath 是写死的（`platform.py:214-215`），页面改版会失败。

失败时的兜底顺序（`platform.py:288-300`）：

1. 没开浏览器 → `CeobeSnapshotSkip`
2. 截图抛异常 → 包成 `CeobeSnapshotFailed`
3. 两种情况都退回 `default_cookie.text` + `default_cookie.images`

所以截图只是「更好看」，不是正确性的必要条件。

### 图片

- 普通饼干：`images` 里的 URL 直接交给发送层。
- 微博来源（`source.type` 以 `weibo` 开头）：Bison 会自己下载图片，并带 `referer: https://weibo.cn/`（`platform.py:311`）。微博图床需要 referer，Discord 的图片代理不会带，通常会抓取失败，移植时建议自己下载后再上传。

### 转发

`item.retweeted` 存在时，会构造第二个 `Post` 放进 `repost`，带原作者、头像、文字、图片（`platform.py:182-193`）。

### 时间

优先 `timestamp.platform`，没有才用 `timestamp.fetcher`，然后除以 1000 转成秒（`platform.py:178-180`）。

## 渲染

平台的 `default_theme` 是 `ceobecanteen`，主题在 `theme/themes/ceobe_canteen/build.py`。

- 多图先 `pic_merge` 合并成一张长图（`is_pics_mergable` 判断）。
- 用 `post.url` 生成二维码，颜色 `(240, 236, 233)`。
- Jinja 模板渲染卡片，Playwright 截 `#ceobecanteen-card`：512×455、`device_scale_factor=2`、JPEG q90。
- 第一张图是 bytes 时，用 PIL 贴到卡片上方当头图；是 URL 时只嵌进卡片。
- 最后补一行「来源 / 详情」，再发剩下的图片。

渲染失败会按 `用户配置 → 平台 default_theme → basic` 的顺序降级（`post/post.py:74`）。所以没装浏览器时，小刻的推送会退成纯文本 + 图片。

## 移植到 Discord

### 要保留的

1. **接口 client**：四个请求、响应模型、`process_response` 的校验。
2. **三级 id 轮询**：`comb_id` → `cookie_id` → `cookies`，以及「id 不变就不拉列表」。
3. **数据源缓存与昵称解析**：`unique_id` 是稳定主键。
4. **本地分派**：一次抓全量，按 `(db_unique_key, datasource)` 拆给订阅者。
5. **截图逻辑**（可选）：官网和公告页。
6. **微博图片的 referer**。
7. **`item.id` 去重**。

### 要替换的

| Bison 里的东西 | Discord 版的替代 |
| --- | --- |
| `Platform` / `Site` / `Scheduler` | 自己的 asyncio 轮询循环或 APScheduler |
| `Subscribe` / `Target` 数据库表 | 频道订阅表（`channel_id` + `unique_id` + 分类） |
| `Post` | 自己组装 Discord embed / 附件 |
| `Theme` + `nonebot_plugin_htmlrender` | Discord embed，或直接把卡片截图当附件 |
| `nonebot_plugin_saa` | Webhook 或 Bot API |
| `CeobeCache` / `ExpiringDict` | 任意 TTL 缓存，例如 `cachetools.TTLCache` |
| 内存里的 `exists_posts` | SQLite / PostgreSQL，按 `item.id` 唯一索引 |

### 建议的模块切分

```text
ceobe/
├── api.py        # 四个请求 + 响应模型
├── models.py     # CeobeTarget / CeobeCookie / ...
├── cache.py      # 数据源、comb_id、cookie_id 的 TTL 缓存
├── dispatch.py   # 全量饼干 -> {unique_id: [cookie]}
├── render.py     # cookie -> Discord embed / 附件
├── store.py      # 订阅表 + 已读表
└── poller.py     # 轮询循环
```

### 最小流程

```python
async def poll_once(state, api):
    sources = await api.list_sources()                      # 1 天缓存
    if not state.comb_id:
        state.comb_id = await api.get_comb_id(sources)      # 12 小时缓存

    cookie_id = await api.get_latest_cookie_id(state.comb_id)
    if cookie_id == state.cookie_id:
        return

    state.cookie_id = cookie_id
    cookies = await api.get_cookies(cookie_id, state.comb_id)

    for unique_id, group in dispatch(cookies, sources).items():
        subscribers = state.subscribers_of(unique_id)
        fresh = [c for c in group if not state.seen(c.item.id)]
        if not fresh:
            continue
        for channel_id in subscribers:
            await send(channel_id, [render(c) for c in fresh])
        state.mark_seen(c.item.id for c in fresh)
```

轮询间隔照抄 15 秒即可。常态下一个 tick 大约三个请求，其中两个有缓存。

::: warning
第一次启动时只写 `seen`、不发送，沿用 `bison_init_filter` 的行为。否则会把历史饼干全推一遍。
:::

### Post 字段映射

| Bison `Post` | Discord |
| --- | --- |
| `content` | `embed.description`（上限 4096）或 `content`（上限 2000） |
| `title` | `embed.title`（上限 256） |
| `url` | `embed.url` |
| `nickname` | `embed.author.name` |
| `avatar` | `embed.author.icon_url` |
| `timestamp` | `embed.timestamp`（ISO8601） |
| `images` | `files[n]` + `embed.image.url = "attachment://..."` |
| `repost` | 第二个 embed，或引用块 |
| `description` | `embed.footer.text`（上限 2048） |

Discord 的限制（以官方文档为准）：

- 单条消息最多 10 个 embed，所有 embed 的文字字段加起来不超过 6000 字符。
- 文件上传默认每个文件 20 MiB，Nitro / Boost 可能更高。`files[n]` 配 `attachments` 用 `multipart/form-data`。
- 远程图片可以直接填在 `embed.image.url`，但微博图床需要 referer，Discord 代理抓不到，必须下载后上传。
- Webhook 可以不建 bot，`wait=true` 会返回创建出来的消息，方便确认成功。

::: warning
官网截图是 1024 宽、高度按页面算，可能非常长。转成 JPEG 或按平台限制切图，别直接丢 PNG。
:::

### 限速

Discord 的限速按路由和顶层资源计算，**不要把具体数字写死**。读响应头：

- `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset-After` / `X-RateLimit-Bucket`
- 429 时读 `Retry-After` 或 `retry_after`

另外两个硬限制：全局 50 请求/秒；10 分钟内 10000 个无效请求（401、403、429）会触发临时封禁。

一次新饼干只对应一条消息，正常量级碰不到限速。真正要小心的是「启动补推」和「一个饼干发多张图」。

## 已知的坑

- `get_date` 的毫秒/秒混用（见上），Bison 里无害，移植时会静默失效。
- 官网截图的 selector 是写死的，页面改版只剩文字兜底。
- `CeobeDataSourceCache` 容量 100、每笔 1 天，超过会淘汰；只在新查询未命中时刷新。
- `CeobeCache` 是类级别共享，不是每个实例一份。
- `display_type` 只有公告类数据源有，其他类型不要拿它做判断。
- `docs/dev/cookie.md` 里「小刻食堂没有 Target」的说法已过时，代码是 `has_target = True`。
- `is_common = False`，所以 `/sub` 的常用平台列表里看不到它，要回「全部」。

## 测试与 fixtures

fixtures 在 `tests/platforms/static/`：

| 文件 | 内容 |
| --- | --- |
| `ceobecanteen_targets.json` | 数据源清单 |
| `ceobecanteen_comb_id_0/1.json` | 两次组合 id |
| `ceobecanteen_cookie_id_0/1.json` | 两次 cookie id |
| `ceobecanteen_cookies_0/1.json` | 两批饼干 |
| `ceobecanteen_cookies_with_retweet.json` | 带转发的饼干 |
| `ceobe_special_cookies.json` | 官网、公告、普通饼干各一条 |
| `ceobe_looooong_bulletin.json` | 超长公告，截图压力测试 |
| `ceobe_looooong_offical_website.json` | 超长官网，截图压力测试 |

对应的测试在 `tests/platforms/test_ceobecanteen.py`：

- `test_batch_fetch_new_with_single`：三次 tick 的缓存行为、第一次不推送、新饼干的字段。
- `test_parse_target_fuzzy`：昵称模糊匹配的候选提示。
- `test_ceobe_snapshot`：两类截图和普通饼干的解析（带 `render` marker）。
- `test_parse_crazy`：手动运行的超长截图测试，CI 跳过。

运行：

```bash
uv run pytest tests/platforms/test_ceobecanteen.py -m "not render"
```

## 相关文件

- `nonebot_bison/platform/ceobecanteen/platform.py`：平台主体
- `nonebot_bison/platform/ceobecanteen/models.py`：数据模型
- `nonebot_bison/platform/ceobecanteen/cache.py`：缓存与 HTTP transport
- `nonebot_bison/platform/ceobecanteen/const.py`：接口地址
- `nonebot_bison/platform/ceobecanteen/utils.py`：响应校验
- `nonebot_bison/theme/themes/ceobe_canteen/build.py`：渲染主题
- `tests/platforms/test_ceobecanteen.py`：行为测试

---

## 上游授權（MIT）

原文與原始碼來自 [nonebot-bison](https://github.com/MountainDash/nonebot-bison)，版權聲明如下：

```text
MIT License

Copyright (c) 2021 felinae98

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
