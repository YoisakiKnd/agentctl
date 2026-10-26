# agentctl — 多智能体会话管理台 · 技术方案

> 目标：一个本地优先的 Web 控制台，统一管理 **Claude Code / Codex / Pi / Cursor / DeepSeek Harness(dsh)** 的会话。
> 对标 CloudCLI（原 claudecodeui），但内核按「适配器 + 统一事件模型」设计，新增一个 agent 只需加一个包。

---

## 0. 结论先行

| 决策 | 选择 | 理由 |
|---|---|---|
| 自建 vs fork CloudCLI | **自建薄内核**（借鉴其功能面，不复用其代码） | CloudCLI 是 AGPL-3，且把每个 agent 的协议逻辑耦合在自己的 server 里；我们要的是一层可扩展适配器 |
| 会话真相源 | **CLI 自己的磁盘文件是唯一真相**，我们的 DB 只存索引和 UI 注解 | 不复制、不迁移、不写回；用户随时可以在终端里继续同一个会话 |
| 执行路径 | **三档降级**：ACP → CLI headless(stream-json) → 只读解析 | 每个 agent 能力不同，硬套统一协议会一路踩坑 |
| 后端 | Node 24 + Fastify 5 + WebSocket + `node:sqlite` + `node-pty` | Node 24 自带 `node:sqlite` 与 `zlib.zstdDecompress`，两个原生依赖直接省掉 |
| 前端 | React 19 + Vite + TS + TanStack Query + xterm.js | 生态成熟；时间线要自己写虚拟化，不能用现成 chat 组件 |
| 首期范围 | **Claude Code + Codex + DSH 三个**（本机已装、有真实历史数据） | Cursor/Pi 本机未装 CLI，先留接口后补 |

---

## 1. 本机现状勘察（方案的硬约束）

### 1.1 已装 CLI

| Agent | 可执行文件 | 版本 | 备注 |
|---|---|---|---|
| Claude Code | `~/.local/bin/claude` | 2.1.310 | 支持 `-p --input-format stream-json --output-format stream-json --resume --include-partial-messages` |
| Codex | `~/.bun/bin/codex` | 0.164.0 | 有 `exec --json`、`exec resume`、**`app-server`(JSON-RPC)**、`agents/queue/fork/archive/delete` |
| DSH | `~/.bun/bin/dsh` | 0.1.7-rc.2 | 有 `--profile acp` / `--profile sdk`(JSON-RPC stdio) / `--profile headless` |
| Codex ACP 适配器 | `~/.bun/bin/codex-acp` | 0.0.44 | `@agentclientprotocol/codex-acp`，可直接走 ACP |
| Pi | 仅 `pi-ai` 0.85.1 | — | 无 `pi` 可执行文件，但 `~/.pi/agent/sessions` 有历史会话 |
| Cursor | **未安装** | — | `~/.cursor` 只有一个空的 `projects/` |

### 1.2 会话文件真相源（已实测）

| Agent | 路径 | 格式 | 规模实测 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/<cwd 的 / 换成 ->/<uuid>.jsonl` | JSONL，`type` ∈ `user/assistant/system/attachment/last-prompt/mode/permission-mode/file-history-snapshot/api-request*/ai-title` | 15 个文件 **422MB**，最大单文件 **175MB / 13839 行**（≈13KB/行，图片 base64 内联） |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl` + `session_index.jsonl`（id→thread_name）+ `thread_history_1.sqlite` | JSONL，`type` ∈ `session_meta/response_item/event_msg/turn_context/world_state/token_usage_record` | 9 个文件 7.9MB |
| Pi | `~/.pi/agent/sessions/<cwd slug>/<iso>_<uuid>.jsonl` | JSONL v3：首行 `{type:"session",cwd}`，后续 `message/model_change/thinking_level_change`，条目带 `id/parentId`（**树结构**） | 1 个 |
| DSH | `~/.dsh/sessions/<cwd slug>/session-<uuid>/session.v4.jsonl.zstd` + `session.lock` | **zstd 压缩的 JSONL**，`session.lock` 存在表示会话活着 | 30 个 35MB，最大 6.8MB |
| Cursor | `~/.cursor/chats/<hash>/<chatId>/`（待装 CLI 后确认） | 未验证 | 0 |

