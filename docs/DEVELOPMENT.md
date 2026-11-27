# 开发与发版指南

## 目录结构

```text
.
├── .github/            # CI、自动 Release 工作流与 Issue/PR 模板
├── docs/               # 文档与 README 配图
├── extension/          # 可直接加载到 Chrome / Edge 的 Manifest V3 扩展源码
│   ├── lib/            # 核心模块（同步播放器、课程目录、观看进度、字幕、后台控制器）
│   └── vendor/         # 第三方依赖（Artplayer 5.4.0，MIT）
├── scripts/            # 校验、本地预览、版本号同步、打包与 Release Notes 生成脚本
└── tests/              # 基于 Node 内置 test runner 与 jsdom 的单元测试
```

## 本地开发

需要 Node.js 20 及以上版本：

```sh
npm ci --ignore-scripts
npm run check      # 校验 manifest、权限边界、资源引用与 JS 语法
npm test           # 运行全部单元测试
npm run preview    # 使用内置 mock 数据预览弹窗与同步播放器页面
npm run build      # 生成精简版扩展 ZIP 安装包与 SHA-256 校验值
```

在浏览器调试时，打开 `chrome://extensions/`（或 `edge://extensions/`），开启开发者模式后直接加载仓库中的 `extension/` 目录；每次修改后点击扩展卡片的「重新加载」即可生效。

## 发布新版本

1. 使用内置脚本同步更新 `package.json`、`package-lock.json` 与 `extension/manifest.json` 的版本号：
   ```sh
   npm run version:bump -- 0.6.0
   # 也支持按语义化快捷递增：patch / minor / major
   npm run version:bump -- patch
   ```
2. 运行 `npm run check && npm test && npm run build` 确认全部通过。
3. 提交并合入 `main` 分支后，`.github/workflows/release.yml` 会自动创建 tag、按提交分类生成中文更新说明，并发布包含 `xdzk-recorder-<版本号>.zip`、`xdzk-recorder-latest.zip` 与 `.sha256` 附件的 GitHub Release。
