# MyRecitationWebpage

艺术学概论背诵网页，使用 React + Vite 构建。

## 本地运行

```bash
npm install
npm run dev
```

打开 Vite 提示的本地地址，例如 `http://127.0.0.1:5173/`。

如需启用 Supabase 云端保存，请复制 `.env.example` 为 `.env.local`，并填入：

```bash
VITE_SUPABASE_URL=你的 Supabase Project URL
VITE_SUPABASE_ANON_KEY=你的 Supabase anon/publishable key
```

## 构建

```bash
npm run build
```

构建结果会生成在 `dist/`。

## GitHub Pages 部署

推荐提交源码到 GitHub，然后用 GitHub Actions 或 Vite 支持的部署流程构建 `dist/`。

如果启用云端保存，需要在 GitHub 仓库中配置 Actions 变量：

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

位置：GitHub 仓库 `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`。

Supabase 中需要先创建：

- `recitation_content` 表：保存网页内容 JSON
- `allowed_editors` 表：保存允许编辑的邮箱
- 开启 RLS，并设置：所有人可读取内容，只有授权邮箱可更新内容

部署后：

- 普通访问者只读背诵
- 授权邮箱登录后可以编辑
- 点击“云端保存”永久写入 Supabase

需要提交：
- `src/`
- `public/`
- `index.html`
- `package.json`
- `package-lock.json`
- `vite.config.js`
- `第一章-艺术的本质和特征.md`
- `第二章-艺术的起源.md`
- `第三章-艺术的功能与艺术教育.md`
- `更新日志.md`
- `.gitignore`
- `README.md`
- `.env.example`

不要提交：
- `node_modules/`
- `dist/`，除非你选择手动上传构建结果
- PDF 参考资料
- 旧的 `艺术学概论背诵.html`