**这些数字直接决定了三件事：**
1. **绝不能整文件读入内存**。175MB 单文件必须先 stat → 只 tail 读最后 N 字节做首屏，再按需分段回放。
2. **行内媒体要剥离**。单行 13KB 主要是 base64 图片/blob，解析时必须截断并转存为「引用」，前端按需懒加载。
3. **zstd 增量解压**是 DSH 的必做项，用 Node 24 内置 `zlib.createZstdDecompress`（支持多 frame 拼接），索引里记「解压后字节偏移 + frame 序号」。

### 1.3 顺带发现

- `~/.claude-code-ui` + `~/.cloudcli`：这台机器上已经跑过 CloudCLI（含一个 `cloudcli-plugin-claude-usage` 插件）。可以拿它当功能基线对照，但**不要**读它的 `auth.db`。
- `~/.local/share/opencode`、`~/.dsh/im`、`~/.dsh/integrations`：说明还有别的 agent 生态存在，适配器接口要留扩展位。

---

## 2. 产品模型

三层模型，全部以「真实存在于磁盘上的会话」为准：

```
Workspace (一个 cwd / git 仓库)
└── Session (agent + sessionId + 文件)
    └── Turn (一次用户输入 → 一轮 agent 输出，含工具调用)
        └── Item (text / thinking / tool_call / tool_result / diff / usage / approval / notice)
```

**关键原则：不拥有数据，只读数据。**
- 会话标题、轮次、token 用量、工具调用 —— 全部从 agent 文件里解析出来。
- 我们自己的 SQLite 只存三类东西：① 索引缓存（可随时删库重建）② UI 注解（置顶/标签/备注/标题覆盖）③ 运行态（哪个 session 正被谁跑着）。

### 2.1 统一事件模型（整个系统的核心资产）

```ts
// packages/core/src/events.ts
export type Item =
  | { kind: 'text';        role: 'user' | 'assistant'; text: string; media?: MediaRef[] }
  | { kind: 'thinking';    text: string; durationMs?: number }
  | { kind: 'tool_call';   callId: string; name: string; input: unknown; agentRaw?: unknown }
  | { kind: 'tool_result'; callId: string; ok: boolean; output: string; truncated?: TruncInfo }
  | { kind: 'diff';        files: FilePatch[] }
  | { kind: 'usage';       inputTokens: number; outputTokens: number; cacheRead?: number; costUsd?: number; model?: string }
  | { kind: 'approval';    requestId: string; tool: string; detail: string; choices: string[]; state: 'pending' | 'approved' | 'denied' }
  | { kind: 'notice';      level: 'info' | 'warn' | 'error'; code?: string; text: string }; // compaction / 错误 / 系统提示

export interface UnifiedEvent {
  agent: AgentId;          // 'claude' | 'codex' | 'dsh' | 'pi' | 'cursor'
  sessionId: string;
  turn: number;
  seq: number;             // agent 内单调序号（codex 有 ordinal，claude 用行号，dsh 用行号）
  ts: string;              // ISO
  item: Item;
  raw?: { file: string; line: number; type: string }; // 永远保留回到原文的指针
}
```

> 所有适配器只干一件事：**agent 原始 JSON → UnifiedEvent 流**。前端永远只认识这一种结构，新增 agent 不动 UI。

---

## 3. 架构

```
┌──────────────────────── Browser (React 19 + Vite) ────────────────────────┐
│  会话看板 / 时间线(虚拟滚动) / composer / 审批浮层 / 文件·diff 侧栏 / shell │
└───────────────▲──────────────────────────────┬────────────────────────────┘
                │ WS: event stream             │ HTTP: REST
┌───────────────┴──────────────────────────────▼────────────────────────────┐
│                        agentctl server (Fastify 5)                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐  │
│  │  Registry    │ │  Indexer     │ │  Runner      │ │  PTY Host       │  │
│  │ 扫盘+watch   │ │ 增量解析→DB  │ │ spawn/attach │ │ node-pty (shell)│  │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └─────────────────┘  │
│         └────────────────┴────────────────┴──────────────┐                │
│                    Adapter Layer (每 agent 一个包)        │                │
│   adapter-claude │ adapter-codex │ adapter-dsh │ adapter-acp(通用) │ ...   │
└───────────┬──────────────────┬──────────────────┬─────────────────────────┘
            │ 读文件            │ spawn CLI        │
      ~/.claude/projects  ~/.codex/sessions  ~/.dsh/sessions  ~/.pi/...  ~/.cursor/...
```

