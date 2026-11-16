const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const {randomUUID} = require('crypto');
const {execFile} = require('child_process');
const {promisify} = require('util');
const {skip} = require('rxjs/operators');
const runFile = promisify(execFile);
const ai = require('./local-ai');
const config = require('./config');
const db = require('./db');
const utils = require('./utils');
const transcoding = require('./transcoding');
const logger = require('./logger');

const TASK_KEY = 'auto_transcribe';
const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
let activeRun = null;

function isSymlink(candidate) {
    try { return fs.lstatSync(candidate).isSymbolicLink(); } catch { return false; }
}

// Follow the existing metadata reader's filename order, including older extension-bearing
// sidecars. Refuse unsafe candidates rather than silently creating a second metadata file.
function sidecarPath(file) {
    const base = utils.removeFileExtension(file.path);
    const candidates = [...new Set([`${base}.info.json`, `${base}${file.isAudio ? '.mp3' : '.mp4'}.info.json`, `${file.path}.info.json`])];
    const selected = candidates.find(candidate => fs.existsSync(candidate) || isSymlink(candidate)) || candidates[0];
    if (!utils.isServableMediaFile(file.path, file.user_uid)
        || !utils.isPathInsideMediaRoots(selected, file.user_uid)
        || !utils.keepSiblingSidecarPaths(file.path, [selected]).length
        || isSymlink(selected)) {
        throw new Error('Media or metadata is outside its managed folder or uses a sidecar symlink.');
    }
    return selected;
}

async function readMetadata(file) {
    const target = sidecarPath(file);
    let metadata;
    try { metadata = await fs.readJSON(target); } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('Could not read the metadata sidecar; it was left unchanged.', {cause: error});
        // Enough source metadata for the existing importer when downloads did not keep JSON.
        metadata = {id: file.id || file.uid, title: file.title, webpage_url: file.url, duration: file.duration};
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || (metadata.ytdl_material !== undefined && (!metadata.ytdl_material || typeof metadata.ytdl_material !== 'object' || Array.isArray(metadata.ytdl_material)))) {
        throw new Error('The metadata sidecar has an invalid structure; it was left unchanged.');
    }
    return {target, metadata};
}

function sameMedia(stat, source) {
    return source && stat.size === source.size && stat.mtimeMs === source.mtime_ms;
}

function validTranscript(transcript) {
    return transcript?.version === 1 && typeof transcript.text === 'string'
        && transcript.text.length <= MAX_TEXT_LENGTH && Array.isArray(transcript.segments);
}

// Returned only after the existing file endpoint has resolved ownership/sharing. Reading
// remains available with AI disabled, so switching off inference does not hide saved work.
exports.attachTranscript = async (file) => {
    try {
        const {metadata} = await readMetadata(file);
        const transcript = metadata.ytdl_material?.transcript;
        if (validTranscript(transcript) && sameMedia(await fs.stat(file.path), transcript.source)) {
            return {...file, transcript: {text: transcript.text, provider: transcript.provider,
                model: transcript.model, language: transcript.language, created_at: transcript.created_at}};
        }
    } catch { /* Missing or broken sidecars must not stop playback. */ }
    return file;
};

