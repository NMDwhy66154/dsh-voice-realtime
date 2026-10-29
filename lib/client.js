window.__ModuleLoader__.load({
	id: "dsh-voice-realtime",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var react = require("react");
		var reactDom = require("react-dom");
		var prim = require("@deepseek-ai/dsh-client-ui-primitives");
		var h = react.createElement;

		//#region styles
		var CSS = `
.dvr-trigger[data-listening="true"]{color:var(--dsw-color-danger,#e5484d)!important}
.dvr-bar{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;padding:2px 4px}
.dvr-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-color-danger,#e5484d);flex:0 0 auto;animation:dvr-pulse 1.1s ease-in-out infinite}
@keyframes dvr-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.82)}}
.dvr-live{font-size:12px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-color-text-secondary,#8a8a8a);max-width:340px}
.dvr-caret{display:inline-block;width:1px;height:12px;background:currentColor;margin-left:1px;animation:dvr-blink 1s step-end infinite;vertical-align:-2px}
@keyframes dvr-blink{50%{opacity:0}}
.dvr-panel{position:fixed;left:50%;transform:translateX(-50%);bottom:132px;width:min(760px,88vw);z-index:60;border-radius:14px;
 background:var(--dsw-color-bg-elevated,#1b1b1f);border:1px solid var(--dsw-color-border,rgba(255,255,255,.12));
 box-shadow:0 18px 48px rgba(0,0,0,.42);padding:12px 14px;backdrop-filter:blur(12px)}
.dvr-panel-head{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.04em;text-transform:uppercase;
 color:var(--dsw-color-text-secondary,#8a8a8a);margin-bottom:8px}
.dvr-panel-body{font-size:15px;line-height:1.65;max-height:190px;overflow:auto;white-space:pre-wrap;word-break:break-word;
 color:var(--dsw-color-text,#e8e8e8);min-height:22px}
.dvr-partial{color:var(--dsw-color-text-secondary,#a0a0a0)}
.dvr-empty{color:var(--dsw-color-text-tertiary,#6f6f6f);font-size:13px}
.dvr-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}
.dvr-meters{display:flex;align-items:flex-end;gap:2px;height:16px}
.dvr-meters i{display:block;width:2px;border-radius:1px;background:var(--dsw-color-accent,#4f7cff);opacity:.85}
.dvr-actions{display:flex;gap:8px;align-items:center}
.dvr-dev{max-width:190px;height:26px;border-radius:7px;border:1px solid rgba(127,127,127,.32);background:transparent;color:inherit;font-size:12px;padding:0 6px;outline:none}
.dvr-btn{border:1px solid var(--dsw-color-border,rgba(255,255,255,.16));background:transparent;color:inherit;
 font-size:12px;padding:4px 10px;border-radius:8px;cursor:pointer}
.dvr-btn:hover{background:rgba(255,255,255,.06)}
.dvr-btn[data-primary="true"]{background:var(--dsw-color-accent,#4f7cff);border-color:transparent;color:#fff}
.dvr-progress{height:4px;border-radius:2px;background:rgba(255,255,255,.12);overflow:hidden;margin-top:8px}
.dvr-progress i{display:block;height:100%;background:var(--dsw-color-accent,#4f7cff);transition:width .3s ease}
`
		function ensureStyle() {
			try {
				if (document.getElementById("dvr-style")) return;
				var s = document.createElement("style");
				s.id = "dvr-style";
				s.textContent = CSS;
				(document.head || document.documentElement).appendChild(s);
			} catch (err) { /* ignore */ }
		}
		//#endregion

		//#region capture
		var WORKLET = `
class DvrMic extends AudioWorkletProcessor {
  constructor(){ super(); this.buf = new Float32Array(0); }
  process(inputs){
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch || !ch.length) return true;
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf); merged.set(ch, this.buf.length); this.buf = merged;
    const FRAME = Math.round(sampleRate * 0.12);
    while (this.buf.length >= FRAME) {
      const frame = this.buf.subarray(0, FRAME);
      const pcm = new Int16Array(FRAME);
      let sum = 0;
      for (let i = 0; i < FRAME; i++) {
        let v = frame[i]; sum += v * v;
        v = v < -1 ? -1 : (v > 1 ? 1 : v);
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      const rms = Math.sqrt(sum / FRAME);
      this.port.postMessage({ pcm: pcm.buffer, rms: rms }, [pcm.buffer]);
      this.buf = this.buf.slice(FRAME);
    }
    return true;
  }
}
registerProcessor('dvr-mic', DvrMic);
`
		function Recorder(onFrame, onError) {
			this.onFrame = onFrame;
			this.onError = onError;
			this.closed = false;
		}
		Recorder.prototype.start = function start() {
			var self = this;
			function open(deviceId) {
				var audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
				if (deviceId) audio.deviceId = { exact: deviceId };
				return navigator.mediaDevices.getUserMedia({ audio: audio, video: false });
			}
			var saved = null;
			try { saved = window.localStorage.getItem("dvr.deviceId"); } catch (err) {}
			return open(saved || null).catch(function (err) {
				if (!saved) throw err;
				try { window.localStorage.removeItem("dvr.deviceId"); } catch (e2) {}
				return open(null);
			}).then(function (stream) {
				self.stream = stream;
				try {
					var track = stream.getAudioTracks && stream.getAudioTracks()[0];
					self.deviceLabel = track ? String(track.label || "") : "";
					self.trackSettings = track && track.getSettings ? track.getSettings() : {};
				} catch (err) {}
				var AudioCtor = window.AudioContext || window.webkitAudioContext;
				self.ctx = null;
				try { self.ctx = new AudioCtor({ sampleRate: 16000, latencyHint: "interactive" }); } catch (err) { self.ctx = null; }
				if (!self.ctx) self.ctx = new AudioCtor({ latencyHint: "interactive" });
				self.sampleRate = self.ctx.sampleRate || 16000;
				var url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
				return self.ctx.audioWorklet.addModule(url).then(function () {
					URL.revokeObjectURL(url);
					if (self.closed) return;
					var source = self.ctx.createMediaStreamSource(stream);
					var node = new AudioWorkletNode(self.ctx, "dvr-mic", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
					self.node = node;
					node.port.onmessage = function (event) {
						if (self.closed) return;
						try { self.onFrame(event.data.pcm, event.data.rms, self.sampleRate); } catch (err) { self.onError(err); }
					};
					var sink = self.ctx.createGain();
					sink.gain.value = 0.0001;
					source.connect(node);
					node.connect(sink);
					sink.connect(self.ctx.destination);
					if (self.ctx.state === "suspended") return self.ctx.resume();
				});
			});
		};
		Recorder.prototype.stop = function stop() {
			this.closed = true;
			try { this.node && (this.node.port.onmessage = null); } catch (err) {}
			try { this.node && this.node.disconnect(); } catch (err) {}
			try { this.stream && this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (err) {}
			var ctx = this.ctx;
			this.ctx = null;
			return ctx ? Promise.resolve(ctx.close().catch(function () {})) : Promise.resolve();
		};
		//#endregion

		//#region api
		function postJson(path, body) {
			return fetch("/dsh-voice/" + path, {
				method: "POST",
				headers: body ? { "content-type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined
			}).then(function (res) {
				return res.json().catch(function () { return {}; }).then(function (json) {
					if (!res.ok) {
						var err = new Error(json && json.error ? json.error : "HTTP " + res.status);
						err.payload = json;
						throw err;
					}
					return json;
				});
			});
		}
		function getStatus() {
			return fetch("/dsh-voice/status", { headers: { accept: "application/json" } }).then(function (res) { return res.json(); });
		}
		//#endregion

		//#region component
		function MicControl(props) {
			var sessionId = props.sessionId;
			var inputActions = props.inputActions;
			var locked = props.locked;
			var onActiveChange = props.onActiveChange || function () {};

			var phaseState = react.useState("idle");
			var phase = phaseState[0], setPhase = phaseState[1];
			var partialState = react.useState("");
			var partial = partialState[0], setPartial = partialState[1];
			var segmentsState = react.useState([]);
			var segments = segmentsState[0], setSegments = segmentsState[1];
			var messageState = react.useState("");
			var message = messageState[0], setMessage = messageState[1];
			var pendingState = react.useState("");
			var pending = pendingState[0], setPending = pendingState[1];
			var levelState = react.useState(0);
			var level = levelState[0], setLevel = levelState[1];
			var statusState = react.useState(null);
			var status = statusState[0], setStatus = statusState[1];
			var micLabelState = react.useState("");
			var micLabel = micLabelState[0], setMicLabel = micLabelState[1];
			var micRateState = react.useState(16000);
			var micRate = micRateState[0], setMicRate = micRateState[1];
			var devicesState = react.useState([]);
			var devices = devicesState[0], setDevices = devicesState[1];

			var activeRef = react.useRef(null);
			var spanRef = react.useRef(null);
			var generationRef = react.useRef(0);
			var chainRef = react.useRef(Promise.resolve());
			var backlogRef = react.useRef(0);

			react.useLayoutEffect(function () {
				var expanded = phase !== "idle";
				onActiveChange(expanded);
				return function () { onActiveChange(false); };
			}, [phase, onActiveChange]);

			var refreshStatus = react.useCallback(function () {
				return getStatus().then(function (json) {
					setStatus(json);
					return json;
				}).catch(function (err) {
					setStatus({ ok: false, error: String(err && err.message || err) });
					return null;
				});
			}, []);

			react.useEffect(function () { refreshStatus(); }, [refreshStatus]);

			// Poll while the model download runs.
			react.useEffect(function () {
				if (!status || !status.download || !status.download.active) return;
				var timer = setInterval(function () { refreshStatus(); }, 2000);
				return function () { clearInterval(timer); };
			}, [status && status.download && status.download.active, refreshStatus]);

			var reset = react.useCallback(function () {
				generationRef.current++;
				var active = activeRef.current;
				activeRef.current = null;
				if (active) {
					try { active.recorder.stop(); } catch (err) {}
					if (active.id) postJson("cancel?id=" + encodeURIComponent(active.id)).catch(function () {});
				}
				backlogRef.current = 0;
				chainRef.current = Promise.resolve();
				setPartial("");
				setSegments([]);
				setLevel(0);
				setMessage("");
				setPhase("idle");
			}, []);

			react.useEffect(function () {
				var onKey = function (event) {
					if (event.key === "Escape" && activeRef.current) { event.preventDefault(); reset(); }
				};
				window.addEventListener("keydown", onKey);
				return function () {
					window.removeEventListener("keydown", onKey);
					var active = activeRef.current;
					activeRef.current = null;
					if (active) {
						try { active.recorder.stop(); } catch (err) {}
						if (active.id) postJson("cancel?id=" + encodeURIComponent(active.id)).catch(function () {});
					}
				};
			}, [reset]);

			var sendFrame = function (active, pcm, rms) {
				setLevel(rms * 9);
				if (backlogRef.current > 6) return; // drop when the host cannot keep up
				backlogRef.current++;
				var bytes = new Uint8Array(pcm);
				chainRef.current = chainRef.current.then(function () {
					return fetch("/dsh-voice/audio?id=" + encodeURIComponent(active.id) + "&sr=" + (active.sampleRate || 16000), {
						method: "POST",
						headers: { "content-type": "application/octet-stream" },
						body: bytes
					}).then(function (res) { return res.json(); }).then(function (json) {
						if (generationRef.current !== active.gen) return;
						if (json && json.ok) {
							if (Array.isArray(json.segments) && json.segments.length !== active.segments.length) active.segments = json.segments;
							setSegments(active.segments.slice());
							setPartial(json.partial || "");
						}
					}).catch(function (err) {
						if (generationRef.current === active.gen) setMessage("识别中断：" + String(err && err.message || err));
					}).finally(function () { backlogRef.current = Math.max(0, backlogRef.current - 1); });
				});
			};

			var dumpAudio = function (active) {
				var chunks = active.chunks || [];
				if (!chunks.length) return Promise.resolve();
				var total = chunks.reduce(function (n, c) { return n + c.byteLength; }, 0);
				var merged = new Uint8Array(total);
				var off = 0;
				for (var i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].byteLength; }
				return fetch("/dsh-voice/debug/dump?sr=" + (active.sampleRate || 16000) + "&name=mic", {
					method: "POST",
					headers: { "content-type": "application/octet-stream" },
					body: merged
				}).then(function (res) { return res.json(); }).catch(function () {});
			};

			var refreshDevices = function () {
				if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
				navigator.mediaDevices.enumerateDevices().then(function (list) {
					setDevices(list.filter(function (d) { return d.kind === "audioinput"; }));
				}).catch(function () {});
			};

			var pickDevice = function (deviceId) {
				try {
					if (deviceId) window.localStorage.setItem("dvr.deviceId", deviceId);
					else window.localStorage.removeItem("dvr.deviceId");
				} catch (err) {}
				var wasRecording = phase === "recording";
				reset();
				if (wasRecording) setTimeout(function () { start(); }, 220);
			};

			var start = function () {
				if (locked || activeRef.current) return;
				var gen = ++generationRef.current;
				setMessage("");
				setPartial("");
				setSegments([]);
				setPending("");
				setPhase("starting");
				var active = { gen: gen, id: "", segments: [], sampleRate: 16000, recorder: null, chunks: [], bytes: 0, peak: 0 };
				activeRef.current = active;
				spanRef.current = inputActions && inputActions.captureInsertion ? inputActions.captureInsertion() : null;
				var failure = function (err) {
					if (generationRef.current !== gen) return;
					var text = String(err && err.message || err);
					if (/Permission|denied|NotAllowed/i.test(text)) text = "麦克风权限被拒绝";
					else if (/NotFound|Devices/i.test(text)) text = "未找到麦克风设备";
					setMessage(text);
					setPhase("error");
				};
				postJson("session").then(function (json) {
					if (generationRef.current !== gen) { postJson("cancel?id=" + encodeURIComponent(json.id)).catch(function () {}); return; }
					active.id = json.id;
					active.recorder = new Recorder(function (pcm, rms, sampleRate) {
						if (generationRef.current !== gen) return;
						active.sampleRate = sampleRate;
						active.peak = Math.max(active.peak || 0, rms);
						// Warn when the selected input is silent (wrong device, muted mic,
						// or a virtual loopback that carries no microphone signal).
						if (rms < 0.0025) active.quietMs = (active.quietMs || 0) + 120;
						else active.quietMs = 0;
						if (!active.hinted && active.quietMs > 2000) {
							active.hinted = true;
							var deviceName = String(active.recorder && active.recorder.deviceLabel || "");
							var virtual = /虚拟|Virtual|ToDesk|网易/i.test(deviceName);
							setMessage(virtual
								? "当前麦克风是虚拟/回环设备（" + deviceName.slice(0, 16) + "），请在下方切换成真实麦克风"
								: "没有收到声音，请确认麦克风未静音或换一个设备");
						}
						try {
							active.chunks.push(new Uint8Array(pcm.slice(0)));
							active.bytes += pcm.byteLength;
							if (active.bytes > 24 * 1024 * 1024) { active.chunks = []; active.bytes = 0; }
						} catch (bufErr) {}
						sendFrame(active, pcm, rms);
					}, failure);
					return active.recorder.start().then(function () {
						if (generationRef.current !== gen) return;
						var label = String(active.recorder.deviceLabel || "").replace(/^默认\s*-\s*/, "");
						setMicLabel(label || "默认麦克风");
						setMicRate(active.recorder.sampleRate || 16000);
						refreshDevices();
						setPhase("recording");
					});
				}).catch(failure);
			};

			var finish = function () {
				var active = activeRef.current;
				if (!active || phase !== "recording") return;
				setPhase("finishing");
				var gen = active.gen;
				active.recorder.stop().then(function () {
					return chainRef.current;
				}).then(function () {
					return dumpAudio(active);
				}).then(function () {
					return postJson("finish?id=" + encodeURIComponent(active.id));
				}).then(function (json) {
					if (generationRef.current !== gen) return;
					activeRef.current = null;
					var text = String((json && json.text) || "").trim();
					if (!text) {
						setMessage("没有识别到语音内容");
						setPhase("error");
						return;
					}
					var span = spanRef.current;
					var ok = false;
					try { ok = !!(span && inputActions.insertText(text, span)); } catch (err) { ok = false; }
					if (!ok) {
						try { ok = !!(inputActions.insertText(text, inputActions.captureInsertion())); } catch (err) { ok = false; }
					}
					if (ok) {
						setSegments([]); setPartial(""); setMessage("");
						setPhase("idle");
					} else {
						setPending(text);
						setPhase("pending");
					}
				}).catch(function (err) {
					if (generationRef.current !== gen) return;
					activeRef.current = null;
					setMessage("转写失败：" + String(err && err.message || err));
					setPhase("error");
				});
			};

			var insertPending = function () {
				if (!pending) return;
				var ok = false;
				try { ok = !!(inputActions.insertText(pending, inputActions.captureInsertion())); } catch (err) { ok = false; }
				if (ok) { setPending(""); setPhase("idle"); } else setMessage("输入框当前不可写入，请稍后重试");
			};

			var startDownload = function () {
				postJson("models/download").then(function () { refreshStatus(); }).catch(function (err) {
					setMessage("下载启动失败：" + String(err && err.message || err));
				});
			};

			var modelsReady = status && status.models && status.models.ready;
			var download = (status && status.download) || null;
			var downloadPercent = 0;
			if (status && status.models && status.models.totalBytes) {
				downloadPercent = Math.min(100, Math.round(((status.models.presentBytes || 0) / status.models.totalBytes) * 100));
			}

			var startDownloadIfNeeded = function () {
				if (modelsReady) { start(); return; }
				if (!(download && download.active)) startDownload();
			};

			if (phase === "idle" || phase === "setup" || phase === "error" || phase === "pending") {
				var idleText = "";
				if (phase === "error") idleText = message;
				if (phase === "pending") idleText = pending;
				return h(react.Fragment, null,
					!modelsReady && phase === "idle"
						? h("button", {
							type: "button",
							className: "dvr-btn",
							title: download && download.active ? "正在下载语音模型" : "下载离线语音识别模型",
							onClick: function () { if (!download || !download.active) startDownload(); },
							disabled: !!(download && download.active)
						}, download && download.active ? "模型 " + downloadPercent + "%" : "启用语音")
						: null,
					h(prim.Tooltip, {
						label: modelsReady ? "实时语音输入" : "下载语音识别模型后可听写",
						side: "top",
						portal: true,
						children: h("span", { className: "dvr-trigger" },
							h(prim.Button, {
								className: "dvr-trigger",
								size: "sm",
								type: "button",
								disabled: !!locked || !modelsReady,
								"aria-label": "实时语音输入",
								title: "实时语音输入",
								onMouseDown: function (event) { event.preventDefault(); },
								onClick: function () { startDownloadIfNeeded(); },
								children: h(prim.IconMicrophoneOutlineRegular, { size: 18 })
							}))
					}),
					phase === "pending"
						? h("div", { className: "dvr-bar" },
							h("span", { className: "dvr-live", title: pending }, idleText || pending),
							h("button", { type: "button", className: "dvr-btn", "data-primary": "true", onClick: insertPending }, "插入"),
							h("button", { type: "button", className: "dvr-btn", onClick: function () { setPending(""); setPhase("idle"); } }, "丢弃"))
						: null,
					phase === "error"
						? h("div", { className: "dvr-bar" },
							h("span", { className: "dvr-live", title: message }, message),
							h("button", { type: "button", className: "dvr-btn", onClick: function () { setMessage(""); setPhase("idle"); } }, "关闭"))
						: null
				);
			}

			var live = segments.join("") + (partial || "");
			var currentDeviceId = "";
			try { currentDeviceId = window.localStorage.getItem("dvr.deviceId") || ""; } catch (lErr) {}
			var bars = [];
			for (var i = 0; i < 5; i++) {
				var rand = 0.35 + ((Math.sin(Date.now() / 240 + i) + 1) / 2) * 0.65;
				var height = Math.max(2, Math.min(16, (0.6 + level) * 16 * rand));
				bars.push(h("i", { key: i, style: { height: height + "px", opacity: 0.45 + level / 2 } }));
			}

			return h(react.Fragment, null,
				h("div", { className: "dvr-bar" },
					h("span", { className: "dvr-dot" }),
					h("span", { className: "dvr-live", title: live || message },
						phase === "starting" ? "正在打开麦克风…"
							: phase === "finishing" ? "正在整理文字…"
								: (partial || (segments.length ? segments[segments.length - 1] : "正在聆听…")),
						phase === "recording" ? h("span", { className: "dvr-caret" }) : null),
					phase === "recording"
						? h("button", { type: "button", className: "dvr-btn", "data-primary": "true", onClick: finish }, "完成")
						: null,
					h("button", { type: "button", className: "dvr-btn", onClick: reset, title: "取消 (Esc)" }, "取消")),
				reactDom.createPortal(
					h("div", { className: "dvr-panel" },
						h("div", { className: "dvr-panel-head" },
							h("span", null, phase === "recording" && micLabel
								? "实时转写 · " + micLabel.slice(0, 18) + " · " + micRate + "Hz"
								: "实时转写"),
							h("span", { className: "dvr-meters" }, bars)),
						h("div", { className: "dvr-panel-body" },
							live
								? h("span", null,
									h("span", null, segments.join("")),
									h("span", { className: "dvr-partial" }, partial || ""),
									phase === "recording" ? h("span", { className: "dvr-caret" }) : null)
								: h("span", { className: "dvr-empty" },
									phase === "starting" ? "正在打开麦克风…"
										: phase === "finishing" ? "正在整理文字…"
											: "请开始说话…")),
						h("div", { className: "dvr-foot" },
							h("span", { className: "dvr-empty" }, message || (phase === "recording" ? "说完点“完成”，文字会写入输入框" : "")),
							h("span", { className: "dvr-actions" },
								h("select", {
									className: "dvr-dev",
									title: micLabel ? (micLabel + " · " + micRate + " Hz") : "选择麦克风",
									value: currentDeviceId,
									onChange: function (event) { pickDevice(event.target.value); }
								},
									h("option", { value: "" }, "默认麦克风"),
									devices.map(function (d, i) {
										var name = String(d.label || ("麦克风 " + (i + 1))).slice(0, 28);
										return h("option", { key: d.deviceId || i, value: d.deviceId }, name);
									})),
								phase === "recording" ? h("button", { type: "button", className: "dvr-btn", "data-primary": "true", onClick: finish }, "完成") : null,
								h("button", { type: "button", className: "dvr-btn", onClick: reset }, "取消")))),
					document.body))
		}
		//#endregion

		exports.inject = ["slots"];
		exports.apply = function apply(ctx) {
			ensureStyle();
			ctx.slots.inject("conversation.input.activity", function () {
				return ctx.slots.register({ name: "conversation.input.activity" }, MicControl);
			});
		};
		return module.exports;
	}
});