### 3.1 适配器接口

```ts
// packages/core/src/adapter.ts
export interface AgentAdapter {
  id: AgentId;
  meta: { name: string; binary?: string; docs?: string };
  capabilities: {
    discover: boolean;      // 能扫盘列出历史会话
    replay: boolean;        // 能完整回放历史
    live: 'acp' | 'stream-json' | 'rpc' | 'pty' | false; // 实时执行方式
    resume: boolean;        // 能续接指定 sessionId
    fork: boolean;          // 能从某轮分叉
    approvals: boolean;     // 有工具审批事件
    thinking: boolean;      // 有思考过程
    usage: boolean;         // 有 token 统计
  };

  /** 扫盘发现会话（增量：只看 mtime 变了的） */
  discover(roots: string[], since?: number): AsyncIterable<SessionRef>;

  /** 回放历史：从 offset 开始流式吐 UnifiedEvent */
  replay(ref: SessionRef, opts: { fromSeq?: number; tailBytes?: number }): AsyncIterable<UnifiedEvent>;

  /** 新建 / 续接运行 */
  run(req: RunRequest, sink: EventSink): Promise<RunHandle>;

  /** 解析该 agent 的审批事件并回写答案 */
  respond?(handle: RunHandle, requestId: string, choice: string): Promise<void>;
}

export interface RunHandle {
  id: string;
  pid?: number;
  sessionId: string;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
  onExit: Promise<{ code: number | null; signal?: string }>;
}
```

### 3.2 三档降级策略（每个 agent 落到哪一档）

| Agent | 实时执行首选 | 备选 | 历史回放 |
|---|---|---|---|
| Claude Code | `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --resume <id>`（stdin 写用户消息，stdout 读事件） | `@anthropic-ai/claude-agent-sdk`（本机已有） | 解析 `~/.claude/projects/**.jsonl` |
| Codex | **`codex app-server` JSON-RPC**（原生支持 thread/turn/approval/queue，比抓 stdout 稳得多） | `codex exec --json`（一次性）/ `codex-acp` | 解析 `rollout-*.jsonl` + `session_index.jsonl` 取标题 |
| DSH | **`dsh --profile sdk`** JSON-RPC stdio | `dsh --profile acp` / `dsh --profile headless "<task>"` | 解压 `session.v4.jsonl.zstd` |
| Pi | `pi --print --output-format stream-json`（**待实测**） | PTY 兜底 | 解析 v3 jsonl（按 `parentId` 重建树，主链取 `leaf→root`） |
| Cursor | `cursor-agent -p --output-format stream-json --resume <chatId>`（**待装 CLI 验证**） | ACP | `~/.cursor/chats/**`（待验证） |

> **PTY 兜底是必做项，不是可选项。** 五个 CLI 的 headless 模式永远比 TUI 少功能（交互式确认、斜杠命令、颜色）。所以每个会话都提供「Shell 模式」：`node-pty` 起一个真终端 attach 到同一个 cwd/会话，前端 xterm.js 渲染。这是 CloudCLI 的 `Shell Mode`，也是最省心的功能对齐方式。

### 3.3 运行态与文件流的去重

一个正在跑的会话会同时存在两条数据流：**进程事件**（实时、全量、低延迟）和**磁盘文件**（滞后、完整、真相）。
- 实时：只喂进程事件给前端。
- 进程退出：丢掉进程缓冲，**重读文件**做一次对齐（以文件为准），补齐我们漏掉的 `system/notice` 行。
- 去重键：`(agent, sessionId, seq)`；`seq` 在文件里是行号/ordinal，进程事件按同一规则映射。

---

## 4. 数据层

