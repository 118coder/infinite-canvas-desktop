<p align="center">
  <img src="web/public/logo.svg" width="88" alt="无限画布 logo">
</p>

<h1 align="center">无限画布</h1>

<p align="center">
  <sub>在无限画布上编排图片、视频与音频，把 AI 生成变成可以反复迭代的视觉工作台</sub>
</p>

<p align="center">
  <a href="VERSION"><img src="https://img.shields.io/badge/version-v0.8.3-2563eb?style=flat-square" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-f97316?style=flat-square" alt="License"></a>
</p>

---

## 这是什么

无限画布是一个本地优先的 AI 视觉创作工作台。画布、素材、生成记录和图片本体都保存在你自己的电脑上，不需要注册账号。你可以在自由画布上摆放图片、视频、音频和文本节点，用连线表达"谁是谁的参考"，然后在一个节点上反复生成、局部修改、比较结果。

## 核心能力

| 能力 | 说明 |
| --- | --- |
| 无限画布 | 拖拽平移、多选、打组、对齐吸附、连线自动整理、撤销重做；连线即参考关系 |
| 图片生成 | 文生图、图生图、参考图编辑、批量出图、多角度、局部重绘、裁剪、切图、超分放大 |
| 视频生成 | 首尾帧、参考视频、多镜头、镜头参数面板，支持工作流渠道（ComfyUI / AutoDL 等） |
| 音频生成 | TTS 配音、音色与语速设置、参考音频 |
| 全景图 | 全景节点与 3D 预览，支持续画与方向调整 |
| 3D 导演台 | 时间轴 + 摄像机机位，用来摆构图和运镜，再把机位画面输出成参考图 |
| 对话助手 | Agent 按选中节点和上游节点分析、规划，直接在画布上改提示词、加节点、批量生成 |
| 摄像机控制 | 图片 / 视频 / 配置节点可独立设置相机、镜头、焦距、光圈，自动写进提示词 |
| 提示词库 | 保存常用提示词，支持 `@` 引用画布上的图片与文本节点 |
| 我的素材 | 生成结果一键存素材，可分类、打标签，随时拖回画布复用 |
| 数据工程 | 一键打包/迁移全部画布、素材、配置与图片，支持只含清单的轻量"引用包" |
| 模型渠道 | 本地渠道（OpenAI 兼容接口）、自定义工作流、自有 S3 / WebDAV 存储 |

## 桌面版（推荐）

Windows 单文件版本，前端、后端、静态资源全部内嵌在一个 exe 里，双击即用，不需要装 Node、Go 或数据库。

1. 从仓库 Releases 的 `desktop-latest` 下载 `infinite-canvas-desktop.exe`；
2. 放到一个**有写权限**的目录（不要放 `C:\Program Files`），双击运行；
3. 首次启动会生成同级的 `userdata/` 目录，画布数据、图片本体、网页缓存都存在这里，不再占用 C 盘。

运行时会在 `127.0.0.1` 上起一个本地服务，默认端口 `36512`，并把端口记在 `desktop-port.txt` 里。**端口就是本地数据的身份**，每次启动会尽量复用同一个端口，请不要随手改动。需要强制指定端口时，设置环境变量 `CANVAS_DESKTOP_PORT`。

## 首次使用

1. 点右上角齿轮「设置」，在「渠道模式」里填一个可用的模型渠道（Base URL + API Key），或选择一个已有的自定义工作流渠道；
2. 回到画布列表，新建一个画布；
3. 把图片直接拖进画布，或双击空白处新建节点，或用左下角工具栏添加文本 / 图片节点；
4. 选中节点，在下方提示词框输入内容，回车或点右下角生成；
5. 想把某张图当参考：把节点连到目标节点上，或从目标节点的「参考内容」里点「+」选择；
6. 结果不满意时直接改提示词再点生成——**同一个节点会被重新生成**；想保留旧结果请先「创造副本」（`Ctrl / Cmd + D`）。

## 从源码运行

需要 Go 1.25+、Bun、Node 20+。

```bash
# 后端（仓库根目录）
go run .

# 前端（另开一个终端）
cd web
bun install
bun run dev        # http://localhost:3000
```

打包桌面版（静态导出后由 Go 内嵌成单文件 exe）：

```bash
cd web && BUILD_DESKTOP=1 bunx next build && cd ..
rm -rf desktop/dist && cp -r web/out desktop/dist
go build -o infinite-canvas-desktop.exe ./desktop
```

仓库已配置 GitHub Actions：推送到 `main` 会自动构建 `infinite-canvas-desktop.exe` 并更新到 `desktop-latest` 发布页，本地不装 Go 也能拿到可执行文件。

## 数据工程：换电脑不丢图

设置 → 数据工程，导出有两种模式：

- **完整包**：所有图片本体都打进压缩包，体积大，换台电脑导入即可接着用；
- **引用包**：只导出画布 JSON 和每张图片的 `storageKey / MD5 / 文件名` 清单，体积几百 KB，适合自己同步画布结构。

导入引用包时，软件会逐个检查图片在本机是否已存在：已有的直接用，缺失的列在「缺失图片补齐」里，点「选择文件」或「批量定位文件」把图片找回来（按 MD5、文件名、大小自动匹配）。补齐后画布会自动恢复。

## 数据都存在哪

| 内容 | 位置 |
| --- | --- |
| 画布项目、节点、图片 blob、网页缓存 | 桌面版：exe 同级 `userdata/`；浏览器版：浏览器 IndexedDB |
| 模型渠道与偏好配置 | 本地存储 `infinite-canvas:ai_config_store` |
| 桌面版服务端口 | exe 同级 `desktop-port.txt` |
| 后端数据（启用服务端能力时） | exe 同级 `data/` |

从旧版本升级时，`%AppData%\<exe 名>` 下的旧数据会自动迁移到 `userdata/`；迁移失败会保留旧目录继续使用，不会丢数据。

## 常见问题

**画布是空白 / 图片显示"图片缺失"**
多数是本地图片 blob 丢了。先确认没有清理过 `userdata/`；如果是导入的引用包，去设置里补齐缺失图片。

**重启后画布列表空了**
几乎都是端口变了（本地数据的身份随端口变化）。检查 `desktop-port.txt` 是否被删，或被别的程序抢占了端口，换回原端口再启动。

**C 盘还是被占满**
老版本把数据写在 `%AppData%`，新版已迁到 exe 同级 `userdata/`。确认 `userdata/` 已生成后，可手动删除旧目录 `C:\Users\<你>\AppData\Roaming\infinite-canvas-desktop.exe`。

**生成报错 / 401**
检查设置里的渠道 Base URL 与 Key；自定义工作流渠道还需要对应的 ComfyUI / AutoDL 服务在线。

## 目录结构

```
├─ web/                        前端（Next.js App Router + React + Zustand + Tailwind）
│  └─ src/app/(user)/canvas/   画布编辑器（节点、连线、面板、Agent）
├─ desktop/                    桌面壳（Go + WebView2，内嵌静态导出产物）
├─ handler/ service/ repository/ model/   后端（Go + Gin + GORM）
├─ canvas-agent/               ComfyUI Bridge 等本地能力
└─ docs/                       功能、进度与排查文档
```

## 许可证

AGPL-3.0，详见 [LICENSE](LICENSE)。
