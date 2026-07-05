// renderSummary.js
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { v4: uuidv4 } = require('uuid');

const execFileAsync = promisify(execFile);

/* ─────────── ENV ─────────── */

const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY || '';
const RENDER_INTERNAL_SECRET = process.env.RENDER_INTERNAL_SECRET || '';

// שומר תאימות לקוד הקיים שלך, אבל מאפשר להחליף דומיין בעתיד בלי שינוי קוד
const BASE44_APP_DOMAIN =
  process.env.BASE44_APP_DOMAIN || 'herut-football-6798c5e8.base44.app';

const SUMMARY_UPLOAD_FUNCTION_URL =
  `https://${BASE44_APP_DOMAIN}/api/apps/${BASE44_APP_ID}/functions/uploadSummaryVideo`;

/* ─────────── Defaults ─────────── */

const DEFAULT_CUT_BEFORE_SECONDS = 5;
const DEFAULT_CUT_AFTER_SECONDS = 1;
const DEFAULT_INTRO_DURATION = 3;
const DEFAULT_OUTRO_DURATION = 3;
const DEFAULT_MUSIC_VOLUME = 0.3;

const OUTPUT_WIDTH = 640;
const OUTPUT_HEIGHT = 480;
const OUTPUT_FPS = 30;

/* ─────────── small helpers ─────────── */

function ensureEnvForUpload() {
  if (!BASE44_APP_ID) {
    throw new Error('Missing BASE44_APP_ID in environment variables');
  }

  if (!RENDER_INTERNAL_SECRET) {
    throw new Error('Missing RENDER_INTERNAL_SECRET in environment variables');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getExtFromUrl(url, fallbackExt) {
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname);
    return ext || fallbackExt;
  } catch (_) {
    return fallbackExt;
  }
}

function escapeConcatPath(filePath) {
  // temp paths are normally safe, but keep this compatible with ffmpeg concat demuxer
  return filePath.replace(/'/g, "'\\''");
}

async function runFfmpeg(args, label) {
  try {
    await execFileAsync('ffmpeg', args, {
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const stderr = error.stderr || '';
    const compactStderr = stderr.length > 2500
      ? `${stderr.slice(0, 2500)}...`
      : stderr;

    throw new Error(`${label} failed: ${compactStderr || error.message}`);
  }
}

async function runFfprobe(args, label) {
  try {
    const result = await execFileAsync('ffprobe', args, {
      maxBuffer: 5 * 1024 * 1024
    });

    return result.stdout || '';
  } catch (error) {
    const stderr = error.stderr || '';
    throw new Error(`${label} failed: ${stderr || error.message}`);
  }
}

async function downloadToFile(url, outputPath) {
  if (!url) {
    throw new Error('downloadToFile called without url');
  }

  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} ${url}`);
  }

  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(outputPath)
  );

  const stat = await fsp.stat(outputPath);

  if (!stat.size) {
    throw new Error(`Downloaded file is empty: ${url}`);
  }
}

async function getMediaDuration(filePath) {
  try {
    const stdout = await runFfprobe([
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ], 'ffprobe duration');

    const duration = Number(stdout.trim());
    return Number.isFinite(duration) ? duration : null;
  } catch (_) {
    return null;
  }
}

async function hasAudioStream(filePath) {
  try {
    const stdout = await runFfprobe([
      '-v', 'error',
      '-select_streams', 'a:0',
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      filePath
    ], 'ffprobe audio');

    return Boolean(stdout.trim());
  } catch (_) {
    return false;
  }
}

function getVideoFilter({ zoomEnabled, zoomFocus, slowMotion }) {
  const filters = [];

  if (zoomEnabled && zoomFocus && zoomFocus !== 'none') {
    if (zoomFocus === 'left') {
      filters.push('crop=iw/2:ih:0:0');
    } else if (zoomFocus === 'right') {
      filters.push('crop=iw/2:ih:iw/2:0');
    } else if (zoomFocus === 'center') {
      filters.push('crop=iw/2:ih:iw/4:0');
    }
  }

  filters.push(`scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`);
  filters.push(`pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`);
  filters.push('setsar=1');

  if (slowMotion) {
    filters.push('setpts=2.0*PTS');
  }

  filters.push(`fps=${OUTPUT_FPS}`);

  return filters.join(',');
}

function getImageVideoFilter() {
  return [
    `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${OUTPUT_FPS}`
  ].join(',');
}

/* ─────────── Base44 upload callbacks ─────────── */

async function uploadSummarySuccessToBase44({ jobId, filePath }) {
  ensureEnvForUpload();

  const fileBuffer = await fsp.readFile(filePath);
  const form = new FormData();

  const blob = new Blob([fileBuffer], { type: 'video/mp4' });

  form.append('file', blob, `summary_${jobId}.mp4`);
  form.append('job_id', jobId);

  const headers = {
    'x-api-key': RENDER_INTERNAL_SECRET
  };

  // לא חובה לפי Base44, אבל לא מזיק ושומר תאימות לקוד הקיים שלך
  if (BASE44_API_KEY) {
    headers.api_key = BASE44_API_KEY;
  }

  const response = await fetch(SUMMARY_UPLOAD_FUNCTION_URL, {
    method: 'POST',
    headers,
    body: form
  });

  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`uploadSummaryVideo success upload failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

async function uploadSummaryFailureToBase44({ jobId, errorMessage }) {
  ensureEnvForUpload();

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': RENDER_INTERNAL_SECRET
  };

  if (BASE44_API_KEY) {
    headers.api_key = BASE44_API_KEY;
  }

  const response = await fetch(SUMMARY_UPLOAD_FUNCTION_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      job_id: jobId,
      error: errorMessage || 'Unknown render-summary error'
    })
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`uploadSummaryVideo failure callback failed: ${response.status} ${text}`);
  }

  return text;
}