async function transcribeFile(file, settings, signal) {
    const before = await fs.stat(file.path);
    const {metadata} = await readMetadata(file);
    const existing = metadata.ytdl_material?.transcript;
    if (validTranscript(existing) && sameMedia(before, existing.source)) return 'skipped';
    const probe = await transcoding.probeMedia(file.path);
    if (!probe) throw new Error('Could not probe the media file.');
    if (!probe.streams.some(stream => stream.codec_type === 'audio')) return 'skipped';
    const duration = Number(probe.format.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('The media duration is unavailable.');
    const chunkSeconds = settings.transcription_provider === 'llamacpp' ? 30 : 300;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytdl-transcription-'));
    try {
        const segments = [];
        let length = 0;
        for (let start = 0; start < duration; start += chunkSeconds) {
            signal.throwIfAborted();
            if (!utils.isServableMediaFile(file.path, file.user_uid)) throw new Error('Media is no longer available.');
            const audioPath = path.join(directory, 'audio.wav');
            // Each upload is at most about 9.6 MB, even for a multi-hour recording. ffmpeg
            // receives arguments directly, never a shell command containing a file name.
            await runFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-ss', String(start), '-protocol_whitelist', 'file,pipe,data', '-i', path.resolve(file.path), '-t', String(chunkSeconds),
                '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath],
            {signal, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024});
            const text = await ai.transcribe(await fs.readFile(audioPath), settings, signal);
            length += text.length + 1;
            if (length > MAX_TEXT_LENGTH) throw new Error('The transcript exceeds the storage limit.');
            segments.push({start, end: Math.min(start + chunkSeconds, duration), text});
        }
        signal.throwIfAborted();
        if (!ai.isEnabled()) throw new Error('AI integration is disabled.');
        const current = await db.getRecord('files', {uid: file.uid});
        if (!current || current.path !== file.path || !sameMedia(await fs.stat(file.path), {size: before.size, mtime_ms: before.mtimeMs})) {
            throw new Error('Media changed during transcription; the result was discarded.');
        }
        // Re-read just before merging so metadata edited during inference is preserved.
        const {target, metadata: latest} = await readMetadata(current);
        latest.ytdl_material = {...latest.ytdl_material, transcript: {
            version: 1, text: segments.map(segment => segment.text).filter(Boolean).join('\n'), segments,
            provider: settings.transcription_provider, model: settings.transcription_model,
            language: settings.language || null, created_at: new Date().toISOString(),
            source: {size: before.size, mtime_ms: before.mtimeMs}
        }};
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify(latest, null, 2), {flag: 'wx', mode: 0o600});
            signal.throwIfAborted();
            sidecarPath(current);
            await fs.rename(temporary, target);
        } finally {
            await fs.remove(temporary);
        }
        return 'transcribed';
    } finally {
        await fs.remove(directory);
    }
}

async function run() {
    if (!ai.isEnabled()) return null;
    await db.updateRecord('tasks', {key: TASK_KEY}, {result: null});
    const settings = ai.settings();
    ai.validateSettings(settings);
    if (settings.transcription_provider === 'disabled') throw new Error('Configure speech recognition in Settings → Advanced before running Auto-transcribe.');
    const controller = new AbortController();
    // Saving any AI setting stops the old run, including disabling then quickly re-enabling.
    const subscription = config.config_updated.pipe(skip(1)).subscribe(change => {
        if (change?.key === 'ai' || change?.key?.startsWith('ytdl_ai_')) controller.abort();
    });
    const result = {transcribed: 0, skipped: 0, failed: 0};
    try {
        const task = await db.getRecord('tasks', {key: TASK_KEY});
        const limit = Number(task?.options?.max_files ?? 10);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Files per run must be between 1 and 1000.');
        const files = [...await db.getRecords('files')];
        // Retry failures after untouched files, oldest attempt first, so a bad recording
        // cannot consume every limited run and prevent the rest of the library progressing.
        files.sort((a, b) => (a.transcription_failed_at || 0) - (b.transcription_failed_at || 0));
        for (const file of files) {
            if (controller.signal.aborted) break;
            if (result.transcribed + result.failed >= limit) break;
            try {
                result[await transcribeFile(file, settings, controller.signal)]++;
                if (file.transcription_failed_at) await db.updateRecord('files', {uid: file.uid}, {transcription_failed_at: null});
            } catch (error) {
                if (controller.signal.aborted) break;
                result.failed++;
                await db.updateRecord('files', {uid: file.uid}, {transcription_failed_at: Date.now()});
                logger.warn(`Auto-transcribe failed for file ${file.uid}: ${error.message}`);
            }
        }
        await db.updateRecord('tasks', {key: TASK_KEY}, {result});
        if (controller.signal.aborted) throw new Error('Auto-transcribe stopped because AI settings changed. Completed transcripts were kept.');
        if (result.failed) throw new Error(`${result.failed} file(s) could not be transcribed. See the server log for details.`);
        return result;
    } finally {
        subscription.unsubscribe();
    }
}

// A task can be started by HTTP and cron at the same moment. Claim the run before awaiting
// anything, so neither the audio extraction nor a sidecar write can run twice.
exports.run = () => {
    if (!activeRun) activeRun = run().finally(() => { activeRun = null; });
    return activeRun;
};
