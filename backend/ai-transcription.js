// The Auto-transcribe task. The model chosen in Settings → Advanced → Local AI listens to each
// library file 30 seconds at a time and writes up what it hears in the style the task's Speech
// option asks for. With Vision on and Visual cues chosen, it also gets a few frames from each
// stretch and adds what they show. What it writes is saved in the file's metadata sidecar.
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
const STYLES = ['exact', 'brief', 'detailed', 'descriptive', 'novel'];
// Audio-capable models hear about 30 seconds at a time.
const STRETCH_SECONDS = 30;
const FRAMES_PER_STRETCH = 3;
// How much of the text so far goes with each stretch, so the model carries on from it.
const CONTEXT_CHARACTERS = 400;
let activeRun = null;

exports.TASK_KEY = TASK_KEY;
exports.STYLES = STYLES;

const SYSTEM_PROMPT = 'You turn stretches of a video or recording into text for a media library. '
    + 'Write in the language that is spoken, or in English when nothing is said. '
    + 'Reply with only the text asked for: no introduction, no headings and no comments about the task.';

// What the model writes about what it hears, by the task's Speech option.
const SPEECH = {
    exact: 'Transcribe everything said in the audio, word for word.',
    brief: 'Sum up what is said in the audio in one or two sentences.',
    detailed: 'Write notes on what is said in the audio, covering every point in order.',
    descriptive: 'Transcribe everything said in the audio, word for word, and describe other sounds that matter, such as music, laughter or sound effects, in square brackets.',
    novel: 'Retell what happens in the audio as a passage from a novel, in the past tense, with what people say as quoted dialogue.'
};

// What it adds about the frames, by the Visual cues option: into the same text as the speech...
const VISUAL_CUES = {
    exact: 'Where it matters, add what the frames show in square brackets: copy on-screen text exactly and state plainly what is visible, without interpreting it.',
    brief: 'Where it matters, add the most important thing the frames show, in a few words in square brackets.',
    detailed: 'Add what the frames show that helps follow along, such as on-screen text, demonstrations and changes of scene, in square brackets where it fits.',
    descriptive: 'Describe what the frames show, including people, places, actions, mood and on-screen text, in square brackets where it fits.',
    novel: 'Weave what the frames show into the text as description of the scene.'
};

// ...or as the whole text, when there is no speech to write up.
const VISUALS_ALONE = {
    exact: 'Copy any on-screen text exactly and state plainly what is visible, without interpreting it.',
    brief: 'Say in a sentence what the frames show.',
    detailed: 'Describe what the frames show that helps follow along, such as on-screen text, demonstrations and changes of scene.',
    descriptive: 'Describe what the frames show, including people, places, actions, mood and on-screen text.',
    novel: 'Describe what the frames show as a passage from a novel, in the past tense.'
};

function buildPrompt({speech, visual_cues, frames, previous}) {
    const lines = [];
    if (speech) lines.push(SPEECH[speech]);
    if (visual_cues) {
        const what = frames === 1 ? 'The image is a frame' : `The ${frames} images are frames, in order,`;
        lines.push(`${what} from ${speech ? 'the same stretch' : 'a stretch of video'}.`);
        lines.push((speech ? VISUAL_CUES : VISUALS_ALONE)[visual_cues]);
    }
    if (previous) lines.push(`The text so far ends: "${previous}" Carry on from there without repeating it.`);
    lines.push(speech ? 'If nothing is said and nothing worth noting is shown, reply with nothing.' : 'If nothing worth noting is shown, reply with nothing.');
    return lines.join('\n');
}
exports.buildPrompt = buildPrompt;

function tail(text) {
    const trimmed = text.trim();
    if (trimmed.length <= CONTEXT_CHARACTERS) return trimmed;
    const cut = trimmed.slice(-CONTEXT_CHARACTERS);
    const space = cut.indexOf(' ');
    return space > 0 ? cut.slice(space + 1) : cut;
}

