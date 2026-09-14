# Cloud Realify 0.2.0 验证记录

日期：2026-09-14。

## 与 0.1.0 的区别

0.2.0 是根目录包含 manifest.json 的独立 UI 扩展。它通过浏览器直连图片编辑 API，不依赖旧版 `/api/plugins/cloud-realify/*`、Termux 环境变量或额外 Server Plugin。密钥只保留在当前页面内存。

## 已核对的外部能力

- 固定源码基线：SillyTavern 1.18.0，commit `51ad27fb86d39a3daca3adaa970375c9670c12df`。
- 扩展管理器 `/api/extensions/install` 只接受 HTTP(S) Git 地址，clone 后读取根目录 manifest.json。
- 该固定版本没有原生 Venice 图片编辑路由；OpenAI 路由是图片生成，不能代替图片编辑。
- 2026-09-14 对 `https://api.venice.ai/api/v1/image/edit` 发送无密钥 OPTIONS（请求 authorization,content-type）：HTTP 200，Access-Control-Allow-Origin 为 `*`，Access-Control-Allow-Headers 为 `*`，允许 POST，但未明确列出 Authorization。这不能按 Fetch 规范证明所有浏览器都能直连。
- 桌面内置 Chromium 浏览器从本地测试页，以无效测试密钥和空 JSON 对象发出一次请求，收到了 HTTP 401。未提交真实密钥或图片，未产生有效图片生成。安卓 Chrome 的实际跨域兼容仍待验证。

## 本地验证

- `npm test`：46 项通过，0 失败。涵盖两种上游请求格式、配置校验、图片格式与体积限额、超时/取消、错误脱敏、零自动重试、跨标签互斥和聊天回读判定。
- `npm run verify`：13 个发布文件检查通过；根目录 manifest、版本一致性、本地模块路径、生命周期导出及常见密钥形状扫描通过。
- 扩展技能的 manifest 校验：通过，无警告。宿主能力检查：对照旧版已有的 1.18.0 固定源码快照通过；它不是用户手机的安装快照。
- 浏览器模拟宿主：21 项断言通过。验证 Key 不进入设置/localStorage/sessionStorage、更换地址和服务商清除 Key、进行中锁定、一次点击一次请求、调用宿主 saveChat 后回读确认、失败不重试、未知结果保护及禁用/启用清除 Key。
- 该浏览器模拟使用拦截后的图片 API 与假宿主保存方法，不属于真实 SillyTavern、真实供应商生成或手机安装验收。

## 公开仓库验证

- 仓库：`https://github.com/t81410-bot/cloud-realify`，公开，默认分支 `main`。
- 2026-09-14 通过 GitHub 网页发布；未修改其他仓库，未上传密钥或聊天数据。
- 使用不带凭据的 Git HTTPS 克隆到独立目录，成功。
- 对提交 `8e94c54b7d5fc87463dd1d408676a73a6f664463` 下载副本逐文件比对：13 个文件与本地发布源一致（忽略 Windows/Linux 换行差异）。
- 下载副本重新执行 `npm test`：46 项通过，0 失败；`npm run verify`：通过，根目录 manifest 和 13 文件清单正确。
- 此后仅补充本验证记录，不修改扩展运行代码或测试。

## 待完成

- 用户手机中通过「安装扩展」的实际安装、刷新及启停。
- 安卓 Chrome 中带 Authorization 的实际跨域请求；桌面内置浏览器的 HTTP 401 不能替代此项。
- 使用用户账户进行一次真实图片编辑，并确认刷新后聊天仍保留结果。

本版不能继承 0.1.0 的全部真实宿主或服务端测试结论；仅直接复用未更改部分的实现。