/* ─────────── segment creation ─────────── */

async function createImageSegment({
  imagePath,
  duration,
  outputPath
}) {
  const segmentDuration = Math.max(0.5, safeNumber(duration, DEFAULT_INTRO_DURATION));

  await runFfmpeg([
    '-y',
    '-loop', '1',
    '-t', String(segmentDuration),
    '-i', imagePath,
    '-f', 'lavfi',
    '-t', String(segmentDuration),
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-vf', getImageVideoFilter(),
    '-r', String(OUTPUT_FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    outputPath
  ], 'create image segment');
}

async function createClipSegment({
  inputPath,
  clip,
  outputPath,
  config,
  slowMotion,
  zoomEnabled
}) {
  const cutBefore = Math.max(
    0,
    safeNumber(config.cut_before_seconds, DEFAULT_CUT_BEFORE_SECONDS)
  );

  const cutAfter = Math.max(
    0.1,
    safeNumber(config.cut_after_seconds, DEFAULT_CUT_AFTER_SECONDS)
  );

  const requestedCutDuration = cutBefore + cutAfter;
  const inputDuration = await getMediaDuration(inputPath);

  const actionSecondRaw = clip.action_second;
  const actionSecond =
    actionSecondRaw === null || actionSecondRaw === undefined
      ? null
      : safeNumber(actionSecondRaw, null);

  let cutStart = 0;
  let cutDuration = requestedCutDuration;

  if (actionSecond !== null && actionSecond !== undefined) {
    cutStart = Math.max(0, actionSecond - cutBefore);
  }

  /*
    הגנה למקרה ש-action_second הגיע בטעות בזמן משחק מלא,
    אבל הקליפ עצמו הוא כבר קליפ קצר.
    במקום להפיל את כל הסיכום, נשתמש מתחילת הקליפ.
  */
  if (inputDuration && cutStart >= inputDuration - 0.2) {
    console.warn('[SUMMARY CLIP WINDOW FALLBACK]', {
      input_duration: inputDuration,
      requested_action_second: actionSecond,
      requested_cut_start: cutStart,
      fallback_cut_start: 0
    });

    cutStart = 0;
  }

  if (inputDuration) {
    const remaining = Math.max(0.2, inputDuration - cutStart);
    cutDuration = Math.min(requestedCutDuration, remaining);
  }

  const inputHasAudio = await hasAudioStream(inputPath);
  const outputDurationForSilentAudio = slowMotion ? cutDuration * 2 : cutDuration;

  const videoFilter = getVideoFilter({
    zoomEnabled,
    zoomFocus: clip.zoom_focus || 'none',
    slowMotion
  });

  const args = [
    '-y',
    '-ss', String(cutStart),
    '-t', String(cutDuration),
    '-i', inputPath
  ];

  if (!inputHasAudio) {
    args.push(
      '-f', 'lavfi',
      '-t', String(outputDurationForSilentAudio),
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'
    );
  }

  args.push(
    '-map', '0:v:0',
    '-map', inputHasAudio ? '0:a:0' : '1:a:0',
    '-vf', videoFilter
  );

  if (inputHasAudio) {
    args.push(
      '-af',
      slowMotion ? 'atempo=0.5,aresample=44100' : 'aresample=44100'
    );
  }

  args.push(
    '-r', String(OUTPUT_FPS),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    outputPath
  );

  await runFfmpeg(args, 'create normalized clip segment');
}

async function concatSegments({ segmentPaths, outputPath, workDir }) {
  if (!segmentPaths.length) {
    throw new Error('No segments to concatenate');
  }

  if (segmentPaths.length === 1) {
    await fsp.copyFile(segmentPaths[0], outputPath);
    return;
  }

  const concatListPath = path.join(workDir, `summary_concat_${uuidv4()}.txt`);

  const concatText = segmentPaths
    .map(p => `file '${escapeConcatPath(p)}'`)
    .join('\n');

  await fsp.writeFile(concatListPath, concatText, 'utf8');

  await runFfmpeg([
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    outputPath
  ], 'concat summary segments');

  try {
    await fsp.unlink(concatListPath);
  } catch (_) {}
}

async function mixBackgroundMusic({
  inputVideoPath,
  musicPath,
  outputPath,
  musicVolume
}) {
  const volume = Math.max(0, Math.min(1, safeNumber(musicVolume, DEFAULT_MUSIC_VOLUME)));

  await runFfmpeg([
    '-y',
    '-i', inputVideoPath,
    '-stream_loop', '-1',
    '-i', musicPath,
    '-filter_complex',
    `[1:a]volume=${volume}[music];[0:a][music]amix=inputs=2:duration=first:dropout_transition=2[a]`,
    '-map', '0:v:0',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-ac', '2',
    '-shortest',
    '-movflags', '+faststart',
    outputPath
  ], 'mix background music');
}

/* ─────────── main job ─────────── */

async function processSummaryJob(payload) {
  const jobId = payload.job_id;
  const clips = Array.isArray(payload.clips) ? payload.clips : [];
  const config = payload.config || {};

  const workDir = path.join(os.tmpdir(), `summary-${jobId}-${uuidv4()}`);

  try {
    await ensureDir(workDir);

    console.log('[SUMMARY JOB START]', {
      job_id: jobId,
      clips_count: clips.length,
      slow_motion: Boolean(payload.slow_motion),
      zoom_enabled: Boolean(payload.zoom_enabled),
      has_music: Boolean(config.music_url),
      has_intro: Boolean(config.intro_image_url),
      has_outro: Boolean(config.outro_image_url)
    });

    const segmentPaths = [];

    if (config.intro_image_url) {
      const ext = getExtFromUrl(config.intro_image_url, '.jpg');
      const introImagePath = path.join(workDir, `intro_image${ext}`);
      const introSegmentPath = path.join(workDir, '000_intro.mp4');

      await downloadToFile(config.intro_image_url, introImagePath);

      await createImageSegment({
        imagePath: introImagePath,
        duration: safeNumber(config.intro_duration, DEFAULT_INTRO_DURATION),
        outputPath: introSegmentPath
      });

      segmentPaths.push(introSegmentPath);
    }

    for (let i = 0; i < clips.length; i += 1) {
      const clip = clips[i];

      if (!clip || !clip.url) {
        throw new Error(`Clip ${i + 1} is missing url`);
      }

      const inputExt = getExtFromUrl(clip.url, '.webm');
      const inputPath = path.join(workDir, `clip_${String(i).padStart(3, '0')}_input${inputExt}`);
      const outputPath = path.join(workDir, `clip_${String(i).padStart(3, '0')}_normalized.mp4`);

      console.log('[SUMMARY CLIP START]', {
        job_id: jobId,
        index: i,
        action_second: clip.action_second,
        zoom_focus: clip.zoom_focus || 'none'
      });

      await downloadToFile(clip.url, inputPath);

      await createClipSegment({
        inputPath,
        clip,
        outputPath,
        config,
        slowMotion: Boolean(payload.slow_motion),
        zoomEnabled: Boolean(payload.zoom_enabled)
      });

      segmentPaths.push(outputPath);

      console.log('[SUMMARY CLIP DONE]', {
        job_id: jobId,
        index: i,
        output_path: outputPath
      });
    }

    if (config.outro_image_url) {
      const ext = getExtFromUrl(config.outro_image_url, '.jpg');
      const outroImagePath = path.join(workDir, `outro_image${ext}`);
      const outroSegmentPath = path.join(workDir, '999_outro.mp4');

      await downloadToFile(config.outro_image_url, outroImagePath);

      await createImageSegment({
        imagePath: outroImagePath,
        duration: safeNumber(config.outro_duration, DEFAULT_OUTRO_DURATION),
        outputPath: outroSegmentPath
      });

      segmentPaths.push(outroSegmentPath);
    }

    if (!segmentPaths.length) {
      throw new Error('No clips or intro/outro segments were provided');
    }

    const summaryWithoutMusicPath = path.join(workDir, `summary_${jobId}_no_music.mp4`);
    const finalSummaryPath = path.join(workDir, `summary_${jobId}.mp4`);

    await concatSegments({
      segmentPaths,
      outputPath: summaryWithoutMusicPath,
      workDir
    });

    if (config.music_url) {
      const musicExt = getExtFromUrl(config.music_url, '.mp3');
      const musicPath = path.join(workDir, `music${musicExt}`);

      await downloadToFile(config.music_url, musicPath);

      await mixBackgroundMusic({
        inputVideoPath: summaryWithoutMusicPath,
        musicPath,
        outputPath: finalSummaryPath,
        musicVolume: config.music_volume
      });
    } else {
      await fsp.copyFile(summaryWithoutMusicPath, finalSummaryPath);
    }

    const uploadResult = await uploadSummarySuccessToBase44({
      jobId,
      filePath: finalSummaryPath
    });

    console.log('[SUMMARY JOB SUCCESS]', {
      job_id: jobId,
      upload_result: uploadResult
    });
  } catch (error) {
    console.error('[SUMMARY JOB FAILED]', {
      job_id: jobId,
      error: error.message
    });

    try {
      await uploadSummaryFailureToBase44({
        jobId,
        errorMessage: error.message
      });
    } catch (callbackError) {
      console.error('[SUMMARY FAILURE CALLBACK FAILED]', {
        job_id: jobId,
        error: callbackError.message
      });
    }
  } finally {
    try {
      await fsp.rm(workDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

/* ─────────── route registration ─────────── */

function registerRenderSummaryRoute(app) {
  app.post('/render-summary', async (req, res) => {
    try {
      const providedSecret = req.headers['x-api-key'] || '';

      if (RENDER_INTERNAL_SECRET && providedSecret !== RENDER_INTERNAL_SECRET) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });
      }

      const payload = req.body || {};
      const jobId = payload.job_id;
      const clips = Array.isArray(payload.clips) ? payload.clips : [];

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: 'job_id is required'
        });
      }

      if (!clips.length && !payload.config?.intro_image_url && !payload.config?.outro_image_url) {
        return res.status(400).json({
          success: false,
          error: 'clips array is required unless intro/outro is provided'
        });
      }

      console.log('[SUMMARY JOB ACCEPTED]', {
        job_id: jobId,
        clips_count: clips.length
      });

      res.status(202).json({
        success: true,
        accepted: true,
        job_id: jobId
      });

      setImmediate(() => {
        processSummaryJob(payload).catch(error => {
          console.error('[SUMMARY JOB UNHANDLED ERROR]', {
            job_id: jobId,
            error: error.message
          });
        });
      });
    } catch (error) {
      console.error('[RENDER SUMMARY ROUTE]', error);

      return res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });
}

module.exports = {
  registerRenderSummaryRoute
};
