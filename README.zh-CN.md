# dsh-voice-realtime

DeepSeek Harness 输入框里的**实时本地语音转文字**。点一下麦克风张嘴说话，字是**边说边出**的；说完点「完成」，带标点的整句文字会写进输入框的光标位置。全程不联网、不要 API Key。

英文说明见 [README.md](README.md)。

## 为什么不用自带的语音插件

DSH 自带的实验性语音插件是「先录完、再转写」。这个插件是**边录边转**：

- 每 ~0.7 秒刷新一次实时文字，长句子说到一半就能看见
- 说完一句自动断句，停顿自然变成带标点的分段
- 最终文字插到**按下麦克风那一刻**的光标位置（如果中途改过草稿，不会覆盖，而是在面板里提供「插入 / 丢弃」）

## 安装

```sh
dsh plugin add dsh-voice-realtime
```

或者在 **dsh-market**（插件 → 发现 → 搜 voice）里一键安装。插件带宿主端代码，装完重启一次 `dsh web`。

DSH 桌面版请走 **设置 → 插件**，桌面 profile 归应用自己的插件管理器管。

## 第一次使用：模型

插件本身不带模型。第一次点麦克风会提示「启用语音」，点一下就会下载：

| 文件 | 大小 |
| --- | --- |
| `model.int8.onnx`（SenseVoice-Small，中英日韩粤） | 228 MB |
| `tokens.txt` | 0.3 MB |

从 `huggingface.co` 下载，失败自动回退 `hf-mirror.com`；支持断点续传并校验 sha256，放在：

| 位置 | 说明 |
| --- | --- |
| `~/.dsh/voice-models` | 默认（`$DSH_HOME/voice-models`） |
| `DSH_VOICE_MODELS_DIR` | 自定义目录 |

想把实时性再提高，可以把流式 zipformer（`encoder*.onnx` / `decoder*.onnx` / `joiner*.onnx` / `tokens.txt`）放进 `voice-models/streaming/`，插件会自动切到**混合模式**：流式模型出实时文字，SenseVoice 出带标点的最终结果。没有它就用 SenseVoice 增量识别，准但实时刷新慢到 ~0.7 秒一次。

## 用法

1. 点输入框右侧的麦克风图标
2. 说话，面板里能看到实时文字和电平条
3. 「完成」把文字写进输入框，「取消」（Esc）丢弃
4. 面板底部有**麦克风选择**，选完会记住；录音中切换会自动重开

如果连续 2 秒没收到声音，面板会直接提示；设备名看着像虚拟设备（`Virtual`、`ToDesk`、回环设备）时还会点名。「根本没识别出我说的东西」十有八九就是这个原因——Windows 默认录音设备被虚拟/回环设备占着，真实麦克风根本没进去。

## 隐私

- 音频在浏览器采集，以 16-bit PCM 送到插件自己的 localhost 路由，由 `sherpa-onnx` 在**本机 DSH 宿主进程**里识别
- 不调云 API、不需要 Key、无遥测
- 落盘的只有两样：模型；以及每次「完成」时的一份调试音频（`voice-models/debug/`），方便排查识别问题。可以随时删，或设 `DSH_VOICE_DEBUG=0` 关掉

## HTTP 接口

宿主端注册了这些本机路由（挂在 harness 的 web server 上，继承它的鉴权）：

| 路由 | 作用 |
| --- | --- |
| `GET  /dsh-voice/status` | 模型就绪状态、引擎状态 |
| `POST /dsh-voice/models/download` | 开始/继续下载模型 |
| `POST /dsh-voice/engine/reload` | 不重启重读模型目录 |
| `POST /dsh-voice/session` | 开一个识别会话 |
| `POST /dsh-voice/audio?id=&sr=` | 原始 PCM16LE 单声道数据块 → 实时文字 |
| `POST /dsh-voice/finish?id=` | 收尾并返回最终文字 |
| `POST /dsh-voice/cancel?id=` | 丢弃会话 |
| `POST /dsh-voice/debug/dump?sr=&name=` | 把收到的音频写成 wav（调试用） |

## 环境要求

- DSH 0.2.x（web 或桌面版，输入框插槽 API 是 0.2.x 的）
- 宿主 Node.js 22+（DSH 自带）
- `sherpa-onnx-node` 2.0.1 作为普通 npm 依赖安装，自带 Windows/macOS/Linux 的 ONNX Runtime
- 在 Windows 11 + DSH 桌面版上验证过；其它平台依赖浏览器的 `AudioWorklet` 和 `sherpa-onnx`，预计可用但未实测

## 开发

```sh
git clone https://github.com/jijiahui/dsh-voice-realtime
cd dsh-voice-realtime
npm install
# 想本地联调就把包软链到 profile 的 node_modules 里
```

`lib/index.js` 是宿主端，`lib/client.js` 是浏览器端（经典 `__ModuleLoader__` 脚本包）。改宿主端要重启应用，改浏览器端刷新页面即可。`lib/engine.js` 可以直接用 Node 调，喂一个 16k 单声道 wav 就能验证识别链路。

## 许可

MIT
