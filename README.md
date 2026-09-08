# dsh-drop-in

> **把任何内容直接拖进 DeepSeek Harness (DSH) 的对话框** —— 本地文件、网页图片、链接、选中的文字，agent 立刻拿到可读的绝对路径引用。

**English TL;DR**: A DeepSeek Harness (DSH) plugin that lets you drag & drop anything into the chat composer. Local files are uploaded to `<workspace>/.dropped/<sessionId>/` and a markdown link with the **absolute path** is appended to the message, so the agent can read them directly with fs tools. Web images & links are downloaded host-side (streamed, redirect-following, retry, 2 GiB cap). Plain text is inserted into the composer; oversized text becomes a `.md` file. Pure local images pass through to DSH's native vision-attachment pipeline; folders pass through to native workspace adoption.

---

## 为什么需要它（解决什么问题）

DSH Desktop 的原生拖拽只支持两类内容：

- 拖**图片**进输入框 → 走原生视觉附件（多模态直出）
- 拖**文件夹**进工作区面板 → 通过 Electron 桥收养为工作区

拖**任意单个文件**（PDF / zip / 代码 / 音频 / 安装包……）**没有官方通道**——而且浏览器安全模型下，Web 端拖入文件只能拿到 `File` 对象（名字+内容），**拿不到本地绝对路径**，agent 也就无法「知道你指向的是哪个文件」。

本插件的方案：**拖拽 → 上传落盘到会话目录 → 往输入框注入 `[附件: 文件名](绝对路径)` 引用**。文件落到了 agent 的文件系统里，引用里带着绝对路径，模型用 fs 工具直接读——这就是「拖进去就知道指向什么」。

## 安装 Install

前提：DSH Desktop for Windows（本插件在 desktop profile 上开发验证，`node >= 22.13`）。

**方式 A —— 有 git（标准）**：

```bash
dsh plugin add github:zhanghuqqqq/dsh-drop-in --profile <你的profile>
```

**方式 B —— 没有 git（zip 直装，Windows PowerShell）**：

```powershell
# 本插件发布时，很多 DSH 用户机器上没有 git，pnpm 走 github: 协议会失败；
# 直接下载 zip 从本地目录安装，效果完全一致。
Invoke-WebRequest "https://codeload.github.com/zhanghuqqqq/dsh-drop-in/zip/refs/heads/main" -OutFile "$env:TEMP\dsh-drop-in.zip"
Expand-Archive "$env:TEMP\dsh-drop-in.zip" "$env:TEMP\dsh-drop-in-src" -Force
$dir = (Get-ChildItem "$env:TEMP\dsh-drop-in-src" -Directory | Select-Object -First 1).FullName
dsh plugin add $dir --profile <你的profile>
```

> 查看自己的 profile 名：`dsh plugin list --profile <名字>` 能列出即为有效；DSH Desktop 默认 profile 通常叫 `desktop`。

**装完必须重启一次 DSH Desktop**（插件 bundle 在启动时装配）。

## 使用 Usage

装好重启后，把任何内容拖到对话窗口任意位置，会出现全屏覆盖层「松手，添加到对话」，并实时提示将采取的动作：

| 拖入内容 | 行为 | agent 看到什么 |
|---|---|---|
| 本地文件（任意类型，≤20 个） | 流式上传到 `<工作区>/.dropped/<sessionId>/` | 消息追加 `[附件: 名](绝对路径)` |
| 纯本地图片 | 放行给原生视觉附件通道（多模态直出） | 原生图片附件 |
| 文件夹 | 通过桌面桥解析磁盘绝对路径（零拷贝） | `[文件夹: 名](绝对路径)` — agent 直接 fs 遍历原位置 |
| 网页图片（从浏览器拖） | host 端流式下载（跟随重定向、自动重试） | `[网页图片: 名](绝对路径)` |
| 链接 / 地址栏 URL | 下载目标资源；失败自动把链接插入输入框兜底 | `[网页资源: 名](绝对路径)` |
| 选中的文字 | ≤5000 字符插入输入框；更长存为 `.md` 文件 | 插入的文本或 `[拖入文字: 名](绝对路径)` |

上传/下载以 toast 反馈成败。

## 工作原理 Architecture

