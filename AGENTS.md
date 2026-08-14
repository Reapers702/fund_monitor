# 识图能力（Vision）

本项目的底层模型可能不具备原生识图能力。遇到图片时，**不要用 Read 工具读图**，改用内置的 `scripts/vision/vision.js`：它会把图片转成 base64 发给视觉模型 API，返回文字描述。

## 触发场景

- 用户分享图片路径（本地文件或网络 URL）
- 消息中出现 "Saved attachments:" 并列出图片
- 用户要求分析、描述、识别图片内容
- 用户粘贴了图片但看不到路径/URL

## 用法

从项目根目录执行：

| 输入 | 命令 |
|---|---|
| 本地图片 | `node scripts/vision/vision.js "<图片绝对路径>" "用中文描述这张图片"` |
| 网络图片 | `node scripts/vision/vision.js --url "<图片URL>" "用中文描述这张图片"` |
| 剪贴板图片 | `node scripts/vision/vision.js --clipboard "用中文描述这张图片"` |

回退规则（自动）：

- 本地路径不存在、或没提供任何路径/URL 时，`vision.js` 自动尝试读取系统剪贴板。
- 加 `--no-fallback` 可关闭自动回退，改为明确报错。

## 配置

凭证来自项目根 `.env`：`DASHSCOPE_API_KEY`、`VISION_MODEL`、`DASHSCOPE_BASE_URL`（非阿里云百炼才需要改 BASE_URL）。当前模型为 `qwen3.7-max-2026-06-08`（识图效果较好）。

## 规则

- 始终使用绝对路径调用 `vision.js`（工作目录不在项目根时尤其如此）。
- 描述默认用中文，除非用户要求其他语言。
- 绝不打印、分享或提交 API Key（`.env` 已在 .gitignore）。
- API 调用失败时，把错误反馈给用户，并提示检查 Key / 模型名 / BASE_URL。