```sql
-- 索引缓存（可删可重建）
CREATE TABLE workspace (id TEXT PRIMARY KEY, root TEXT UNIQUE, name TEXT, last_seen INTEGER);
CREATE TABLE session (
  id TEXT PRIMARY KEY,            -- agent + ':' + sessionId
  agent TEXT, workspace TEXT, cwd TEXT, file TEXT,
  title TEXT, model TEXT, turns INTEGER,
  created_at INTEGER, updated_at INTEGER,
  size INTEGER, mtime INTEGER, bytes_indexed INTEGER,  -- 断点续读
  parent_id TEXT, running INTEGER DEFAULT 0
);
CREATE TABLE event (
  session_id TEXT, seq INTEGER, turn INTEGER, ts INTEGER,
  kind TEXT, payload TEXT,          -- JSON，媒体已剥离为 MediaRef
  PRIMARY KEY (session_id, seq)
);
CREATE VIRTUAL TABLE event_fts USING fts5(session_id, text, tokenize='trigram');
-- 用户注解
CREATE TABLE annotation (session_id TEXT PRIMARY KEY, pinned INTEGER, tags TEXT, note TEXT, title_override TEXT);
```

**索引策略**
- 冷启动扫描只读每个文件的 `stat` + **尾部 64KB**（拿到最后一条 user 消息、最后时间、turn 数），不做全量解析 → 首屏秒开。
- 打开某个会话时才全量/分段解析，并写 `bytes_indexed` 断点；后续靠 `fs.watch` 增量追。
- 大字段（图片/base64/超长 tool_result）写 `MediaRef{ file, byteOffset, length, mime }`，前端 `/media/<hash>` 按需取。
- 搜索用 FTS5 trigram，中英文都能用。

**为什么不直接读 Codex 的 sqlite？** `thread_history_1.sqlite`、`state_5.sqlite` 是它内部格式，版本会变。只作为「标题/归档状态」的补充来源，不作为主真相源。

---

## 5. 前端

### 5.1 栈

React 19 · Vite · TS · TanStack Query（REST）+ 自建 WS 客户端 · Zustand（运行态）· xterm.js + fit · Shiki（代码高亮）· 自建虚拟列表（`@tanstack/react-virtual`）。

### 5.2 页面

| 路由 | 内容 |
|---|---|
| `/` | 会话看板：按 workspace 分组，每行 = agent 徽标 + 标题 + 轮次 + 相对时间 + 运行态；顶部全局筛选（agent / 时间 / 有审批 / 正在跑） |
| `/s/:id` | 主战场：左栏会话列表（可折叠）、中栏时间线 + composer、右栏检查器（工具详情 / diff / 文件 / 审批 / 用量） |
| `/s/:id/shell` | xterm 全屏，attach 真实 CLI |
| `/search` | FTS 全文，命中行可跳转到时间线对应 seq |
| `/settings` | agent 路径与可用性探测、allowedRoots、鉴权、索引重建 |

### 5.3 时间线（最关键的组件）

- 虚拟滚动，行高按 kind 分档；`tool_result` 默认折叠为一行摘要（"Bash · exit 0 · 12 行输出"）。
- 内联 diff 用统一色板；点击打开右栏完整 patch。
- 审批卡片就地插入时间线（阻塞态高亮），并同时冒到顶部提示条。
- 「正在跑」时在时间线尾部显示流式光标；滚动离开底部时出现「回到最新」胶囊。
- 每轮开头一条带轮次号的横线（是序列，所以编号在这里是**信息**而不是装饰）。

### 5.4 视觉方向（有主张的一套，不是默认模板）

主题叫 **「录音带」(tape)** —— 因为用户真正要看的是「agent 在仓库里按时间做了什么」，本质是一卷连续记录。

