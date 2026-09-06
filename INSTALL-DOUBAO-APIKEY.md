# 千幕服务端插件一键安装

同一个千幕服务端插件同时为以下功能提供同源请求：

- 配音中的豆包 API Key 接入；
- 分镜中的 NovelAI、Banana / Gemini、GPT Image 2 / OpenAI 兼容中转、Doubao Seedream 与 ComfyUI。
- 影片/H3 属于后续阶段；健康接口中的兼容声明不代表当前已开放影片功能。

先等待正在生成的任务结束，再停止 SillyTavern 后端。安装时需要输入 `STOPPED` 确认；关闭网页不等于停止后端。脚本不会替你停止或重启进程。

安装程序会保留独立版本的配置备份，下载/更新成功后才开启 `enableServerPlugins`。本地改动、重复配置项或链接目录会暂停安装，不覆盖用户改动。不需要执行 `npm install`。请使用与前端相匹配的服务版本；不同安装分支不会因为刷新浏览器自动同步。

## 云端 / VPS 部署（Linux）

通过 SSH 进入服务器，按原部署方式停止 ST 后端，再进入安装目录，整行复制并回车：

```bash
curl -fsSL https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/main/install-server-plugin.sh | sh
```

这条命令会自动识别：

- **VPS 原生部署**：当前目录能看到 `config.yaml`；安装完成后按原方式重启 SillyTavern 后端服务。
- **VPS Docker Compose 部署**：当前目录能看到 compose 配置文件和 `config` 文件夹；安装程序会检查插件目录挂载，但不会自动重启容器。完成后按原方式启动（常见服务名可使用 `docker compose start sillytavern`）。

如果出现过 `New-Item: command not found` 或 `Out-Null: command not found`，说明你使用的是 Linux/Git Bash 终端，应使用上面这一行，不要使用 PowerShell 命令。

## 本地部署

### Windows

先停止 SillyTavern 后端进程，在 **SillyTavern 根目录**打开 PowerShell，整行复制并回车：

```powershell
irm https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/main/install-server-plugin.ps1 | iex
```

### macOS / Linux / Git Bash

关闭 SillyTavern，在 **SillyTavern 根目录**打开终端，整行复制并回车：

```bash
curl -fsSL https://raw.githubusercontent.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut/main/install-server-plugin.sh | sh
```

## 安装完成后

必须**重启 SillyTavern 后端服务或 Docker 容器**，不是只刷新、关闭或重新打开 ST 网页。服务端插件只会在后端启动时加载。

后端重启完成后，再刷新 ST 网页。此时可以：

- 打开千幕 → 配音 → 豆包语音，接入方式选择“API Key”，粘贴 API Key 并测试连接；
- 打开千幕 → 分镜，在所选模型的连接卡中填写官方接口或自定义中转并测试连接。自定义或第三方中转仍可拉取模型、查看接口全部模型；若中转不提供模型列表，也可以手动填写模型 ID。

安装成功后，健康检查地址会显示 `"ok":true`，并在 `services` 中列出 `doubao-tts`、`storyboard-image` 与 `minimax-h3`：

- 本地部署：`http://127.0.0.1:8000/api/plugins/qianmu-tts/health`
- VPS 部署：在你的 SillyTavern 访问地址后加 `/api/plugins/qianmu-tts/health`，例如 `https://st.example.com/api/plugins/qianmu-tts/health`

原生部署会生成 `config.yaml.qianmu-backup.<编号>`；Docker 部署在 `config` 下生成同类备份。每次备份独立保存，不覆盖旧备份；同名 `.ref` 文件记录更新前的插件提交节点，首次安装为空。备份可能含 ST 配置中的私密信息，请勿公开上传。

再次运行会更新现有 Git 安装，不会重复安装；不要同时运行两次安装。失败时请保留备份和提示的暂存目录；不要把“代码已准备、配置未完成”当作成功。脚本不删除聊天、密钥仓、已生成图片或千幕服务防重记录。

需要回退时，先保持后端停止，核对对应备份和 `.ref` 节点后再按原版本恢复；不要直接覆盖后来修改过的 ST 配置。当前脚本尚不提供自动回滚或 ZIP 安装覆盖，也不保证任意旧版本都具备新的服务收片入口。

## 常见提示

- 提示“既不是原生安装目录，也不是 Docker Compose 目录”：当前终端位置不对。原生部署需进入能看到 `config.yaml` 的目录；Docker 部署需进入能看到 compose 文件和 `config` 文件夹的目录。
- Docker 提示“尚未挂载服务端插件目录”：在 `sillytavern` 服务的 `volumes` 下加入 `"./plugins:/home/node/app/plugins"`，重新执行安装命令。
- `git command not found`：请先安装 Git，重新打开终端后再次粘贴安装命令。
- 豆包测试返回 401、403 或资源错误：确认填写的是豆包语音 API Key，账号已开通 Seed TTS 2.0，并使用属于该资源的音色 ID。
- 旧版 App ID 仍可使用：在“接入方式”中选择“App ID + Access Key”。
- 分镜连接失败：检查 Base URL、API Key 与模型 ID。VPS 或 Docker 部署时，ComfyUI 地址必须能从 SillyTavern 后端所在的主机或容器访问，不能直接把仅宿主机可见的 `127.0.0.1` 当作容器内地址。
- 第三方中转无法拉取模型：部分中转不提供标准模型列表，仍可在千幕中手动填写该中转支持的模型 ID。
- 无终端交互环境：必须先由操作者确认 ST 已停止，再设置 `QIANMU_SERVER_STOPPED=1` 执行；这个变量只是确认，不会代为检查或停止服务。
- 提示已有安装维护锁：先确认另一次安装及其 Git 子进程是否仍在运行。中断安装可能留下 `.qianmu-installer.lock`，请核查后处理，不要直接重复安装或删除不明目录。