function readOptions(options = {}) {
    const limit = Number(options.max_files ?? 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Files per run must be between 1 and 1000.');
    const speech = options.audio_style ?? 'exact';
    if (!STYLES.includes(speech)) throw new Error('Choose how Auto-transcribe writes up speech: exact, brief, detailed, descriptive or novel.');
    const visual_cues = options.vision_style ?? 'off';
    if (visual_cues !== 'off' && !STYLES.includes(visual_cues)) throw new Error('Choose how Auto-transcribe describes visual cues, or turn them off.');
    return {limit, speech, visual_cues};
}

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

// A transcript made another way is made again: changing the model or a style is a request
// for something different.
function sameRecipe(transcript, recipe) {
    return transcript.model === recipe.model
        && (transcript.audio_style ?? null) === recipe.audio_style
        && (transcript.vision_style ?? 'off') === recipe.vision_style;
}

// Returned only after the existing file endpoint has resolved ownership/sharing. Reading
// remains available with AI disabled, so switching off inference does not hide saved work.
exports.attachTranscript = async (file) => {
    try {
        const {metadata} = await readMetadata(file);
        const transcript = metadata.ytdl_material?.transcript;
        if (validTranscript(transcript) && sameMedia(await fs.stat(file.path), transcript.source)) {
            return {...file, transcript: {text: transcript.text, model: transcript.model,
                audio_style: transcript.audio_style ?? null, vision_style: transcript.vision_style ?? 'off',
                created_at: transcript.created_at}};
        }
    } catch { /* Missing or broken sidecars must not stop playback. */ }
    return file;
};

const ffmpeg = () => process.env.FFMPEG_PATH || 'ffmpeg';

// ffmpeg receives arguments directly, never a shell command containing a file name, and may
// only read local files.
function inputArgs(media_path, start, seconds) {
    return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(start),
        '-protocol_whitelist', 'file,pipe,data', '-i', path.resolve(media_path), '-t', String(seconds)];
}

// A stretch of the first audio track as 16 kHz mono WAV, about 1 MB for 30 seconds.
async function extractAudio(media_path, start, seconds, directory, signal) {
    const audio_path = path.join(directory, 'audio.wav');
    await runFile(ffmpeg(), [...inputArgs(media_path, start, seconds),
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio_path],
    {signal, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024});
    return (await fs.readFile(audio_path)).toString('base64');
}

// Frames spread evenly over a stretch, at most 768 pixels on a side so a few cost the model
// little. 0:V is the video without cover art.
async function extractFrames(media_path, start, seconds, directory, signal) {
    const count = Math.max(1, Math.round(FRAMES_PER_STRETCH * seconds / STRETCH_SECONDS));
    for (const name of await fs.readdir(directory)) {
        if (name.startsWith('frame-')) await fs.remove(path.join(directory, name));
    }
    await runFile(ffmpeg(), [...inputArgs(media_path, start, seconds), '-map', '0:V:0',
        '-vf', `fps=${(count / seconds).toFixed(6)},scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease`,
        '-frames:v', String(count), '-q:v', '4', path.join(directory, 'frame-%d.jpg')],
    {signal, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024});
    const frames = [];
    for (let i = 1; i <= count; i++) {
        const frame_path = path.join(directory, `frame-${i}.jpg`);
        if (await fs.pathExists(frame_path)) frames.push((await fs.readFile(frame_path)).toString('base64'));
    }
    return frames;
}

