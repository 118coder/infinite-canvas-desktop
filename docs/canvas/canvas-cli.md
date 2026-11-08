# canvas-cli：AI 自动生图 / 审稿命令行

`canvas-cli` 是随桌面版一起发布的独立命令行工具，专供 AI agent（ZCode、Claude Code、Codex 等）在终端直接调用，自动完成「生图 → 审稿 → 改稿」循环。它自带渠道配置，**不依赖画布界面运行，也不读写画布数据，对主模式零影响**。

- API Key 保存在本机 `~/.infinite-canvas/canvas-cli.json`（权限 0600），只在本机使用。
- 生图走 OpenAI 兼容接口（`/v1/images/generations`、`/v1/images/edits`）或 Gemini 原生接口（`/v1beta/models/{model}:generateContent`），直连上游。
- 所有命令输出 JSON（成功 `{"ok":true,...}`，失败 `{"ok":false,"error":"..."}` 且退出码 1），方便 AI 解析。

## 获取与构建

- 云端构建：`desktop-latest` 滚动发行页下载 `canvas-cli.exe`，或解压正式版 zip 取同目录 `canvas-cli.exe`。
- 本地构建：仓库根目录执行 `go build -o canvas-cli.exe ./cmd/canvas-cli`。

## 配置

```sh
# OpenAI 兼容渠道（中转站等）
canvas-cli config set --protocol openai --base-url https://你的中转站.com --api-key sk-xxx --image-model gpt-image-2

# Gemini 原生渠道
canvas-cli config set --protocol gemini --base-url https://generativelanguage.googleapis.com --api-key AIzaxxx --image-model gemini-2.5-flash-image

# 可选：自动审稿模型（需支持视觉）、默认尺寸质量、超时
canvas-cli config set --review-model gpt-5.5 --size 1:1 --quality auto --timeout 600
canvas-cli config show   # 查看当前配置，API Key 自动打码
```

- 环境变量 `CANVAS_CLI_BASE_URL`、`CANVAS_CLI_API_KEY` 可临时覆盖配置（优先级高于配置文件）。
- `--size` 支持 `1:1`、`16:9` 等比例（自动按质量折算成 16 倍数像素）或 `1024x1024` 精确尺寸；`auto` 表示不传。
- 自动审稿接口固定走 OpenAI 兼容 `/v1/chat/completions`，默认用 `base-url` + `api-key`；不同地址时用 `--review-base-url` / `--review-api-key`。Gemini 渠道审稿可把 `--review-base-url` 设为 `https://generativelanguage.googleapis.com/v1beta/openai`。

## 命令

### generate：生图

```sh
canvas-cli generate --prompt "一只穿宇航服的橘猫" --n 4 --size 16:9 --out ./shots --prefix cat
canvas-cli generate --prompt "把背景换成雪山" --ref ./shots/cat-20261107-101500-1.png   # 带参考图 = 图生图
```

- 带参考图时走图生图：openai 协议用 `/v1/images/edits`，gemini 协议把参考图放 `inlineData`。
- 输出目录默认 `./canvas-cli-output`，文件名 `[prefix-]时间戳-序号.png`（按图片真实格式定扩展名）。
- 输出 JSON：`{"ok":true,"dir":"...","images":[{"id","file","prompt","model","size","quality","protocol","createdAt","review":null}]}`。

### list：查看产物清单

```sh
canvas-cli list --out ./shots --status pending   # pending | approved | rejected | 留空全部
```

### review：记录人工/AI 审稿结论

```sh
canvas-cli review --file cat-20261107-101500-1.png --status rejected --score 4 --note "猫有六条腿，重画" --out ./shots
```

### auto-review：调视觉模型自动审稿

```sh
canvas-cli auto-review --out ./shots --min-score 7 --limit 10 --extra "画面必须留出右侧文字排版空间"
```

- 只处理清单中尚未审稿（pending）的图片，逐张发给 `--review-model`，按 `--min-score` 评分线（或模型 verdict）判定通过/打回，结论写回清单。
- 输出 JSON：`{"ok":true,"reviewed":10,"approved":3,"rejected":7,"results":[{"file","status","score","note"}]}`。

## manifest.json

产物目录中的 `manifest.json` 是全部生图与审稿记录：

```json
{
  "images": [
    {
      "id": "a1b2c3d4",
      "file": "cat-20261107-101500-1.png",
      "prompt": "…",
      "model": "gpt-image-2",
      "size": "1024x1024",
      "quality": "high",
      "protocol": "openai",
      "createdAt": "2026-11-07T10:15:00+08:00",
      "review": { "status": "approved", "score": 8, "note": "…", "reviewer": "auto", "reviewedAt": "…" }
    }
  ]
}
```

## 推荐的 AI 自动生图-审稿循环

1. `canvas-cli generate --prompt "…" --n 4 --out ./任务目录`，从输出 JSON 拿到文件路径。
2. 逐张查看图片（agent 自己的视觉能力），判断是否符合要求。
3. 通过的执行 `canvas-cli review --file x.png --status approved --note "…"`；不合格的 `--status rejected` 并写明问题。
4. 对打回的图改 prompt 重新 `generate`，或把最接近的通过图作为 `--ref` 走图生图微调。
5. 批量任务可用 `canvas-cli auto-review --min-score 7` 先自动筛一轮，再人工/agent 复核低分图。
6. `canvas-cli list --status approved --out ./任务目录` 取最终通过清单。
