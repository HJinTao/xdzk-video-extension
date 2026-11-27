# 西电智课 · 录播助手

[![CI](https://github.com/Pais1ey/xdzk-video-extension/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Pais1ey/xdzk-video-extension/actions/workflows/ci.yml)
[![Release](https://github.com/Pais1ey/xdzk-video-extension/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/Pais1ey/xdzk-video-extension/actions/workflows/release.yml)

[最新 Release](https://github.com/Pais1ey/xdzk-video-extension/releases/latest) · [Chrome / Edge 114+](#安装与配置指南) · [MIT License](LICENSE) · [开发与发版指南](docs/DEVELOPMENT.md)

在电脑上看西电智课回放时，可以让课件和教室画面双路同步播放、直接切换同一门课的全部课次并自动连播、记录每节课的观看进度、按字幕关键词跳转原句，也可将需要的画面保存为 MP4。适用于 Chrome 和 Microsoft Edge 114 及以上版本。

| 想做什么 | 从哪里开始 |
| --- | --- |
| 同时看课件和教室，选择听哪一路、支持快捷键无暂停快进 | 扩展面板 → [双路同步看课](#双路同步看课) |
| 在播放器内连续看同一门课、标记已看进度、自动连播下一节 | 同步播放器右上角 → [同课程目录与连续播放](#同课程目录与连续播放) |
| 按关键词找讲解，点击字幕回到课堂原句 | 同步播放器右上角 → [字幕复习](#字幕复习) |
| 预览画面，保存一路或两路原片 | 扩展面板 → [下载所选画面](#下载录播) |

## 安装与配置指南

### 方式一：下载 ZIP 安装包（推荐，Chrome / Edge 通用）

1. **下载最新版安装包**：
   - 直接下载：[下载最新版 ZIP 安装包（xdzk-recorder-latest.zip）](https://github.com/Pais1ey/xdzk-video-extension/releases/latest/download/xdzk-recorder-latest.zip)
   - 或前往发布页查看更新日志与 SHA-256 校验值：[最新 Release 发布页](https://github.com/Pais1ey/xdzk-video-extension/releases/latest)
2. **解压到固定目录**：将 ZIP 完整解压到一个打算长期保留的文件夹（例如 `Documents/xdzk-recorder/`，不要直接放在临时目录或解压后删除，浏览器后续启动都会从这里读取扩展）。解压后确认目录结构如下：
   ```text
   xdzk-recorder/
   ├── manifest.json    ← 必须能直接看到这个文件
   ├── background.js
   ├── player.html
   ├── popup.html
   └── ...
   ```
3. **开启浏览器开发者模式**：
   - Chrome：在地址栏输入 `chrome://extensions/` 并按回车，打开右上角 **开发者模式**。
   - Edge：在地址栏输入 `edge://extensions/` 并按回车，打开左侧（或上方）**开发人员模式**。[Edge 官方安装图解](https://learn.microsoft.com/zh-cn/microsoft-edge/extensions/getting-started/extension-sideloading)
4. **加载扩展**：点击 **加载已解压的扩展程序**（Load unpacked），选中第 2 步中**直接包含 `manifest.json` 的文件夹**。扩展列表出现 **西电智课 · 录播助手** 即安装成功。
5. **固定到工具栏（建议）**：点击浏览器地址栏右侧的拼图图标（扩展程序菜单），点击 **西电智课 · 录播助手** 右侧的图钉图标将其固定在工具栏，随后刷新已打开的课程回放页即可使用。

> [!TIP]
> 如果你下载的是 GitHub 自动生成的 **Source code (zip)** 或直接 `git clone` 了本仓库，请在「加载已解压的扩展程序」时选择仓库内的 **`extension/`** 子文件夹。

### 从旧版本升级

1. 下载最新的 [ZIP 安装包](https://github.com/Pais1ey/xdzk-video-extension/releases/latest/download/xdzk-recorder-latest.zip) 并解压，将里面的文件**覆盖**到之前加载的扩展目录（若直接加载源码仓库的 `extension/`，执行 `git pull` 即可）。
2. 打开 `chrome://extensions/` 或 `edge://extensions/`，在 **西电智课 · 录播助手** 卡片上点击 **重新加载**（圆形箭头图标），确认版本号已更新。
3. 关闭之前打开的同步播放器标签页，刷新学校的课程回放页，再从扩展面板打开 **同步看课**。已保存的观看进度和已看标记会保留在浏览器本地，不会丢失。

### 可选：使用 CRX 安装（Linux / 组织策略部署）

若[最新 Release 页面](https://github.com/Pais1ey/xdzk-video-extension/releases/latest)提供了签名 `.crx` 文件，Linux 桌面 Chrome 用户可开启 `chrome://extensions/` 的开发者模式后将其拖入页面安装；Windows / macOS 个人用户推荐使用上方的 ZIP 解压安装方式，组织管理的浏览器可由管理员通过策略部署。[Chrome 官方分发说明](https://developer.chrome.com/docs/extensions/how-to/distribute)

## 进入课程回放

1. 打开西电智课，使用学校统一身份认证登录，进入**个人空间**。[西电智课平台](https://xdspoc.xidian.edu.cn/)
2. 在左侧点击**应用中心**，在**学在西电**栏目选择**录直播应用（学生）**。下图红框标出了这两个入口。
3. 打开课程，在目录中找到要看的课次，点击**观看回放**。在回放页点击浏览器工具栏里的扩展图标，即可看到已识别的画面列表以及同课程学习进度。如果列表为空，先在原页面播放几秒，再点**重新识别**。

![西电智课个人空间，左侧的应用中心和学在西电栏目中的录直播应用（学生）均用红框标出](docs/images/replay-entry.png)

## 双路同步看课

识别到两路画面后，在扩展面板点击**同步看课**。播放器会在新标签页直接播放学校的录播，无需先下载视频。

![同步播放器左侧放大课件，右侧显示教室画面，下方用同一条进度条控制两路视频，可以选择一路声音](docs/images/synced-playback.png)

| 操作 | 播放效果 |
| --- | --- |
| 点击**播放/暂停**或按 **Space（空格）** | 同时控制课件和教室画面（不拦截搜索框等输入框输入） |
| 拖动进度条，点击 **−10 秒** / **+10 秒**，按 **←** / **→**（±5 秒）或 **Shift + ← / →**（±10 秒），以及全屏快进 | 两路同步跳到新位置。播放中快进即使跳到未缓冲区间也不会变成暂停态，缓冲完成后自动续播；全屏看主画面时副画面缓冲不打断主画面；手动暂停后快进则保持暂停 |
| 按 **↑** / **↓** | 调节当前声音通道音量（每次 ±10%） |
| 点击**交换主副画面** | 对调两路画面的大小，保留当前进度和声音选择 |
| 在**声音**中选择画面 1、画面 2 或静音 | 只听选中画面的声音，或同时静音 |
| 选择或输入**倍速** | 两路共用速度，支持 2.5×、3× 预设、±0.1× 微调及 0.25×–4× 自定义数值 |

如果课件与讲解有固定时差，展开底部的**视频源与时间校准**，调整**画面 2 时间偏移（秒）**。例如填入 `2`，画面 1 在 10:00 时，画面 2 会对齐到 10:02。两路可播放的范围取共同区间。

## 同课程目录与连续播放

从西电智课回放页进入同步播放器后，扩展会自动抓取同一门课程的全部课次，不再需要反复回到源网页切换课程：

- **无缝切课**：点击播放器右上角**课程目录**（或使用底部**上一节 / 下一节**按钮）即可直接切换课次，两路视频源与对应课次的字幕会在当前标签页内无缝替换。
- **自动连播**：底部控制栏默认开启**自动连播**。当前课次播放结束后会出现 5 秒倒计时提示，可点击**立即播放**提前切换，也可随时点击**取消**或关闭开关。
- **观看状态与续播记忆**：每节课的观看进度持久化保存在浏览器本地（`chrome.storage.local`），清晰区分三种状态：
  - **未看**：尚未观看的课次；
  - **在看**：显示上次看到的时间点与百分比进度条，再次打开或切回该课次时自动定位到上次位置；
  - **已看完**：观看进度达到 90% 或播放结束时自动标记，也可点击课次右侧的勾选图标手动切换「已看 / 未看」。
- **筛选与快速切换**：目录支持按「全部课次 / 未看完 / 已看完」筛选、点击**定位当前**快速滚回正在观看的课次；右侧抽屉顶部支持在**课程目录**与**字幕复习**之间一键切换。

## 字幕复习

打开同步播放器右上角的**字幕复习**（或在右侧抽屉顶部切换到**字幕复习**标签）。在**复习画面**中选择一路，输入关键词或时间（例如 `16:14`），点击匹配的字幕，两路画面就会一起跳到那句话。取消**跟随播放**可以停在列表中翻阅。

![字幕复习侧栏显示搜索框、带时间的字幕列表和跟随播放选项，16:14 的当前字幕已高亮](docs/images/subtitle-review.png)

- **显示课程字幕**：课程提供一份字幕时，两路共用；有独立字幕时，各自显示。通过课程目录切换到同课程其他课次后也会自动加载对应字幕。用**双路字幕**按钮可同时开关画面上的文字，侧栏仍可搜索。
- **导入本地字幕**：选择与字幕时间码对应的画面，点击**导入字幕**，选择 UTF-8 编码的 `.srt` 或 `.vtt` 文件。只导入一份时两路共用，也可为两路分别导入。

## 下载录播

1. 在扩展面板勾选需要的画面。想先确认哪一路是课件，可点画面右侧的 **⋯ → 预览画面**。菜单内也可修改保存名称、复制链接或单独下载。
2. 点击**下载所选画面**。勾选两路会分别得到两个 MP4，保留各自的原始音轨。播放器中的声音选择、播放倍速和导入的字幕只影响观看。
3. 默认保存到浏览器下载目录下的 `西电智课/课程名/`。勾选**每次选择保存位置**可自行指定目录。关闭扩展面板后下载会继续，点击**查看下载**可查看进度。

## 常见问题

| 遇到的情况 | 处理方法 |
| --- | --- |
| 加载时提示找不到清单文件（`manifest.json`） | 将 ZIP 完整解压后打开文件夹，选择**直接包含 `manifest.json` 的那一层**；若加载源码仓库请选择 `extension/` 子目录。 |
| 面板为空、只有一路，或仍显示上节课 | 刷新当前课次的回放页，分别点播放课件和教室画面，再打开扩展点击**重新识别**。 |
| 播放、切课或下载提示过期 / 403 | 在学校原回放页确认仍处于登录状态并刷新页面；扩展面板点击**重新识别**，或已打开的同步播放器在**视频源与时间校准**中点击**更新视频源**。 |
| 课程没有字幕 | 在**字幕复习**中导入手头的 SRT 或 VTT 文件即可按句跳转。 |
| 两个 MP4 文件名相同 | 两个机位各有独立编号。可在扩展面板预览，并将保存名称改成「课件」或「教室」。 |

## 适用范围与数据

扩展识别 `newes.chaoxing.com` 回放页面中来自 `kdlbptvideo.xidian.edu.cn` 的 MP4，并复用当前浏览器的西电智课登录态读取同课程目录与课程字幕。预览、在线播放和下载均直接连接学校服务，不经由任何第三方服务器。

- `activeTab`、`scripting`、`webRequest`：用于发现画面、读取课程目录与课程字幕；
- `downloads`：用于管理扩展发起的本地下载；
- `storage`：用于保存当前会话的视频源状态、本机下载偏好，以及每门课程的观看进度与已看标记。
- 网站权限严格限定在 `newes.chaoxing.com` 与 `kdlbptvideo.xidian.edu.cn`。

## 开发、验证与自动发布

在仓库根目录运行以下命令检查、测试、预览和打包扩展：

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
```

- `extension/` 是可直接加载到浏览器的扩展目录，内含 Artplayer 5.4.0 及其 MIT 许可证。
- `npm run build` 会在 `dist/` 生成 `xdzk-recorder-<版本号>.zip`、`xdzk-recorder-latest.zip` 与 `.sha256` 校验文件。
- `npm run preview` 可用示例数据在本机启动界面预览服务。

### 自动发布 GitHub Release

仓库已配置 [`.github/workflows/release.yml`](.github/workflows/release.yml) 与 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)：

1. 使用 `npm run version:bump -- <patch|minor|major|版本号>` 同步更新 `package.json`、`package-lock.json` 与 `extension/manifest.json` 的版本号，提交并合入 `main` 分支（也可直接推送匹配的 `v<版本号>` tag，或在 GitHub Actions 页面手动触发 `Release` 工作流）。详细目录结构与贡献说明见 [开发与发版指南](docs/DEVELOPMENT.md)。
2. GitHub Actions 会自动执行校验、单元测试与打包，按提交记录自动生成中文分类更新说明和 SHA-256 校验值，并发布包含 `xdzk-recorder-<版本号>.zip`、`xdzk-recorder-latest.zip` 与 `.sha256` 附件的 GitHub Release。
