# Changelog

## 0.1.0

- first release
- realtime partial transcript in the composer (`conversation.input.activity` slot)
- SenseVoice-Small int8 finals with punctuation, CJK-aware segment joining
- automatic sentence endpoint, 25 s segment guard, near-silence segments dropped
- incremental SenseVoice partials; automatic hybrid mode when a streaming zipformer is present
- on-demand, resumable, sha256-verified model download from huggingface with hf-mirror fallback
- microphone picker with a remembered device, silence detection that names virtual/loopback endpoints
- insert at the caret captured before recording; conflicting edits fall back to an insert prompt
- debug wav dump of the captured audio for troubleshooting