- **基底**：`#1B1F2A` 冷墨底 + `#E8E4DA` 暖白字；面板 `#222836`；分割线 `#2E3644`。不用纯黑，也不用米色纸。
- **身份色**（只用于每行的左侧 2px 竖轨，不做徽标色块）：Claude `#C4663F`、Codex `#2F7D74`、DSH `#5B6BC0`、Pi `#B08A3E`、Cursor `#8A5A7A`。
- **状态色**（全局仅一个）：运行中/待审批 `#E0663A`，其余一律中性。危险操作才允许 `#C0392B`。
- **字体**：UI 用 **IBM Plex Sans**（工程感、字重分明）；事件流正文与所有数字用 **IBM Plex Mono**（等宽在这里是内容属性：工具输出、时间戳、token 数）。字号阶梯 12/13/15/20/28，正文行高 1.55。
- **布局**：左 240px 固定栏 · 中间可读宽度上限 72ch 居左 · 右 360px 可折叠检查器。**零卡片、零阴影**，层级只靠 1px 线和高低两档底色；圆角只给输入框（2px）。
- **动效**：只有一处 —— 新一轮开始时时序表头出现一道 160ms 的从左到右的描线；流式光标闪烁。其余不做入场动画。
- 移动端：单列，左右栏变抽屉；审批用底部 sheet。

---

## 6. 安全

- **默认只听 `127.0.0.1`**，首次启动生成 token，写入 `~/.agentctl/config.yaml`；远程访问需显式 `--host 0.0.0.0` + 密码 + cookie session（HttpOnly/SameSite=Lax）。
- **路径白名单**：所有 fs 操作走 `allowedRoots`，`realpath` 后再校验前缀，拒绝 `..` 与符号链接逃逸。
- **不拼 shell**：spawn 一律 `argv[]`；只有 shell 模式的 PTY 是"用户自己的终端"，但也限制在 workspace cwd 内启动。
- **不读凭证**：`~/.claude/settings.json`、`~/.codex/auth.json`、`~/.pi/agent/auth.json`、`~/.dsh/.credentials.yaml` 只检查存在性，不解析内容、不外传。
- **危险动作二次确认**：删除/归档会话（Codex 有真 `delete`/`archive`）、中断运行、执行 shell 命令。
- 所有 agent 输出按纯文本渲染，Markdown 只走白名单（禁 raw HTML）。

---

## 7. 里程碑

| 阶段 | 内容 | 验收标准 | 估时 |
|---|---|---|---|
| **M0** 骨架 | monorepo、core 事件模型、adapter-claude 的 `discover`+`replay`、会话看板 + 只读时间线 | 能看到本机 15 个 Claude 会话，175MB 那个能秒开并滚到底 | 1.5 天 |
| **M1** Claude 闭环 | stream-json 实时跑、审批桥、composer、断点续跑、Shell 模式(node-pty) | 网页里发消息 → 工具调用可见可批准 → 退出后在终端 `claude --resume` 能接上同一会话 | 2 天 |
| **M2** Codex | `codex app-server` RPC 接入 + rollout 回放 + 标题来自 session_index | 同 M1 的体验，且 `codex agents` 与网页状态一致 | 2 天 |
| **M3** DSH | zstd 增量解压索引 + `--profile sdk` RPC + 审批 | 30 个历史会话可读，能新建/续接 | 2 天 |
| **M4** 打磨 | 全文搜索、diff 内联、用量统计、注解（置顶/标签）、移动端、Pi/Cursor 适配器 | 端到端可用；新增 agent 只需实现一个 adapter 包 | 3 天 |

**总估时 ≈ 10.5 天**（单人、熟悉本机环境的前提下）。M0+M1 出来就是「能天天用的最小闭环」，之后每个 agent 是独立可交付切片。

---

## 8. 风险与取舍

| 风险 | 影响 | 应对 |
|---|---|---|
| 5 个 agent 的格式随版本变 | 解析器随时失效 | 每个 adapter 带 **fixture 快照测试**（把真实会话脱敏后截取前 200 行入库），CI 跑；解析失败降级为「原文视图」而不是白屏 |
| 超大文件（175MB/13KB 一行） | 卡死/内存爆 | 尾部优先读 + 行级流式 + 媒体外置；单行 >256KB 直接截断 |
| headless 模式功能少于 TUI | 用户体验割裂 | 每个会话都能一键切 Shell 模式；能力差异在 UI 上显式标注（灰色不可点 + tooltip） |
| Codex app-server 是 experimental | 接口会变 | 用 `codex app-server generate-json-schema` 生成类型，锁版本区间；回退到 `exec --json` |
| DSH 是 rc 版本、格式 v4 | 可能不兼容 | 版本探测 + 未知行 `type` 直接透传为 `notice` |
| 安全暴露 | 别人能跑你的 agent | 默认 loopback + token；远程必须显式开且带密码 |

