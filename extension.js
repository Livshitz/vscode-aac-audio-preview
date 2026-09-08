const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VIEW_TYPE = 'aacAudioPreview.player';

function run(bin, args) {
	return new Promise((resolve) => {
		const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '', err = '';
		proc.stdout.on('data', (d) => { out += d; });
		proc.stderr.on('data', (d) => { err += d; });
		proc.on('error', (e) => resolve({ code: -1, out, err: e.message }));
		proc.on('close', (code) => resolve({ code, out, err }));
	});
}

class AudioPreviewProvider {
	constructor(cacheDir) {
		this.cacheDir = cacheDir;
	}

	async openCustomDocument(uri) {
		return { uri, dispose: () => {} };
	}

	async resolveCustomEditor(document, panel) {
		const cfg = vscode.workspace.getConfiguration('aacAudioPreview');
		const ffmpeg = cfg.get('ffmpegPath', 'ffmpeg');
		const ffprobe = ffmpeg.replace(/ffmpeg([^/\\]*)$/, 'ffprobe$1');
		const format = cfg.get('format', 'wav');
		const sampleRate = String(cfg.get('sampleRate', 24000));
		const bitrate = cfg.get('bitrate', '64k');
		const src = document.uri.fsPath;

		// Transcode to a temp file inside the webview's allowed roots — Blob/postMessage
		// delivery can't be decoded reliably, and a real file gives native seeking.
		const outPath = path.join(this.cacheDir, crypto.createHash('sha1').update(src + format + sampleRate).digest('hex') + '.' + format);

		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(this.cacheDir)],
		};
		let disposed = false;
		panel.onDidDispose(() => { disposed = true; });
		const post = (msg) => { if (!disposed) panel.webview.postMessage(msg); };

		panel.webview.html = html(path.basename(src), panel.webview.cspSource);

		const probe = await run(ffprobe, [
			'-v', 'error',
			'-show_entries', 'stream=codec_type,codec_name:format=duration',
			'-of', 'json', src,
		]);
		let codec = 'unknown', duration = 0;
		try {
			const info = JSON.parse(probe.out);
			codec = ((info.streams || []).find((s) => s.codec_type === 'audio') || {}).codec_name || 'none';
			duration = Number((info.format || {}).duration) || 0;
		} catch { /* probe is best-effort metadata only */ }

		const size = fs.existsSync(src) ? fs.statSync(src).size : 0;
		post({ type: 'meta', codec, duration, size });

		if (!fs.existsSync(outPath)) {
			post({ type: 'status', message: 'Decoding with ffmpeg…' });
			// WAV/PCM is the only container VS Code's stripped Chromium reliably demuxes.
			// Mono + reduced sample rate keeps a 30-min recording around 80MB.
			const codecArgs = format === 'wav'
				? ['-c:a', 'pcm_s16le', '-ac', '1', '-ar', sampleRate]
				: ['-c:a', 'libopus', '-b:a', bitrate];
			const res = await run(ffmpeg, ['-v', 'error', '-y', '-i', src, '-vn', ...codecArgs, outPath]);
			if (res.code !== 0) {
				post({ type: 'error', message: res.err.trim() || `ffmpeg exited ${res.code}` });
				return;
			}
		}

		post({
			type: 'src',
			uri: panel.webview.asWebviewUri(vscode.Uri.file(outPath)).toString(),
		});
	}
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function html(name, cspSource) {
	return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src ${cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
	body { font-family: var(--vscode-font-family); padding: 24px; color: var(--vscode-foreground); }
	h1 { font-size: 14px; font-weight: 600; margin: 0 0 4px; word-break: break-all; }
	.meta { font-size: 12px; opacity: .7; margin-bottom: 16px; }
	audio { width: 100%; }
	.status { font-size: 12px; opacity: .7; margin-top: 12px; }
	.error { color: var(--vscode-errorForeground); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
	<h1>${escapeHtml(name)}</h1>
	<div class="meta" id="meta"></div>
	<audio id="player" controls preload="auto"></audio>
	<div class="status" id="status"></div>
<script>
	const player = document.getElementById('player');
	const statusEl = document.getElementById('status');
	const metaEl = document.getElementById('meta');

	const fmt = (s) => {
		if (!s || !isFinite(s)) return '?';
		const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
		return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
	};

	player.addEventListener('error', () => {
		const err = player.error;
		statusEl.className = 'status error';
		statusEl.textContent = 'Playback failed: ' + (err ? err.code + ' ' + (err.message || '') : 'unknown');
	});
	player.addEventListener('canplay', () => { statusEl.textContent = ''; });

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg.type === 'meta') {
			metaEl.textContent = msg.codec + ' · ' + fmt(msg.duration) + ' · ' + (msg.size / 1048576).toFixed(1) + ' MB';
		} else if (msg.type === 'status') {
			statusEl.className = 'status';
			statusEl.textContent = msg.message;
		} else if (msg.type === 'src') {
			player.src = msg.uri;
			player.load();
			statusEl.textContent = '';
		} else if (msg.type === 'error') {
			statusEl.className = 'status error';
			statusEl.textContent = msg.message;
		}
	});
</script>
</body>
</html>`;
}

function activate(context) {
	const cacheDir = path.join(context.globalStorageUri ? context.globalStorageUri.fsPath : os.tmpdir(), 'audio-cache');
	fs.mkdirSync(cacheDir, { recursive: true });
	context.subscriptions.push(
		vscode.window.registerCustomEditorProvider(VIEW_TYPE, new AudioPreviewProvider(cacheDir), {
			webviewOptions: { retainContextWhenHidden: true },
			supportsMultipleEditorsPerDocument: false,
		})
	);
	context.subscriptions.push(
		vscode.commands.registerCommand('aacAudioPreview.clearCache', () => {
			for (const f of fs.readdirSync(cacheDir)) fs.unlinkSync(path.join(cacheDir, f));
			vscode.window.showInformationMessage('Audio preview cache cleared.');
		})
	);
}

module.exports = { activate, deactivate() {} };
