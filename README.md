# AAC Audio Preview

Play `.mp4` / `.m4a` / `.aac` / `.mov` audio directly in VS Code.

## Why this exists

VS Code runs on Chromium, and the Chromium build it ships does **not** include an AAC
decoder (patent licensing). Opening an audio-only `.mp4` therefore gives you either
silence or *"Unable to play this video."* — even though QuickTime, which uses macOS's
licensed decoder, plays the same file fine.

This extension decodes the file **outside** the webview using your locally installed
`ffmpeg`, caches the result, and hands the editor a format it can actually demux.

## Requirements

`ffmpeg` (and `ffprobe`) on your `PATH`:

```sh
brew install ffmpeg        # macOS
apt install ffmpeg         # Debian/Ubuntu
```

Or point `aacAudioPreview.ffmpegPath` at the binary.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `aacAudioPreview.ffmpegPath` | `ffmpeg` | Path to the binary. `ffprobe` is resolved alongside it. |
| `aacAudioPreview.format` | `wav` | `wav` (PCM) is the only container reliably demuxed by VS Code's Chromium. `ogg` (Opus) is ~6× smaller but rejected by many builds. |
| `aacAudioPreview.sampleRate` | `24000` | WAV only. `16000` is fine for speech and cuts size by a third. |
| `aacAudioPreview.bitrate` | `64k` | Ogg only. |

## Notes

- **Your source files are never modified.** Transcodes are written to the extension's
  global storage, keyed by source path + settings, so re-opening a file is instant.
- Run **Audio Preview: Clear Transcode Cache** from the command palette to reclaim space.
- A 30-minute recording decodes in ~1.5s and occupies ~83 MB of cache as 24 kHz mono WAV.

## License

MIT

## Known limitations

- This extension registers as the **default** editor for `.mp4` and `.mov`, so a file with
  a real video track will open here as audio-only. Use *Reopen Editor With…* → *Video
  Preview* for those.
- Playback is served from a decoded copy, so the cache trades disk space for compatibility.
