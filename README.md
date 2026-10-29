# 西电智课 · 录播下载

适用于 Chrome / Microsoft Edge 的 Manifest V3 扩展，识别西电智课回放页中的 MP4 视频，并交给浏览器保存。无需安装 Python、Node.js 或 FFmpeg 即可使用打包好的扩展。

## 安装

1. 打开 `chrome://extensions/`；Edge 打开 `edge://extensions/`。
2. 开启“开发者模式”，点击“加载已解压的扩展程序”。
3. 在本项目中选择 **`extension` 文件夹**，其中应直接包含 `manifest.json`。本地路径为 `D:\project\xdzk_video\extension`。
4. 如果使用 ZIP，先解压 `xdzk-recorder-0.1.0.zip`，再选择解压后直接包含 `manifest.json` 的文件夹；浏览器不能直接加载 ZIP。
5. 在浏览器工具栏的扩展菜单中，将“西电智课 · 录播下载”固定，方便访问。

本版本需要 Chrome / Edge 114 或更新版本。扩展按开发者模式加载，尚未上架扩展商店。

## 使用

1. 在浏览器中正常登录西电智课，打开某一节课的回放。
2. 点击扩展图标。已有 `<video>` 视频源会直接被识别；若面板为空，在页面点击播放，再点“重新识别”。双画面课程可以分别播放两路。
3. 点击“预览画面”确认内容；将“画面 1 / 画面 2”改名为“课件 / 教室”等名称。扩展不会仅凭左右位置猜测画面类型。
4. 课程名称会从页面读取，也可以手动修改。点击单路“下载视频”，或“下载全部画面”。
5. 默认保存到浏览器下载目录下的 `西电智课/课程名/日期_时间_序号_画面名.mp4`；勾选“每次选择保存位置”后由浏览器弹出保存窗口。
6. 关闭扩展面板后，浏览器下载任务仍会继续。可在面板暂停、继续，或点击“查看下载”进入浏览器下载列表。

录播日期和时间来自视频路径或文件名，使用北京时间。相同名称的两个机位仍保留独立编号，避免覆盖。

## 支持范围

- 页面：`http(s)://newes.chaoxing.com/`，包括内嵌回放页面。
- 视频：`http(s)://kdlbptvideo.xidian.edu.cn/` 下的 MP4。
- 自动发现动态视频、已加载的视频源以及实际成功的视频请求；重复的 HTTP Range 请求会合并为一个视频条目。
- 下载保留完整 `auth_key`，同一资源重新出现新签名时优先保留更新的地址。不会推测签名的具体过期时间。
- 当前只处理打开的回放页面，不包含整学期课程自动遍历、HLS/DASH 合并和双路画面合成。

## 常见情况

**刚安装后没有视频**：刷新回放页面，播放后重新识别。扩展也会尝试从当前页面的视频元素和已发生的资源请求中恢复地址。

**只有一路**：在页面播放另一路，或进入实际的双画面回放页再识别。

**下载中断或返回 403**：刷新原回放页面以获取新的签名，再重新识别并下载。浏览器如果允许继续下载，可以先尝试“继续下载”；若无法继续，新的下载会由浏览器生成独立文件。

**列表中多条同名 MP4**：扩展以完整路径中的机位目录区分视频，不会因为文件名相同而把两个机位合并。

**切换了课次**：正常页面导航会清空旧列表；内嵌播放器或当前视频源改变后会更新画面。若页面使用特殊播放器且列表没有更新，请刷新原页面再识别。

## 数据和权限

扩展只向当前平台的视频服务器发起预览或下载，不配置上传服务、统计服务或账号系统。不会读取 Cookie、密码或请求头中的登录凭证。

视频地址、页面识别结果和扩展关联的下载编号仅保存在浏览器会话存储，浏览器重启、扩展重载或更新后清除；关闭标签页时清理该页记录。仅“每次选择保存位置”选项保存在本地设置中。

权限用途：`activeTab` / `scripting` 用于扫描当前页面及已授权的内嵌页面；`webRequest` 只观察限定视频域名的响应；`downloads` 创建及查询扩展自身的下载；`storage` 保存会话状态和设置。主机权限仅限上述两个域名。

## 开发和验证

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run check
npm.cmd test
npm.cmd run build
```

`extension/` 是无需编译的完整扩展；开发依赖仅用于测试和生成 ZIP，运行时不依赖外部包。`npm.cmd run build` 生成 ZIP 和 SHA-256 文件到 `dist/`。修改图标后可运行 `node scripts/icons.mjs` 重新生成 PNG。

`npm.cmd run preview` 启动仅绑定 `127.0.0.1` 的界面演示，使用人工示例数据，不读取登录态或下载真实课程；演示页面不包含在扩展包内。

自动测试覆盖媒体地址校验、双机位去重、签名更新、Windows 文件名、会话恢复、并发请求、消息权限、下载任务、内容脚本和面板交互。真实学校页面需要用户登录；发布包仍需在已登录页面加载后确认实际播放器布局及浏览器下载行为。

接口依据：[Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads)、[webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)、[scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[storage](https://developer.chrome.com/docs/extensions/reference/api/storage)。