```
浏览器 (client.js)                          Host (index.js, Node)
┌────────────────────────────┐   PUT /upload?sessionId&name   ┌──────────────────────────┐
│ document capture dragover   │ ────────────────────────────► │ 校验 session → 落盘        │
│ document capture drop       │ ◄──────────────────────────── │ <workspace>/.dropped/     │
│   ├ 分类器 classifyDrop()   │        {absolutePath}          │   <sessionId>/<唯一文件名> │
│   ├ 文件 → PUT 上传         │                               └──────────────────────────┘
│   ├ URL → POST /fetch-url   │ ────────────────────────────► Node fetch 流式下载
│   ├ 文字 → setDraft 插入    │                               （重定向/重试/2GiB 上限）
│   ├ 文件夹 → 桥解析路径引用  │
│   └ 纯本地图片 → 放行原生   │
└────────────────────────────┘
        │ inputActions.setDraft("[附件: x](绝对路径)")
        ▼
  消息发出后 agent 读 markdown 链接里的绝对路径 → fs 工具直接读文件
```

关键设计：

1. **文件身份 = 文件名**。目录按会话隔离（`.dropped/<sessionId>/`），重名自动 `_1/_2` 后缀，无数据库、无索引，文件系统即注册表。
2. **引用即绝对路径**。client 插入的是 markdown 链接，括号内就是磁盘绝对路径，模型零间接。
3. **system prompt 注入约定**。host 端检测到本会话 `.dropped/` 目录非空时，自动向 system prompt 注入一段说明，告诉模型「消息里 `[附件: …](路径)` 即拖放文件，直接读括号内路径」。
4. **与原生行为协调**（passthrough 规则）：`dt.files` 全部为 `image/*` 且无文件夹 → 放行给原生视觉附件；其余（含文件夹）一律由本插件接管——文件夹通过桌面桥 `__DSH_DESKTOP_FILE_PATH__` 解析绝对路径后直接引用，不落入原生图片管线（避免其「仅支持 PNG/JPG/WebP/GIF」拒绝）。
5. **client 只通过官方 slot 契约触碰输入框**：slot `conversation.input.left` 的 props 提供 `sessionId`、`inputActions.setDraft`、`useInput`；React 通过 DSH 的 `__ModuleLoader__` require 同一实例，无双 React 问题。
6. **兜底防导航**：未被处理的文件 drop 一律 `preventDefault()`，防止浏览器直接打开文件导致页面跳走。

### 拖拽分类决策表（精确规则）

优先级从上到下（drop 时判定，dragover 时用同一逻辑的粗粒度版本驱动覆盖层提示）：

1. `dt.files` 非空（drop 时同步解析，`DataTransferItemList` 仅在 drop handler 内有效）：
    - 目录条目（`webkitGetAsEntry().isDirectory`）→ 经桌面桥解析绝对路径，收集为 **folders** 引用
    - 剩余普通文件全部为 `image/*` 且无目录 → **passthrough**（原生视觉附件）
    - 普通文件数 > 20 → 拒绝并 toast（文件夹引用不受此限）
    - 否则 → **takeover**（文件逐个上传 + 文件夹路径引用，合并插入）
2. `dt.files` 为空：
   - `text/html` 含 `<img src="data:...">` → 转成 Blob 走上传
   - `text/html` 含 `<img src="http(s)://...">` 或 `text/uri-list` 首条为 http(s) 且 `text/plain` 等于它 → **url**（host 下载）
   - `text/plain` 非空 → **text**（插入或落盘）
   - 其他 → 忽略

## Host API

前缀 `/dsh-drop-in/v1`，全部要求合法 `sessionId`（`session-<uuid>` 或裸 `<uuid>`），落盘严格限制在会话目录内（路径围栏）：

| 路由 | 说明 | 成功响应 |
|---|---|---|
| `PUT /upload?sessionId&name` | body 为原始文件流，流式写盘，上限 8 GiB | `{name, absolutePath, size}` |
| `POST /fetch-url` | body `{sessionId, url}`，Node fetch 流式下载，跟随重定向、120s 超时、5xx/429/网络错误自动重试 2 次、上限 2 GiB；文件名推断顺序：URL basename → `content-disposition` → `content-type` 映射扩展名 | `{name, absolutePath, size, contentType, finalUrl}` |
| `POST /save-text` | body `{sessionId, name, text}`，保存拖入文字，上限 10 MiB | `{name, absolutePath, size}` |
| `DELETE /file?sessionId&name` | 删除一个已落盘文件 | `{ok: true}` |

错误统一为 `{error: {code, message}}`；仅接受 http/https 下载。

## 已知限制 Limits

