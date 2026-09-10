<h1 align="center">pi-qqbot</h1>

<p align="center">QQ 机器人作为 pi TUI 的移动端分身 — 通过 QQ 私聊 / 群聊 @ 远程与 pi 双向交互。</p>

QQ 用户发消息注入当前 pi 会话，pi 的回复增量发回 QQ；人不在电脑前，也能在 QQ 里继续指挥 pi 写代码、跑命令、看结果。

## 功能

| 能力 | 说明 |
| --- | --- |
| 文字双向 | 私聊 / 群聊 @ 消息注入 pi，回复增量推送回 QQ |
| 图片接收 | QQ 发图 → 转 base64 → 作为图片附件交给 pi 分析 |
| 图片/文件发送 | 工具 `send_image_to_qq` / `send_file_to_qq`，仅限项目目录内、≤50MB |
| 消息队列 | pi 忙时以 `followUp` 排队；纯图片先回执再合并处理（默认 8s） |
| 远程命令 | QQ 里发 `/status` `/stop` `/model` `/name` `/session` `/help` 等 |
| 多实例锁 | 同一时间只允许一个 pi 实例占用桥接 |
| 自动启动 | 会话启动时自动连接网关（`/qq autostart`） |
| Markdown 渲染 | 优先 QQ 原生 Markdown，失败自动降级纯文本并记住结果 |
| 会话安全 | 单聊仅绑定用户；群聊默认白名单，需显式 `/qq groups add` 或 `allowall on` |
| 问卷降级 | QQ 轮次自动拦截 `ask_user_question`，引导模型改用文本编号提问（电脑端 TUI 不受影响） |

## 前置条件

- 已在 [QQ 机器人开放平台](https://q.qq.com/) 创建机器人，并开通**单聊（C2C）**与/或**群聊 @** 消息能力（`GROUP_AND_C2C_EVENT` 意图）。沙箱环境通常无需审批。
- 如需主动消息（超出被动回复配额后继续发送），需开通主动消息权限，并在 QQ 客户端允许机器人主动发送。
- Node.js >= 20.3（推荐 22+，网关依赖较新的 `WebSocket`）。

> 没有机器人也可以直接 `/qq login`：会走 QQ 官方绑定流程，扫码后在手机 QQ 确认即可拿到 AppID/AppSecret 与你的 openid。

## 安装

```bash
pi install /绝对/路径/pi_qqbot   # 全局
pi install /绝对/路径/pi_qqbot -l # 仅当前项目（.pi/settings.json）
```

装完重启 pi 或 `/reload`，输入 `/qq status` 能看到状态即加载成功。

> 项目级安装需项目被信任：在该目录启动 `pi` 时选择信任，或用 `pi list -a` 等命令加 `--approve`；否则项目级扩展不会被读取。

## 快速开始

```text
/qq login    # 手机 QQ 扫码绑定机器人
/qq start    # 启动桥接（连接网关）
```

然后在 QQ 里给机器人发消息（或群里 @ 机器人）即可远程对话。

```text
/qq stop     # 停止桥接
/qq logout   # 清除凭证并停止
```

## TUI 命令

| 命令 | 说明 |
| --- | --- |
| `/qq login [--force]` | 扫码绑定 / 强制重新绑定 |
| `/qq start` / `/qq stop` | 启动 / 停止桥接 |
| `/qq status` | 运行、凭证、网关、白名单等状态 |
| `/qq config` | 图片参数：`image-wait`、`image-max` |
| `/qq groups` | 群白名单：`add <id>` / `remove <id>` / `allowall on\|off` |
| `/qq render` | 渲染模式：`auto` / `markdown` / `text` |
| `/qq sandbox` | 沙箱环境开关（改动后需重启桥接） |
| `/qq autostart` | 会话启动时自动连接 |
| `/qq remotetools` | 开关 QQ 端 `/tools`（默认关闭） |

## QQ 端远程命令

```text
/status  /stop  /model  /compact  /thinking  /reload  /name <名称>  /session  /config  /help
```

`/tools` 默认禁用，需电脑端 `/qq remotetools on`。直接发文字或图片即为正常对话。

`/reload` 会重载扩展并断开 QQ 桥接，因此**仅在电脑端已开启 `/qq autostart` 时可用**（否则直接拒绝，避免把自己踢下线）。

## 配置

`~/.pi/agent/pi-qqbot/config.json`（状态目录可用 `PI_QQBOT_STATE_DIR` 覆盖）：

```jsonc
{
  "autoStart": false,        // 会话启动自动连接
  "sandbox": false,          // 使用 QQ 沙箱环境
  "intents": null,           // 覆盖默认意图（默认 GROUP_AND_C2C_EVENT）
  "allowRemoteTools": false, // 允许 QQ 端 /tools 修改本机工具权限
  "imageBatchWaitMs": 8000,  // 纯图片合并等待
  "imageMaxBytes": 52428800, // 单张图片下载上限（字节）
  "renderMode": "auto",      // auto | markdown | text
  "allowedUsers": [],        // 额外允许的单聊 openid
  "allowedGroups": [],       // 允许响应的群 openid
  "allowAllGroups": false    // 是否允许所有 @ 机器人的群
}
```

环境变量：`PI_QQBOT_DEBUG=1`（调试日志）、`PI_QQBOT_IMAGE_BATCH_WAIT_MS`、`PI_QQBOT_IMAGE_MAX_BYTES`。

> QQ 对同一条消息的被动回复上限为同一 `msg_id` 5 次、5 分钟。超额后自动退化为主动消息；未开通主动消息权限时建议单轮回复精简。

## 已知限制

- 群聊仅在**被 @** 时由 QQ 推送（`GROUP_AT_MESSAGE_CREATE`）；陌生群默认不响应。
- QQ 原生 Markdown 需机器人开通权限，未开通时自动降级纯文本。
- QQ 无输入中状态接口；附件基本为图片，非图片附件以文字提示呈现。
- 富媒体发送受 QQ `file_data` 类型/大小限制，失败时工具返回错误信息。
- `ask_user_question` 在 QQ 轮次不可用：TUI 问卷是阻塞式的，QQ 端无法作答，也已无扩展侧作答 API。pi-qqbot 会在 QQ 轮次注入提示并拦截该工具，让模型直接用编号列表提问；你在电脑前时它仍照常工作。

## 开发与测试

```bash
npm install
npm run typecheck
npm test
```

```
src/  index.ts(扩展) gateway.ts(网关) api.ts(OpenAPI) client.ts(客户端)
      auth.ts config.ts queue.ts message.ts media.ts security.ts
      remote-commands.ts commands.ts constants.ts logger.ts types.ts utils.ts
tests/  node --test 单元与启动测试
```

## 致谢

- [pi-wechat-assistant](https://github.com/shenjiecode/pi-wechat-assistant)（作者 shenjiecode）：本项目完整参考其交互模型与工程结构（会话状态、消息队列、增量回复、远程命令、TUI 管理命令、多实例锁等）。

## License

MIT