**明确不做的事**：不做云托管多租户、不做模型代理/计费、不重写 agent 的推理循环、不试图把 5 个 agent 的 prompt 系统统一。

---

## 9. 与 CloudCLI 的差异（为什么值得自己做）

| 维度 | CloudCLI | agentctl |
|---|---|---|
| 许可 | AGPL-3 | MIT |
| 扩展方式 | 插件系统（manifest + 前端 API + 后端 server） | 适配器包（一个 `AgentAdapter` 实现即接入） |
| 会话真相 | 自己的 DB + CLI 状态 | 纯磁盘文件，DB 只是索引，可删库重建 |
| 运行协议 | 主要靠 stream-json / PTY | 优先用各家原生 RPC（codex app-server / dsh sdk / ACP），stream-json 兜底 |
| 大文件 | 未针对性处理 | 尾部优先 + 断点续读 + 媒体外置（针对本机 422MB 场景） |
| 形态 | 云端容器 + 自托管 UI | 本地单进程，无容器 |

---

## 10. 需要你拍板的两件事

1. **建设路径**：`A` 自建薄内核（本方案，~10.5 天，可控可扩）／`B` 直接 fork CloudCLI 改（~3 天能跑，但被 AGPL 和它的架构绑住）。
   → 我的建议：**A**。你已经有 5 个 agent 的诉求，插件化的适配器比它的插件系统更合适。
2. **使用场景**：仅本机自用（架构最简）／还要手机和远程机器访问（要加密码、HTTPS、可能反代）。
   → 我的建议：**先按本机自用做，但把 host/密码留成配置项**，M4 再开远程。

确认后我直接从 M0 开始：monorepo 骨架 + Claude 只读回放，先把那 422MB 历史会话在浏览器里跑通。

---

## 11. 实施进度（M0 已完成）

M0 的验收标准是「能看到本机 15 个 Claude 会话，175MB 那个能秒开并滚到底」，已实测通过：

| 指标 | 实测 |
|---|---|
| 发现 15 个会话（11 个项目） | 32ms（只读每个文件头 64KB + 尾 96KB） |
| 174.4MB 会话首屏 | 71 条事件 / 20ms，向前翻页 80 条 / 20ms |
| 全量扫描补全（轮数、花费、预览） | 495ms（流式，内存恒定） |
| 服务端列表接口（15 个会话，含索引缓存） | 一次全量扫描后按 size+mtime 复用 |
| 前端产物 | JS 245.7kB（gzip 77.3kB）、CSS 16.0kB（gzip 4.0kB） |

已完成的范围比原计划多两项（都源自「要手机/远程访问」）：

- **远程访问**：`passwd` 设密码（scrypt）、cookie 票据（HttpOnly/SameSite=Lax，30 天）、登录限速、非回环地址无密码拒绝启动、可选 TLS 证书。已实测：未登录 `/api/sessions` 返回 401，错误密码 401，登录后 200。
- **移动端**：390×844 下侧脊折成顶部横条，时间线单列，Markdown/代码块/用量行均正常。

M0 未做（留给 M1）：stream-json 实时运行、审批桥、composer、Shell 模式。

代码落位：

```
packages/core              事件模型 / 字节窗口读行 / 文本裁剪 / AgentAdapter
packages/adapter-claude    discover + replay + refine（跳过 >8KB 行）
apps/server                Fastify + node:sqlite 索引 + 扫描缓存 + REST
apps/web                   React 19 + Vite 7，看板 / 时间线 / 设置 / 登录
docs/screens               各页截图
```

---

## 12. 实施进度（M1 主体已完成）

验收标准「网页里发消息 → 工具调用可见可批准 → 退出后在终端 `claude --resume` 能接上同一会话」已实测通过（haiku，单次 < $0.003）：

