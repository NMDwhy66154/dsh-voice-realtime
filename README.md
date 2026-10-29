# dsh-voice-realtime

Real-time, fully local speech-to-text inside the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) composer.

Press the microphone next to the send button and start talking: words appear **while you speak** in a floating panel, and when you press **完成** (done) the finished text — with punctuation — is written into the composer at the caret. Nothing leaves the machine.

<p align="center">
  <img src="assets/icon.svg" width="96" alt="dsh-voice-realtime">
</p>

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Why another voice plugin

The experimental voice bundle that ships with DSH records first and transcribes **after** you stop. This plugin transcribes **during** the recording:

- live partial text every ~0.7 s, so a long sentence is readable as you go
- a sentence endpoint closes the segment automatically, so pauses become clean punctuation-separated sentences
- the final text is inserted at the position the caret had when you pressed the microphone (if the draft changed meanwhile, the text is offered in a panel with **插入** / **丢弃** instead of being lost)

## Install

```sh
dsh plugin add dsh-voice-realtime
```

or one click in **dsh-market** (Plugins → Discover → search “voice”). Restart `dsh web` after installing a plugin that ships a host half.

On the official DSH Desktop app use **Settings → Plugins** — the desktop profile belongs to the app's plugin manager.

## First run: models

The plugin starts **without** models and asks for them: click the microphone once and press **启用语音** in the tooltip when it says models are missing (or install them before with the HTTP route below).

It downloads two files — `model.int8.onnx` (228 MB) and `tokens.txt` (0.3 MB) — the SenseVoice-Small multilingual model (zh / en / ja / ko / yue) from `huggingface.co`, falling back to `hf-mirror.com`. The download is resumable and sha256-verified, and lives in:

| platform | default directory |
| --- | --- |
| any | `$DSH_HOME/voice-models` (e.g. `~/.dsh/voice-models`) |
| override | `DSH_VOICE_MODELS_DIR=/path/to/models` |

Optionally copy a streaming zipformer transducer (`encoder*.onnx`, `decoder*.onnx`, `joiner*.onnx`, `tokens.txt`) into `voice-models/streaming/`: the plugin then runs in **hybrid** mode — the transducer produces the live partials (much lower latency) while SenseVoice still produces the punctuated finals. Without it the plugin uses SenseVoice incrementally, which is accurate but produces partials only every ~0.7 s.

## Using it

1. Click the microphone at the right of the composer.
2. Speak. The panel shows the live partial text and a level meter.
3. **完成** (or click the bar) inserts the text; **取消** (Esc) throws the recording away.
4. The **microphone picker** in the panel footer chooses the input device; the choice is remembered. Switching devices mid-recording reopens the stream.

If no level is detected for two seconds the panel says so, and names the device when it looks virtual (`Virtual`, `ToDesk`, loopback devices). That is the most common cause of "it does not recognise anything": Windows is recording from a virtual/loopback endpoint instead of the real microphone.

## Privacy

- audio is captured by the browser, streamed to the plugin's own localhost route as 16-bit PCM, and decoded by `sherpa-onnx` **in the DSH host process on this machine**
- no cloud API, no API key, no telemetry
- two files are written to disk: the models, and — only when you finish a recording — a debug copy of the captured audio in `voice-models/debug/` so a bad result can be investigated. Delete that directory any time; set `DSH_VOICE_DEBUG=0` to stop writing it.

## HTTP surface

The host half registers these localhost routes (all under the harness web server, so they inherit its auth fence):

| route | purpose |
| --- | --- |
| `GET  /dsh-voice/status` | model readiness, engine state |
| `POST /dsh-voice/models/download` | start/continue the model download |
| `POST /dsh-voice/engine/reload` | re-read the model directory without restarting |
| `POST /dsh-voice/session` | open a recognition session |
| `POST /dsh-voice/audio?id=&sr=` | raw PCM16LE mono chunk → live partial text |
| `POST /dsh-voice/finish?id=` | flush and return the final text |
| `POST /dsh-voice/cancel?id=` | drop the session |
| `POST /dsh-voice/debug/dump?sr=&name=` | write a wav of received audio (debug) |

## Requirements

- DSH 0.2.x web / desktop (the composer slot API is 0.2.x)
- Node.js 22+ in the host (DSH ships one)
- `sherpa-onnx-node` 2.0.1 is installed as a normal npm dependency; it bundles the ONNX runtime for Windows/macOS/Linux x64/arm64
- tested on Windows 11 with the DSH desktop app and `dsh web`; other platforms follow the browser's `AudioWorklet` + `sherpa-onnx` support and are expected to work but have not been verified

## Development

```sh
git clone https://github.com/jijiahui/dsh-voice-realtime
cd dsh-voice-realtime
npm install
# link it into a profile instead of publishing:
#   <profile>/node_modules/dsh-voice-realtime -> this directory
```

Edit `lib/index.js` (host) and `lib/client.js` (browser half, a classic `__ModuleLoader__` bundle). Host edits need an app restart; client edits need a page reload. `lib/engine.js` holds the sherpa setup and can be exercised from Node directly (feed a 16 kHz mono wav through `HybridEngine`).

## License

MIT