async function transcribeFile(file, settings, options, signal) {
    const before = await fs.stat(file.path);
    const {metadata} = await readMetadata(file);
    const probe = await transcoding.probeMedia(file.path);
    if (!probe) throw new Error('Could not probe the media file.');
    const hears = settings.audio === true && probe.streams.some(stream => stream.codec_type === 'audio');
    const sees = settings.vision === true && options.visual_cues !== 'off'
        && probe.streams.some(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
    if (!hears && !sees) return 'skipped';
    const recipe = {model: settings.model, audio_style: hears ? options.speech : null, vision_style: sees ? options.visual_cues : 'off'};
    const existing = metadata.ytdl_material?.transcript;
    if (validTranscript(existing) && sameMedia(before, existing.source) && sameRecipe(existing, recipe)) return 'skipped';
    const duration = Number(probe.format.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error('The media duration is unavailable.');
    const style = hears ? options.speech : options.visual_cues;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ytdl-transcription-'));
    try {
        const segments = [];
        let length = 0;
        let previous = '';
        for (let start = 0; start < duration; start += STRETCH_SECONDS) {
            signal.throwIfAborted();
            if (!utils.isServableMediaFile(file.path, file.user_uid)) throw new Error('Media is no longer available.');
            const seconds = Math.min(STRETCH_SECONDS, duration - start);
            const content = [];
            if (hears) content.push({type: 'input_audio', input_audio: {data: await extractAudio(file.path, start, seconds, directory, signal), format: 'wav'}});
            const frames = sees ? await extractFrames(file.path, start, seconds, directory, signal) : [];
            for (const frame of frames) content.push({type: 'image_url', image_url: {url: `data:image/jpeg;base64,${frame}`}});
            // The video can end before the sound does.
            if (content.length === 0) continue;
            content.push({type: 'text', text: buildPrompt({speech: hears ? options.speech : null,
                visual_cues: frames.length > 0 ? options.visual_cues : null, frames: frames.length, previous})});
            const text = await ai.chat(settings, [{role: 'system', content: SYSTEM_PROMPT}, {role: 'user', content}],
                {signal, temperature: style === 'novel' ? 0.7 : 0.2});
            length += text.length + 2;
            if (length > MAX_TEXT_LENGTH) throw new Error('The transcript exceeds the storage limit.');
            segments.push({start, end: start + seconds, text});
            if (text) previous = tail(`${previous} ${text}`);
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
            version: 1, text: segments.map(segment => segment.text).filter(Boolean).join('\n\n'), segments,
            ...recipe, created_at: new Date().toISOString(),
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
    const task = await db.getRecord('tasks', {key: TASK_KEY});
    const options = readOptions(task?.options);
    if (!settings.model?.trim()) throw new Error('Choose a model in Settings → Advanced → Local AI before running Auto-transcribe.');
    if (settings.audio !== true && !(settings.vision === true && options.visual_cues !== 'off')) {
        throw new Error('Auto-transcribe has nothing to send the model. Turn on Audio for it in Settings → Advanced, or Vision there and Visual cues in this task\'s options.');
    }
    const controller = new AbortController();
    // Saving any AI setting stops the old run, including disabling then quickly re-enabling.
    const subscription = config.config_updated.pipe(skip(1)).subscribe(change => {
        if (change?.key === 'ai' || change?.key?.startsWith('ytdl_ai_')) controller.abort();
    });
    const result = {transcribed: 0, skipped: 0, failed: 0};
    try {
        const files = [...await db.getRecords('files')];
        // Retry failures after untouched files, oldest attempt first, so a bad recording
        // cannot consume every limited run and prevent the rest of the library progressing.
        files.sort((a, b) => (a.transcription_failed_at || 0) - (b.transcription_failed_at || 0));
        for (const file of files) {
            if (controller.signal.aborted) break;
            if (result.transcribed + result.failed >= options.limit) break;
            try {
                result[await transcribeFile(file, settings, options, controller.signal)]++;
                if (file.transcription_failed_at) await db.updateRecord('files', {uid: file.uid}, {transcription_failed_at: null});
            } catch (error) {
                if (controller.signal.aborted) break;
                result.failed++;
                await db.updateRecord('files', {uid: file.uid}, {transcription_failed_at: Date.now()});
                logger.warn(`Auto-transcribe failed for file ${file.uid}: ${error.message}`);
            }
        }
        await db.updateRecord('tasks', {key: TASK_KEY}, {result});
        logger.info(`Auto-transcribe: ${result.transcribed} transcribed, ${result.skipped} skipped, ${result.failed} failed.`);
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