| 场景 | 实测 |
|---|---|
| 网页新建会话 → 拿到 sessionId 跳转 | ≈1s |
| 审批卡出现 → 点允许 → 工具执行 | 审批往返 < 0.3s |
| 同一进程连续两轮 | 轮号 1、2 与磁盘 `turnPosition` 一致 |
| 进程结束后再发消息 | 自动 `--resume`，轮号接到 3 |
| 打断 | 267ms 回到待命，进程保留 |
| 运行中刷新页面 | 磁盘回放 + SSE 回放按 uuid 合并，无重复；审批卡留在原位 |
| 手机 390×844 | composer、审批卡、状态标记正常 |

关键实现取舍：

- **SSE 而不是 WebSocket**：下行事件流 + 上行普通 POST，零新增依赖，自动重连，反代友好。
- **审批协议**：`--permission-prompt-tool stdio`，即官方 Agent SDK 的 `control_request(can_use_tool)` / `control_response`。「本会话内都允许」把 CLI 给的规则建议统一降级为 `destination: session`，绝不写 settings 文件。
- **去重**：stream-json 输出的 user/assistant 行与 jsonl 同构且 `uuid` 一致；`--replay-user-messages` 让我们发的提问也带 uuid 回显。只存在于实时流的事件（审批卡、本轮耗时）标 `transient`，合并时锚定到前一个已落盘事件之后。
- **安全**：工作目录 realpath 后过 `allowedRoots`；model 走白名单正则（不能以 `-` 开头冒充参数）；写接口同源校验 `Origin`；网页端不提供 `bypassPermissions`。

M1 剩余：partial 输出在打断时的保留。

---

## 13. 0.2.0：M1 收尾 + 第一个可部署版本

| 项 | 实现 |
|---|---|
| 权限模式 | 新增 Auto 模式与 bypassPermissions。进程总带 `--allow-dangerously-skip-permissions` 启动（只是"允许切过去"，默认仍逐个审批），运行中用 `set_permission_mode` 切换；`allowBypassPermissions: false` 可整体禁用 |
| AskUserQuestion | 审批卡变问答表单；回答以 `updatedInput.answers = {问题: 答案}` 回给 CLI（多选用 `, ` 连接，可自填） |
| 模型 | 列表来自 CLI 的 `initialize` 握手；`--effort` 推理强度；运行中 `set_model` |
| 自动刷新 | 会话页 2 秒一次 `events?after=<字节游标>` 增量追尾，终端里跑的会话也实时可见 |
| Shell 模式 | node-pty + xterm.js（懒加载）+ WebSocket。默认 `claude --resume <会话>` 真 TUI，也可开普通 shell；终端在服务端常驻，断线重连回放最近 256KB 输出；与网页进程互斥，避免两个进程写同一会话；WebSocket 同源校验 |
| 部署 | `pnpm service:install` → systemd 用户服务；`CHANGELOG.md` |

---

## 14. 0.3.0：M2 Codex

| 项 | 实测 |
|---|---|
| 发现 9 个会话（含 2 个 Guardian 子代理） | 26ms |
| 4.2MB 会话首屏 | 309 条事件 / 43ms，uid 全部唯一 |
| 实时：提问 → 命令审批 → 执行 → 同进程第二轮 | 实时事件 100% 在磁盘回放里找到同 uid，轮次一致 |
| 运行中切到跳过所有权限 | 下一轮不再弹审批 |
| 刷新页面 | 无重复，审批卡在原位 |

取舍：

- **新版格式只认 item_completed**：response_item 里新版是 JS 编排代码（`exec` 自定义工具），对人不可读；item_completed 才是真实执行的命令与 diff。
- **用量与本轮耗时不从实时流发**：文件里有 `token_usage_record` / `task_complete`，2 秒轮询就能追上，实时也发会在刷新前重复计数。
- **模型 / 权限按轮生效**：app-server 没有"改线程设置"的接口，但 `turn/start` 接受 `model`、`approvalPolicy`、`sandboxPolicy` 覆盖，切换后从下一轮起生效。
- **本机 bubblewrap 不可用**：Codex 的 workspace-write 沙箱在这台机器上建不了 user namespace，部分命令会在沙箱里失败后转为请求授权。这是 Codex 自身与宿主环境的问题，TUI 里一样。

下一步：M3 DSH（zstd 增量解压 + `--profile sdk`）。
