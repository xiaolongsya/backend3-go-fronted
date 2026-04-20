# backend3-go-fronted（Vue3 前端演示）

一个极简的 Vue3 聊天页面，用于展示后端（OpenAI 风格）能力：模型列表、Chat Completions（流式/非流式）。

## 功能

- 聊天界面：输入消息并发送
- 模型选择：右上角按钮弹出模型列表（调用 `GET /v1/models`）
- 流式/非流式切换：输入框左侧按钮切换；流式支持 SSE 增量渲染
- think 展示：将模型返回的 `<think>...</think>` 内容以单独样式块展示（不显示原始标签）

## 接口与鉴权

- 后端示例：`http://xiaolongya.cn:8091`
- 请求 Header：`Authorization: Bearer <token>`

默认 token：`xiaolong`（可通过环境变量覆盖）。

## 本地运行

```bash
npm install
npm run dev
```

开发模式默认使用 Vite 代理避免 CORS：前端请求 `/v1/...` 会被代理到 `http://xiaolongya.cn:8091`。

## 打包

```bash
npm run build
npm run preview
```

> 说明：生产环境如果前端与后端不同源，浏览器会遇到 CORS。
> 推荐做法是让前端通过同域反向代理转发到后端，或在构建时配置 `VITE_API_BASE_URL`。

## 环境变量

复制 `.env.example` 为 `.env` 并按需修改：

- `VITE_API_TOKEN`：Bearer token（不含 `Bearer ` 前缀）
- `VITE_API_BASE_URL`：可选。生产环境下指定完整后端地址（例如 `http://xiaolongya.cn:8091`）
  - 留空时：默认使用相对路径（开发时走 Vite proxy）。

> 注意：`.env*` 已被 `.gitignore` 忽略，避免误提交 token。