- 单次拖入最多 20 个文件
- URL 下载上限 2 GiB（拖拽场景以网页图片为主；大文件下载建议直接让 agent 用系统 curl 带断点续传）
- 纯图片拖入走原生视觉附件，不会落盘出引用（想落盘就混一个非图片文件一起拖）
- 需要 DSH Desktop 的 slots/webServer/systemPrompt 插件契约（`@deepseek-ai/*` `0.1.0-rc` 系列 API）

## 排错 Troubleshooting

| 症状 | 原因与处理 |
|---|---|
| 安装时报 `another plugin install recovery transaction is pending` | 上一次插件安装的恢复事务还没被 Desktop 重启验证。**重启 DSH Desktop** 即可（启动时会自动 verify 并清理）；确认无文件差异后也可手动删除 `%APPDATA%\DSH Desktop\plugin-install-recovery\state.json` |
| `dsh plugin add github:...` 失败 `'git' 不是内部或外部命令` | 机器没装 git。改用上方**方式 B**（zip 直装） |
| 装完拖拽没反应 | 没重启 Desktop，或插件未进入 bundle。`dsh plugin list --profile <profile>` 应能看到 `dsh-drop-in`，且 profile `package.json` 的 `dsh.profile.bundles` 包含 `dsh-drop-in` |
| 拖本地图片直接变成聊天里的图片附件 | 正常——纯图片走原生视觉通道（passthrough 规则） |
| 拖网页图片 toast 报 403 | 目标站防盗链（Referer 校验），插件无法伪造浏览器会话；可把图片右键另存后拖本地文件 |
| 上传 404 `Session workspace not found` | sessionId 校验失败（多开会话切换瞬间旧页面仍挂着），重发一次消息即可 |
| 长文本没落盘 | 小于 5000 字符的策略是直接插入输入框，不是 bug |
| 拖非图片文件到工作区面板出现两个提示 | 已知低危残留：DSH 桌面壳对工作区面板的拖放只接受恰好一个文件夹，拖入普通文件时面板内嵌显示『请只拖入一个文件夹』（3 秒自动消失），同时插件正常上传该文件——双提示属预期，上传不受影响；拖到输入框或其他区域则只走插件上传，无任何原生提示 |

**日志**：host 端报错都走 HTTP 响应体（`{error:{code,message}}`），client 端以 toast 展示；DSH Desktop 日志在 `%DSH_HOME%\logs\`。

## 给 AI agent 的部署与维护指引（For LLM agents）

如果你是一个正在帮用户部署/修改本插件的 AI agent，按此清单操作：

1. **仓库结构**：`package.json`（`dsh.bundle.patch` + `dsh.client.inject` 声明）、`cordis.patch.yml`（bundle insert）、`lib/index.js`（host，ESM，`inject = ['agents','webServer','systemPrompt']`）、`lib/client.js`（client，`window.__ModuleLoader__.load({id:'dsh-drop-in', factory:(require)=>{...}})` 的 CJS 包装，`require('react')` 取 DSH 同实例）、`tests/smoke.mjs`（12 项 host 行为测试）。
2. **无构建链**：直接改 `lib/*.js` 源文件即可，无需编译。改完 `node --check lib/index.js && node --check lib/client.js`，再 `node tests/smoke.mjs` 全绿。
3. **本地安装**：`dsh plugin add <本仓库目录> --profile <profile>`（link 安装），**重启 DSH Desktop** 生效。
4. **调整上限**：host 端常量 `MAX_UPLOAD_BYTES` / `MAX_FETCH_BYTES` / `MAX_TEXT_BYTES` / `FETCH_TIMEOUT_MS`；client 端 `MAX_INLINE_TEXT`（文字落盘阈值）/ `MAX_FILES_PER_DROP`。
5. **验证 host 路由**：可对 `http://127.0.0.1:43120/dsh-drop-in/v1/...` 用 curl 实测（DSH Web 默认端口 43120），需要真实 sessionId。
6. **踩坑记录**：fine-grained PAT（`github_pat_`）默认无「创建仓库」权限（403 `Resource not accessible`）；Windows CredRead 读 GCM 凭据需尝试 UTF-16LE/UTF-8 两种 blob 解码取 printable ASCII 者。

## 开发 Dev

```bash
node tests/smoke.mjs   # 12 项 host 端行为测试（mock context + 本地 origin server）
node --check lib/index.js && node --check lib/client.js
```

## License

MIT
