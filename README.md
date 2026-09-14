# Cloud Realify 云端写实化

在 SillyTavern 中选中聊天图片，调用云端图片编辑模型转换为写实风格。面向安卓 Termux 与手机浏览器，无需本地模型。

## 安装

本仓库根目录的 `manifest.json` 就是扩展入口。在酒馆中打开「扩展 → 安装扩展」，粘贴下面的**整个仓库 HTTPS 地址**，安装并刷新页面。不要填仓库子目录、单个文件或 ZIP 下载链接。

```text
https://github.com/t81410-bot/cloud-realify
```

这是第三方扩展仓库，不代表已经收录到酒馆官方扩展目录。手机安装和真实生图的验证状态见下方验证记录。

要求 SillyTavern 1.18.0 或更高；已核对的源码基线是 1.18.0。扩展使用浏览器内置 API，无须运行 npm、安装 Server Plugin、修改 config.yaml 或设置 Termux 环境变量。

如果装过 0.1.0 版，请先在扩展列表停用旧版，避免两个界面同时运行；旧版的服务端插件不属于新版依赖。安装到同名目录时，酒馆会提示目录已存在，应通过原扩展的更新功能或先卸载旧 UI 后安装；不要删除聊天数据。

## 配置与使用

1. 点击右下角「写实化」，展开连接设置。
2. 默认服务商为 Venice，地址为 `https://api.venice.ai`，模型为 `qwen-edit-uncensored`。
3. 在密码输入框填写 Venice API Key。
4. 选择聊天图片或手机图片，选择写实风格，点击「开始写实化」。
5. 生成后可预览、下载、分享或写入当前聊天。

密钥仅保留在当前页面内存中，不写入酒馆设置、角色卡、聊天记录或浏览器存储。刷新、关闭页面或禁用扩展后需重新填写。切换服务商或修改 API 地址也会清除已填写密钥。地址和模型等非敏感设置可以保存。

「配置已填写」仅表示本地格式校验成功，不能证明密钥、账户余额或模型可用。第一次生成才会实际验证上游服务，也可能计费。NovelAI 的密钥不能用于 Venice。

浏览器兼容提醒：2026-09-14 在桌面内置浏览器使用无效测试密钥，能够收到 Venice 的 HTTP 401 鉴权响应，但这不等于真实生成或安卓 Chrome 已验证。其当日预检仅返回 `Access-Control-Allow-Headers: *`，没有明确列出 `Authorization`；按浏览器 Fetch 规范，这可能阻止带密钥的跨域请求。若手机出现 CORS 错误，不能通过更换密钥解决，需要服务商修正跨域响应，或改用你信任且明确支持该请求头的兼容服务地址。不要关闭浏览器安全功能。

## OpenAI-compatible 图片编辑接口

选择 OpenAI-compatible，填写支持 `POST /v1/images/edits` 的服务地址、图片编辑模型与 API Key。默认地址为 `https://api.openai.com/v1`。仅支持聊天或图片理解的代理不适用。

该服务需要允许来自酒馆页面的浏览器跨域请求（CORS），包括 Authorization 请求头。扩展不会使用公共代理转发密钥，也不会要求关闭浏览器安全检查。不支持 CORS 的服务需要使用此前的服务端插件版或由服务商配置跨域支持。

通用接口使用 multipart 图片上传，要求返回 `data[].b64_json`；只有临时图片 URL 的返回格式目前不支持。安全模式切换只对 Venice 有效，通用接口遵循服务商自身内容策略。

## 请求与数据

- 源图片和编辑要求由浏览器发送给你填写的 HTTPS 服务地址；其他已安装的同页面扩展属于同一浏览器信任边界。
- 进行中的请求会禁用重复操作。刷新后留下的待确认标记会阻止自动重新生成；结果未知时，需要明确确认新的尝试。
- 本版没有额外服务端去重缓存、限流或密钥托管。浏览器锁能减少误操作，不能替代供应商的计费或限流机制。
- 原图上限 15 MiB，输出上限 30 MiB；供应商可能有更小限制。支持 PNG、JPEG、WebP。
- 生成期间切换聊天不会自动把结果写进另一个聊天。写回使用酒馆的保存方法，并回读核对本次结果；不支持同一聊天跨多个标签页并发编辑。

## 开发验证

```sh
npm test
npm run verify
```

测试使用模拟响应，不访问付费图像接口。验证范围和尚未完成的手机验收见 [VERIFICATION.md](VERIFICATION.md)。

## 来源

- [SillyTavern 1.18.0 扩展安装源码](https://github.com/SillyTavern/SillyTavern/blob/51ad27fb86d39a3daca3adaa970375c9670c12df/src/endpoints/extensions.js)：克隆仓库后读取仓库根目录的 manifest.json。
- [SillyTavern 扩展开发文档](https://docs.sillytavern.app/for-contributors/writing-extensions/)。
- [Venice 图片编辑接口](https://docs.venice.ai/api-reference/endpoint/image/edit)。
- [Fetch 规范：Authorization 不能由 CORS 请求头通配符匹配](https://fetch.spec.whatwg.org/#cors-non-wildcard-request-header-name)。

模型可用性和接口行为以服务商当时文档为准。
