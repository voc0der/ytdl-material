// The Auto-transcribe task. The model chosen in Settings → Advanced → Local AI listens to each
// library file 30 seconds at a time and writes up what it hears in the style the task's Speech
// option asks for. With a Whisper server set, Whisper writes down what is said instead, and
// the model writes from its words: Exact keeps them as they are, with no model needed. With
// Vision on and Visual cues chosen, the model also gets a few frames from each stretch and
// adds what they show. What is written is saved in the file's metadata sidecar. One file can
// also be transcribed on its own from its info dialog, the same way.
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
// Whisper makes up words for silence, such as a sign-off nobody said, so a stretch whose
// loudest sample stays under -50 dBFS is not sent to it.
const SILENCE_PEAK = Math.round(32768 * 10 ** (-50 / 20));
// Each file transcribed on its own runs beside the task, so only a few at once.
const MAX_FILE_JOBS = 3;
// How long the outcome of a file transcribed on its own is kept for its dialog: long enough for
// one left open in a background tab, whose timers run slowly.
const JOB_RETENTION_MS = 10 * 60 * 1000;
let activeRun = null;
// What is being transcribed now, by the task or on its own, by file uid, so no file is
// transcribed twice at once and its info dialog can say how far it has got. A file done on its
// own keeps how it went for a while; the task forgets each file as it finishes it.
const jobs = new Map();

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

