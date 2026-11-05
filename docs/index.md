# 无限画布文档索引

## 项目介绍

- [快速开始](overview/quick-start.md)
- [功能介绍](overview/features.md)
- [Docker 部署](overview/docker.md)
- [第三方 GitHub 提示词仓库](overview/third-party-prompt-repositories.md)

## 操作手册

- [画布节点操作手册](canvas/canvas-node-manual.md)
- [画布快捷键](canvas/canvas-shortcuts.md)

## 开发文档

- [本地开发](backend/local-development.md)
- [接口响应约定](backend/api-response.md)
- [系统配置数据结构](backend/system-settings.md)
- [后端数据库说明](backend/backend-database.md)
- [画布数据结构](backend/canvas-data-structure.md)

## 开源协议

- [AGPL-3.0](business/license.md)

## 项目进度

- [待测试](progress/pending-test.md)
- [TODO](progress/todo.md)
- [交接：画布与素材优化批次 + 检查更新](progress/handoff-canvas-optimization.md)

## 说明

- 画布项目和「我的素材」全部保存在本地（桌面版为 exe 同级 `userdata/`，浏览器版为 IndexedDB），不依赖账号。
- AI API Key 保存在本地，由前端直接请求 OpenAI 兼容接口；桌面版不会上传任何数据。