// ...or about the words Whisper wrote down, when a Whisper server does the listening. Exact
// only gets here with frames to add. Descriptive also gets the sound, for what is not words.
const SPEECH_FROM_WORDS = {
    exact: 'Write out what is said exactly as speech recognition wrote it down.',
    brief: 'Sum up what is said in one or two sentences.',
    detailed: 'Write notes on what is said, covering every point in order.',
    descriptive: 'Write out what is said exactly as speech recognition wrote it down, and describe other sounds in the audio that matter, such as music, laughter or sound effects, in square brackets where they happen.',
    novel: 'Retell what happens as a passage from a novel, in the past tense, with what people say as quoted dialogue.'
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

// `words` is what Whisper wrote down for the stretch, or undefined when the model hears it.
function buildPrompt({speech, words, visual_cues, frames, previous}) {
    const lines = [];
    if (speech && words !== undefined) {
        lines.push(words ? `Speech recognition wrote down what is said in this stretch: "${words}"` : 'Speech recognition heard nothing said in this stretch.');
        lines.push(SPEECH_FROM_WORDS[speech]);
    } else if (speech) lines.push(SPEECH[speech]);
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

// A transcript made another way is made again: changing the model, the Whisper server's model
// or a style is a request for something different.
function sameRecipe(transcript, recipe) {
    return (transcript.model ?? null) === recipe.model
        && (transcript.whisper_model ?? null) === recipe.whisper_model
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
            return {...file, transcript: {text: transcript.text, model: transcript.model ?? null,
                whisper_model: transcript.whisper_model ?? null,
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

// A stretch of the first audio track as 16 kHz mono 16-bit PCM, about 1 MB for 30 seconds:
// as Whisper takes it, and inside a WAV header for the model.
async function extractAudio(media_path, start, seconds, directory, signal) {
    const audio_path = path.join(directory, 'audio.pcm');
    await runFile(ffmpeg(), [...inputArgs(media_path, start, seconds),
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 's16le', audio_path],
    {signal, timeout: 5 * 60 * 1000, maxBuffer: 1024 * 1024});
    return fs.readFile(audio_path);
}

function wav(pcm) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVEfmt ', 8, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(16000 * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}

function silent(pcm) {
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
        if (Math.abs(pcm.readInt16LE(offset)) > SILENCE_PEAK) return false;
    }
    return true;
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

// Why a file asked for on its own cannot be transcribed with the settings it was asked with.
function nothingToSend(sound, cues) {
    if (sound) return 'Nothing can hear this file\'s sound, and it has no picture to describe. Set a Whisper server or turn on Audio for the model in Settings → Advanced.';
    if (cues) return 'This file has no sound, and no picture to describe.';
    return 'This file has no sound. To describe what it shows instead, turn on Vision in Settings → Advanced and choose Visual cues in Auto-transcribe\'s options.';
}

// `whisper` is what the Whisper server runs, or null when the model does the listening. With
// `force`, as for a file asked for on its own, it is written again whatever is saved, and a
// file with nothing to send fails, saying why, rather than being skipped. `onProgress` is told
// the percentage done before each stretch.
async function transcribeFile(file, settings, options, whisper, signal, {force = false, onProgress} = {}) {
    const before = await fs.stat(file.path);
    const {metadata} = await readMetadata(file);
    const probe = await transcoding.probeMedia(file.path);
    if (!probe) throw new Error('Could not probe the media file.');
    const sound = probe.streams.some(stream => stream.codec_type === 'audio');
    const hears = sound && (whisper !== null || settings.audio === true);
    // With Whisper writing the words down, the model only hears the sound for Descriptive,
    // which also describes what is not words.
    const listens = sound && settings.audio === true && (whisper === null || options.speech === 'descriptive');
    const cues = settings.vision === true && options.visual_cues !== 'off';
    const sees = cues && probe.streams.some(stream => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
    if (!hears && !sees) {
        if (force) throw new Error(nothingToSend(sound, cues));
        return 'skipped';
    }
    const transcribes = hears && whisper !== null;
    // Whisper's words stand as they are for Exact. Everything else is written by the model.
    const writes = !transcribes || options.speech !== 'exact' || sees;
    const recipe = {model: writes ? settings.model : null, whisper_model: transcribes ? whisper.name : null,
        audio_style: hears ? options.speech : null, vision_style: sees ? options.visual_cues : 'off'};
    const existing = metadata.ytdl_material?.transcript;
    if (!force && validTranscript(existing) && sameMedia(before, existing.source) && sameRecipe(existing, recipe)) return 'skipped';
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
            onProgress?.(Math.floor(start / duration * 100));
            if (!utils.isServableMediaFile(file.path, file.user_uid)) throw new Error('Media is no longer available.');
            const seconds = Math.min(STRETCH_SECONDS, duration - start);
            const pcm = hears ? await extractAudio(file.path, start, seconds, directory, signal) : null;
            const quiet = transcribes && silent(pcm);
            const words = transcribes ? (quiet ? '' : await ai.transcribeSpeech(settings, pcm, {signal})) : undefined;
            const content = [];
            if (listens && !quiet) content.push({type: 'input_audio', input_audio: {data: wav(pcm).toString('base64'), format: 'wav'}});
            const frames = sees ? await extractFrames(file.path, start, seconds, directory, signal) : [];
            for (const frame of frames) content.push({type: 'image_url', image_url: {url: `data:image/jpeg;base64,${frame}`}});
            let text = words ?? '';
            // With no sound or frames for the model, Whisper's words stand when they are to be
            // kept exactly, or when there are none to write from.
            if (content.length === 0 && (!transcribes || options.speech === 'exact' || !words)) {
                // The video can end before the sound does.
                if (!transcribes) continue;
            } else {
                content.push({type: 'text', text: buildPrompt({speech: hears ? options.speech : null, words,
                    visual_cues: frames.length > 0 ? options.visual_cues : null, frames: frames.length, previous})});
                text = await ai.chat(settings, [{role: 'system', content: SYSTEM_PROMPT}, {role: 'user', content}],
                    {signal, temperature: style === 'novel' ? 0.7 : 0.2});
            }
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

// The settings and the task's options, refused before any server is asked when they cannot
// work. Files transcribed on their own use the same options as the task.
async function prepare() {
    const settings = ai.settings();
    ai.validateSettings(settings);
    const task = await db.getRecord('tasks', {key: TASK_KEY});
    const options = readOptions(task?.options);
    const listening = Boolean(settings.whisper_url?.trim());
    const cues = settings.vision === true && options.visual_cues !== 'off';
    // Whisper on its own writes Exact transcripts. Anything else needs the model.
    if ((!listening || options.speech !== 'exact' || cues) && !settings.model?.trim()) {
        throw new Error(listening
            ? 'Choose a model in Settings → Advanced → Local AI to write in this style, or choose Exact in Auto-transcribe\'s options to keep what Whisper writes down.'
            : 'Choose a model in Settings → Advanced → Local AI before running Auto-transcribe.');
    }
    if (!listening && settings.audio !== true && !cues) {
        throw new Error('Auto-transcribe has nothing to send the model. Set a Whisper server or turn on Audio for the model in Settings → Advanced, or turn on Vision there and choose Visual cues in Auto-transcribe\'s options.');
    }
    if (listening && options.speech === 'descriptive' && settings.audio !== true) {
        throw new Error('Descriptive also describes sounds that are not words, which Whisper does not write down. Turn on Audio for a model that can hear in Settings → Advanced, or choose another Speech style.');
    }
    return {settings, options, listening};
}

// Saving any AI setting stops work under way, including disabling then quickly re-enabling.
function stopOnSettingsChange(controller) {
    return config.config_updated.pipe(skip(1)).subscribe(change => {
        if (change?.key === 'ai' || change?.key?.startsWith('ytdl_ai_')) controller.abort();
    });
}

async function run() {
    if (!ai.isEnabled()) return null;
    await db.updateRecord('tasks', {key: TASK_KEY}, {result: null});
    const {settings, options, listening} = await prepare();
    const controller = new AbortController();
    const subscription = stopOnSettingsChange(controller);
    const result = {transcribed: 0, skipped: 0, failed: 0};
    try {
        // Asked once a run, so a wrong address fails the run rather than every file, and so a
        // transcript records which model wrote it down.
        const whisper = listening ? await ai.describeWhisper(settings, {signal: controller.signal}) : null;
        const files = [...await db.getRecords('files')];
        // Retry failures after untouched files, oldest attempt first, so a bad recording
        // cannot consume every limited run and prevent the rest of the library progressing.
        files.sort((a, b) => (a.transcription_failed_at || 0) - (b.transcription_failed_at || 0));
        for (const file of files) {
            if (controller.signal.aborted) break;
            if (result.transcribed + result.failed >= options.limit) break;
            // A file being transcribed on its own is left to that.
            if (jobs.get(file.uid)?.status === 'transcribing') {
                result.skipped++;
                continue;
            }
            const job = {status: 'transcribing', percent: 0};
            jobs.set(file.uid, job);
            try {
                result[await transcribeFile(file, settings, options, whisper, controller.signal, {onProgress: percent => { job.percent = percent; }})]++;
                if (file.transcription_failed_at) await db.updateRecord('files', {uid: file.uid}, {transcription_failed_at: null});
            } catch (error) {
                if (controller.signal.aborted) break;
                result.failed++;
                await db.updateRecord('files', {uid: file.uid}, {transcription_failed_at: Date.now()});
                logger.warn(`Auto-transcribe failed for file ${file.uid}: ${error.message}`);
            } finally {
                if (jobs.get(file.uid) === job) jobs.delete(file.uid);
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

// Forgets how files transcribed on their own went, once their dialogs have had time to ask.
function pruneJobs() {
    const now = Date.now();
    for (const [uid, job] of jobs) {
        if (job.finished && now - job.finished > JOB_RETENTION_MS) jobs.delete(uid);
    }
}

// Never rejects: nobody waits on it but a test, and how it went is kept on the job.
async function transcribeOnItsOwn(file, {settings, options, listening}, job) {
    const controller = new AbortController();
    const subscription = stopOnSettingsChange(controller);
    try {
        const whisper = listening ? await ai.describeWhisper(settings, {signal: controller.signal}) : null;
        await transcribeFile(file, settings, options, whisper, controller.signal, {force: true, onProgress: percent => { job.percent = percent; }});
        Object.assign(job, {status: 'complete', percent: 100});
        logger.info(`Transcribed file ${file.uid}.`);
    } catch (error) {
        const reason = controller.signal.aborted ? 'Transcription stopped because AI settings changed.' : error.message;
        Object.assign(job, {status: 'failed', error: reason});
        logger.warn(`Could not transcribe file ${file.uid}: ${reason}`);
    } finally {
        job.finished = Date.now();
        subscription.unsubscribe();
    }
}

/**
 * Transcribes one file on its own, from its info dialog, with the task's options, writing it
 * again whatever is saved. Resolves as soon as it has started, with `finished` for the work
 * itself; getStatus says how it goes. Refuses, saying why, before anything is sent anywhere:
 * while AI is off or the file is already being transcribed, and with settings the task could
 * not run with either.
 */
exports.transcribe = async (file) => {
    if (!ai.isEnabled()) throw new Error('AI integration is disabled.');
    pruneJobs();
    if (jobs.get(file.uid)?.status === 'transcribing') throw new Error('This file is already being transcribed.');
    if ([...jobs.values()].filter(job => job.own && job.status === 'transcribing').length >= MAX_FILE_JOBS) {
        throw new Error('Too many files are being transcribed at once. Try again when one finishes.');
    }
    // Claimed before anything is awaited, so asking twice cannot start it twice.
    const job = {status: 'transcribing', percent: 0, own: true};
    jobs.set(file.uid, job);
    let prepared;
    try {
        prepared = await prepare();
    } catch (error) {
        jobs.delete(file.uid);
        throw error;
    }
    return {finished: transcribeOnItsOwn(file, prepared, job)};
};

// How the transcription of a file is going, by the task or on its own, or null when none is
// under way or recently finished.
exports.getStatus = (uid) => {
    pruneJobs();
    const job = jobs.get(uid);
    return job ? {status: job.status, percent: job.percent, error: job.error ?? null} : null;
};
