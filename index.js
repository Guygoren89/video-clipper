/* index.js – SERVER */
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');

const {
  uploadToDrive,
  cutClipFromDriveFile
} = require('./segmentsManager');

const {
  saveIncomingSegment,
  pruneOldSegments,
  getSegmentsForClip
} = require('./bufferManager');

const execFileAsync = promisify(execFile);

/* ─────────── ENV ─────────── */
const BASE44_APP_ID = process.env.BASE44_APP_ID;
const BASE44_API_KEY = process.env.BASE44_API_KEY;
const BUFFER_WINDOW_SECONDS = Number(process.env.BUFFER_WINDOW_SECONDS || 300);
const RENDER_INTERNAL_SECRET = process.env.RENDER_INTERNAL_SECRET || '';
const BASE44_APP_DOMAIN = process.env.BASE44_APP_DOMAIN || 'herut-football-6798c5e8.base44.app';

/* ─────────── Google Drive ─────────── */
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive']
});
const drive = google.drive({ version: 'v3', auth });

const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';
const FULL_CLIPS_FOLDER_ID = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';

/* ─────────── חיתוך ─────────── */
/*
  חלון חיתוך חדש:
  הקליפ מתחיל 10 שניות לפני זמן השער
  ונמשך 14 שניות, כלומר מסתיים 4 שניות אחרי זמן השער.
*/
const BACKWARD_OFFSET_SEC = 10;
const CLIP_DURATION_SEC = 14;

/* ─────────── Retries ─────────── */
const SEGMENT_COVERAGE_MAX_ATTEMPTS = 4;
const SEGMENT_COVERAGE_RETRY_DELAY_MS = 7000;
const SEGMENT_COVERAGE_TOLERANCE_SEC = 1.5;

const UPLOAD_TO_BASE44_MAX_ATTEMPTS = 3;
const UPLOAD_TO_BASE44_RETRY_DELAY_MS = 2500;

/* helper */
function toSeconds(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.includes(':')) return v.split(':').map(Number).reduce((t, n) => t * 60 + n, 0);
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureBase44Env() {
  if (!BASE44_APP_ID || !BASE44_API_KEY) {
    throw new Error('Missing BASE44_APP_ID or BASE44_API_KEY in environment variables');
  }
}

async function callBase44Function(functionName, payload, extraHeaders = {}) {
  ensureBase44Env();

  const response = await fetch(
    `https://${BASE44_APP_DOMAIN}/api/apps/${BASE44_APP_ID}/functions/${functionName}`,
    {
      method: 'POST',
      headers: {
        api_key: BASE44_API_KEY,
        'Content-Type': 'application/json',
        'x-api-key': RENDER_INTERNAL_SECRET,
        ...extraHeaders
      },
      body: JSON.stringify(payload || {})
    }
  );

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(`Invalid JSON from Base44 function ${functionName}: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`Base44 function ${functionName} failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return data;
}

function getTargetCamera(teamSides, goal, game) {
  if (!teamSides || !teamSides.left || !teamSides.right) {
    throw new Error('team_sides missing or incomplete');
  }

  const scoringTeamColor = goal.team === 'team1' ? game.team1 : game.team2;

  let scoringSide = null;
  if (teamSides.left === scoringTeamColor) scoringSide = 'left';
  if (teamSides.right === scoringTeamColor) scoringSide = 'right';

  if (!scoringSide) {
    throw new Error(`Could not determine scoring side. goal.team=${goal.team}, scoringTeamColor=${scoringTeamColor}, teamSides=${JSON.stringify(teamSides)}`);
  }

  const targetCamera = scoringSide === 'left' ? 'right' : 'left';

  console.log('[CAMERA SELECT]', {
    goal_id: goal.id,
    goal_team: goal.team,
    scoring_team_color: scoringTeamColor,
    team_sides: teamSides,
    scoring_side: scoringSide,
    target_camera: targetCamera
  });

  return targetCamera;
}

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function getClipCoverageStatus({ segments, clipStart, clipEnd }) {
  const sorted = [...segments].sort((a, b) => Number(a.segment_start_time) - Number(b.segment_start_time));

  if (!sorted.length) {
    return {
      complete: false,
      reason: 'no_segments',
      coverage_end: null,
      gap_at: clipStart
    };
  }

  let coveredUntil = Number(clipStart);

  for (const segment of sorted) {
    const segmentStart = Number(segment.segment_start_time || 0);
    const segmentDuration = Number(segment.duration || 0);
    const segmentEnd = segmentStart + segmentDuration;

    if (segmentEnd <= coveredUntil) {
      continue;
    }

    if (segmentStart > coveredUntil + SEGMENT_COVERAGE_TOLERANCE_SEC) {
      return {
        complete: false,
        reason: 'gap_before_segment',
        coverage_end: coveredUntil,
        gap_at: segmentStart
      };
    }

    coveredUntil = Math.max(coveredUntil, segmentEnd);

    if (coveredUntil + SEGMENT_COVERAGE_TOLERANCE_SEC >= clipEnd) {
      return {
        complete: true,
        reason: 'covered',
        coverage_end: coveredUntil,
        gap_at: null
      };
    }
  }

  return {
    complete: false,
    reason: 'not_enough_coverage',
    coverage_end: coveredUntil,
    gap_at: clipEnd
  };
}

async function getSegmentsForClipWithRetry({ matchId, cameraId, clipStart, clipEnd, goalId }) {
  let lastSegments = [];
  let lastCoverage = null;

  for (let attempt = 1; attempt <= SEGMENT_COVERAGE_MAX_ATTEMPTS; attempt += 1) {
    const segments = await getSegmentsForClip({
      matchId,
      cameraId,
      clipStart,
      clipEnd
    });

    const coverage = getClipCoverageStatus({
      segments,
      clipStart,
      clipEnd
    });

    console.log('[SEGMENTS COVERAGE CHECK]', {
      goal_id: goalId,
      attempt,
      target_camera: cameraId,
      clip_start: clipStart,
      clip_end: clipEnd,
      count: segments.length,
      complete: coverage.complete,
      reason: coverage.reason,
      coverage_end: coverage.coverage_end,
      segments: segments.map(s => ({
        filename: s.filename,
        segment_start_time: s.segment_start_time,
        duration: s.duration
      }))
    });

    lastSegments = segments;
    lastCoverage = coverage;

    if (coverage.complete) {
      return {
        segments,
        coverage
      };
    }

    if (attempt < SEGMENT_COVERAGE_MAX_ATTEMPTS) {
      await sleep(SEGMENT_COVERAGE_RETRY_DELAY_MS);
    }
  }

  return {
    segments: lastSegments,
    coverage: lastCoverage
  };
}

async function concatAndTrimSegments({ segmentPaths, trimStart, outputPath }) {
  if (!segmentPaths || segmentPaths.length === 0) {
    throw new Error('No segment paths provided');
  }

  if (segmentPaths.length === 1) {
    await execFileAsync('ffmpeg', [
      '-y',
      '-ss', String(trimStart),
      '-i', segmentPaths[0],
      '-t', String(CLIP_DURATION_SEC),
      '-c', 'copy',
      outputPath
    ]);
    return;
  }

  const workDir = path.dirname(outputPath);
  const concatListPath = path.join(workDir, `concat_${uuidv4()}.txt`);
  const mergedPath = path.join(workDir, `merged_${uuidv4()}.webm`);

  const concatText = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');

  await fsp.writeFile(concatListPath, concatText, 'utf8');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatListPath,
    '-c', 'copy',
    mergedPath
  ]);

  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', String(trimStart),
    '-i', mergedPath,
    '-t', String(CLIP_DURATION_SEC),
    '-c', 'copy',
    outputPath
  ]);

  try { await fsp.unlink(concatListPath); } catch (_) {}
  try { await fsp.unlink(mergedPath); } catch (_) {}
}

async function uploadProcessedClipToBase44({ goalId, filePath }) {
  ensureBase44Env();

  const fileBuffer = await fsp.readFile(filePath);
  let lastError = null;

  for (let attempt = 1; attempt <= UPLOAD_TO_BASE44_MAX_ATTEMPTS; attempt += 1) {
    try {
      const form = new FormData();
      const file = new Blob([fileBuffer], { type: 'video/webm' });

      form.append('file', file, `goal_${goalId}.webm`);
      form.append('goal_id', goalId);

      console.log('[UPLOAD TO BASE44 START]', {
        goal_id: goalId,
        attempt,
        file_size: fileBuffer.length
      });

      const response = await fetch(
        `https://${BASE44_APP_DOMAIN}/api/apps/${BASE44_APP_ID}/functions/uploadProcessedClip`,
        {
          method: 'POST',
          headers: {
            api_key: BASE44_API_KEY,
            'x-api-key': RENDER_INTERNAL_SECRET
          },
          body: form
        }
      );

      const text = await response.text();

      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        throw new Error(`Invalid JSON from uploadProcessedClip: ${text}`);
      }

      if (!response.ok) {
        throw new Error(`uploadProcessedClip failed: ${response.status} ${JSON.stringify(data)}`);
      }

      console.log('[UPLOAD TO BASE44 SUCCESS]', {
        goal_id: goalId,
        attempt,
        file_uri: data.file_uri
      });

      return data;
    } catch (error) {
      lastError = error;

      console.error('[UPLOAD TO BASE44 ATTEMPT FAILED]', {
        goal_id: goalId,
        attempt,
        error: error.message
      });

      if (attempt < UPLOAD_TO_BASE44_MAX_ATTEMPTS) {
        await sleep(UPLOAD_TO_BASE44_RETRY_DELAY_MS);
      }
    }
  }

  throw lastError || new Error('uploadProcessedClip failed after retries');
}


/* ─────────── Render Summary Video ─────────── */

const SUMMARY_OUTPUT_WIDTH = 640;
const SUMMARY_OUTPUT_HEIGHT = 480;
const SUMMARY_OUTPUT_FPS = 30;

const SUMMARY_DEFAULT_CUT_BEFORE_SECONDS = 5;
const SUMMARY_DEFAULT_CUT_AFTER_SECONDS = 1;
const SUMMARY_DEFAULT_INTRO_DURATION = 3;
const SUMMARY_DEFAULT_OUTRO_DURATION = 3;
const SUMMARY_DEFAULT_MUSIC_VOLUME = 0.3;

/*
  במקרה שהקליפ שמגיע לסיכום הוא כבר קליפ קצר שהופק ב-/process-goal,
  רגע השער בדרך כלל נמצא 10 שניות מתחילת הקליפ.
*/
const SUMMARY_FALLBACK_ACTION_SECOND = BACKWARD_OFFSET_SEC;

function ensureSummaryUploadEnv() {
  if (!BASE44_APP_ID) {
    throw new Error('Missing BASE44_APP_ID in environment variables');
  }

  if (!RENDER_INTERNAL_SECRET) {
    throw new Error('Missing RENDER_INTERNAL_SECRET in environment variables');
  }
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
  return filePath.replace(/'/g, "'\\''");
}

async function runFfmpeg(args, label) {
  try {
    await execFileAsync('ffmpeg', args, {
      maxBuffer: 20 * 1024 * 1024
    });
  } catch (error) {
    const stderr = error.stderr || '';
    const compactStderr = stderr.length > 3000
      ? `${stderr.slice(0, 3000)}...`
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

async function downloadUrlToFile(url, outputPath) {
  if (!url) {
    throw new Error('downloadUrlToFile called without url');
  }

  const response = await fetch(url);

  if (!response.ok || !response.body) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(outputPath)
  );

  const stat = await fsp.stat(outputPath);

  if (!stat.size) {
    throw new Error('Downloaded file is empty');
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

function getSummaryVideoFilter({ zoomEnabled, zoomFocus, slowMotion }) {
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

  filters.push(`scale=${SUMMARY_OUTPUT_WIDTH}:${SUMMARY_OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`);
  filters.push(`pad=${SUMMARY_OUTPUT_WIDTH}:${SUMMARY_OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`);
  filters.push('setsar=1');

  if (slowMotion) {
    filters.push('setpts=2.0*PTS');
  }

  filters.push(`fps=${SUMMARY_OUTPUT_FPS}`);

  return filters.join(',');
}

function getSummaryImageFilter() {
  return [
    `scale=${SUMMARY_OUTPUT_WIDTH}:${SUMMARY_OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${SUMMARY_OUTPUT_WIDTH}:${SUMMARY_OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    'setsar=1',
    `fps=${SUMMARY_OUTPUT_FPS}`
  ].join(',');
}

async function uploadSummarySuccessToBase44({ jobId, filePath }) {
  ensureSummaryUploadEnv();

  const fileBuffer = await fsp.readFile(filePath);
  const form = new FormData();
  const file = new Blob([fileBuffer], { type: 'video/mp4' });

  form.append('file', file, `summary_${jobId}.mp4`);
  form.append('job_id', jobId);

  const headers = {
    'x-api-key': RENDER_INTERNAL_SECRET
  };

  if (BASE44_API_KEY) {
    headers.api_key = BASE44_API_KEY;
  }

  const response = await fetch(
    `https://${BASE44_APP_DOMAIN}/api/apps/${BASE44_APP_ID}/functions/uploadSummaryVideo`,
    {
      method: 'POST',
      headers,
      body: form
    }
  );

  const text = await response.text();

  let data;
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
  ensureSummaryUploadEnv();

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': RENDER_INTERNAL_SECRET
  };

  if (BASE44_API_KEY) {
    headers.api_key = BASE44_API_KEY;
  }

  const response = await fetch(
    `https://${BASE44_APP_DOMAIN}/api/apps/${BASE44_APP_ID}/functions/uploadSummaryVideo`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        job_id: jobId,
        error: errorMessage || 'Unknown render-summary error'
      })
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`uploadSummaryVideo failure callback failed: ${response.status} ${text}`);
  }

  return text;
}

async function createSummaryImageSegment({ imagePath, duration, outputPath }) {
  const segmentDuration = Math.max(
    0.5,
    safeNumber(duration, SUMMARY_DEFAULT_INTRO_DURATION)
  );

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
    '-vf', getSummaryImageFilter(),
    '-r', String(SUMMARY_OUTPUT_FPS),
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
  ], 'create summary image segment');
}

function getEffectiveActionSecond({ clip, inputDuration, cutBefore, cutAfter }) {
  const raw = clip.action_second;

  let actionSecond = raw === null || raw === undefined
    ? null
    : safeNumber(raw, null);

  if (actionSecond === null || actionSecond < 0) {
    if (inputDuration) {
      return Math.min(
        SUMMARY_FALLBACK_ACTION_SECOND,
        Math.max(cutBefore, inputDuration - cutAfter)
      );
    }

    return cutBefore;
  }

  /*
    אם Base44 שלח בטעות זמן משחק מלא במקום זמן בתוך הקליפ הקצר,
    משתמשים בהנחה שהשער נמצא 10 שניות מתחילת הקליפ שנוצר ב-/process-goal.
  */
  if (inputDuration && actionSecond > inputDuration + 0.2) {
    const fallback = Math.min(
      SUMMARY_FALLBACK_ACTION_SECOND,
      Math.max(cutBefore, inputDuration - cutAfter)
    );

    console.warn('[SUMMARY ACTION SECOND FALLBACK]', {
      input_duration: inputDuration,
      requested_action_second: actionSecond,
      fallback_action_second: fallback
    });

    return fallback;
  }

  return actionSecond;
}

async function createSummaryClipSegment({
  inputPath,
  clip,
  outputPath,
  config,
  slowMotion,
  zoomEnabled
}) {
  const cutBefore = Math.max(
    0,
    safeNumber(config.cut_before_seconds, SUMMARY_DEFAULT_CUT_BEFORE_SECONDS)
  );

  const cutAfter = Math.max(
    0.1,
    safeNumber(config.cut_after_seconds, SUMMARY_DEFAULT_CUT_AFTER_SECONDS)
  );

  const requestedCutDuration = cutBefore + cutAfter;
  const inputDuration = await getMediaDuration(inputPath);

  const effectiveActionSecond = getEffectiveActionSecond({
    clip,
    inputDuration,
    cutBefore,
    cutAfter
  });

  let cutStart = Math.max(0, effectiveActionSecond - cutBefore);
  let cutDuration = requestedCutDuration;

  if (inputDuration) {
    if (cutStart >= inputDuration - 0.2) {
      cutStart = Math.max(0, inputDuration - requestedCutDuration);
    }

    const remaining = Math.max(0.2, inputDuration - cutStart);
    cutDuration = Math.min(requestedCutDuration, remaining);
  }

  const inputHasAudio = await hasAudioStream(inputPath);
  const outputDurationForSilentAudio = slowMotion ? cutDuration * 2 : cutDuration;

  const videoFilter = getSummaryVideoFilter({
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
    '-r', String(SUMMARY_OUTPUT_FPS),
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

  console.log('[SUMMARY CLIP WINDOW]', {
    input_duration: inputDuration,
    effective_action_second: effectiveActionSecond,
    cut_start: cutStart,
    cut_duration: cutDuration,
    has_audio: inputHasAudio,
    slow_motion: Boolean(slowMotion),
    zoom_enabled: Boolean(zoomEnabled),
    zoom_focus: clip.zoom_focus || 'none'
  });

  await runFfmpeg(args, 'create normalized summary clip segment');
}

async function concatSummarySegments({ segmentPaths, outputPath, workDir }) {
  if (!segmentPaths.length) {
    throw new Error('No summary segments to concatenate');
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

  try { await fsp.unlink(concatListPath); } catch (_) {}
}

async function mixSummaryBackgroundMusic({
  inputVideoPath,
  musicPath,
  outputPath,
  musicVolume
}) {
  const volume = Math.max(
    0,
    Math.min(1, safeNumber(musicVolume, SUMMARY_DEFAULT_MUSIC_VOLUME))
  );

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
  ], 'mix summary background music');
}

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
      const introExt = getExtFromUrl(config.intro_image_url, '.jpg');
      const introImagePath = path.join(workDir, `intro_image${introExt}`);
      const introSegmentPath = path.join(workDir, '000_intro.mp4');

      await downloadUrlToFile(config.intro_image_url, introImagePath);

      await createSummaryImageSegment({
        imagePath: introImagePath,
        duration: safeNumber(config.intro_duration, SUMMARY_DEFAULT_INTRO_DURATION),
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

      await downloadUrlToFile(clip.url, inputPath);

      await createSummaryClipSegment({
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
      const outroExt = getExtFromUrl(config.outro_image_url, '.jpg');
      const outroImagePath = path.join(workDir, `outro_image${outroExt}`);
      const outroSegmentPath = path.join(workDir, '999_outro.mp4');

      await downloadUrlToFile(config.outro_image_url, outroImagePath);

      await createSummaryImageSegment({
        imagePath: outroImagePath,
        duration: safeNumber(config.outro_duration, SUMMARY_DEFAULT_OUTRO_DURATION),
        outputPath: outroSegmentPath
      });

      segmentPaths.push(outroSegmentPath);
    }

    if (!segmentPaths.length) {
      throw new Error('No clips or intro/outro segments were provided');
    }

    const summaryWithoutMusicPath = path.join(workDir, `summary_${jobId}_no_music.mp4`);
    const finalSummaryPath = path.join(workDir, `summary_${jobId}.mp4`);

    await concatSummarySegments({
      segmentPaths,
      outputPath: summaryWithoutMusicPath,
      workDir
    });

    if (config.music_url) {
      const musicExt = getExtFromUrl(config.music_url, '.mp3');
      const musicPath = path.join(workDir, `music${musicExt}`);

      await downloadUrlToFile(config.music_url, musicPath);

      await mixSummaryBackgroundMusic({
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

/* ───────────── app ───────────── */
const app = express();
const PORT = process.env.PORT || 3000;

/* Multer – כותבים ל-/tmp/uploads */
const uploadDir = path.join(os.tmpdir(), 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(cors());
app.use(express.json());

registerRenderSummaryRoute(app);

app.get('/health', (_, res) => res.json({
  ok: true,
  buffer_window_seconds: BUFFER_WINDOW_SECONDS
}));

/* ───── upload-segment-buffer (NEW) ───── */
app.post('/upload-segment-buffer', (req, res) => {
  upload.single('file')(req, res, async err => {
    if (err) {
      console.error('[MULTER BUFFER]', err);
      return res.status(400).json({ success: false, error: err.message });
    }

    try {
      const { file } = req;
      const {
        match_id,
        camera_id,
        segment_start_time = 0,
        duration = 20
      } = req.body;

      console.log('[SEGMENT UPLOAD RECEIVED]', {
        match_id,
        camera_id,
        segment_start_time,
        duration,
        file_size: file?.size
      });

      if (!file) {
        return res.status(400).json({ success: false, error: 'file is required' });
      }

      if (!match_id || !camera_id) {
        return res.status(400).json({
          success: false,
          error: 'match_id and camera_id are required'
        });
      }

      const saved = await saveIncomingSegment({
        tempFilePath: file.path,
        originalName: file.originalname || `segment_${Date.now()}.webm`,
        matchId: match_id,
        cameraId: camera_id,
        segmentStartTime: Number(segment_start_time || 0),
        duration: Number(duration || 20)
      });

      const pruneResult = await pruneOldSegments(
        match_id,
        camera_id,
        Number(segment_start_time || 0)
      );

      console.log('[SEGMENT BUFFERED]', {
        match_id,
        camera_id,
        segment_start_time: saved.segment_start_time,
        duration: saved.duration,
        filename: saved.filename,
        cleanup: pruneResult
      });

      fs.unlink(file.path, () => {});

      return res.json({
        success: true,
        buffered: true,
        segment: saved,
        cleanup: pruneResult
      });
    } catch (e) {
      console.error('[UPLOAD BUFFER]', e);
      return res.status(500).json({ success: false, error: e.message });
    }
  });
});

/* ───── process-goal (NEW) ───── */
app.post('/process-goal', async (req, res) => {
  try {
    const providedSecret = req.headers['x-api-key'] || '';
    if (RENDER_INTERNAL_SECRET && providedSecret !== RENDER_INTERNAL_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { goal_id } = req.body || {};
    console.log('[PROCESS GOAL START]', { goal_id });

    if (!goal_id) {
      return res.status(400).json({ success: false, error: 'goal_id is required' });
    }

    const fullData = await callBase44Function('getGoalFullData', { goal_id });
    const goal = fullData.goal;
    const game = fullData.game;
    const teamSides = fullData.team_sides;

    console.log('[GOAL DATA LOADED]', {
      goal_id,
      goal_team: goal?.team,
      goal_time: goal?.time,
      game_id: game?.id,
      game_team1: game?.team1,
      game_team2: game?.team2,
      team_sides: teamSides
    });

    if (!goal || !game) {
      return res.status(404).json({ success: false, error: 'Goal or Game not found' });
    }

    if (goal.video_clip_uri) {
      console.log('[PROCESS GOAL SKIPPED]', {
        goal_id,
        reason: 'already_has_clip',
        video_clip_uri: goal.video_clip_uri
      });
      return res.json({ success: true, skipped: true, reason: 'already_has_clip' });
    }

    const targetCamera = getTargetCamera(teamSides, goal, game);

    const goalTime = Number(goal.time || 0);
    const clipStart = Math.max(0, goalTime - BACKWARD_OFFSET_SEC);
    const clipEnd = clipStart + CLIP_DURATION_SEC;
    const secondsAfterGoal = clipEnd - goalTime;

    console.log('[CLIP WINDOW]', {
      goal_id,
      goal_time: goalTime,
      backward_offset_sec: BACKWARD_OFFSET_SEC,
      clip_duration_sec: CLIP_DURATION_SEC,
      clip_start: clipStart,
      clip_end: clipEnd,
      seconds_after_goal: secondsAfterGoal
    });

    const segmentResult = await getSegmentsForClipWithRetry({
      matchId: goal.game_id,
      cameraId: targetCamera,
      clipStart,
      clipEnd,
      goalId: goal_id
    });

    const relevantSegments = segmentResult.segments;
    const coverage = segmentResult.coverage;

    console.log('[SEGMENTS FOUND]', {
      goal_id,
      target_camera: targetCamera,
      clip_start: clipStart,
      clip_end: clipEnd,
      count: relevantSegments.length,
      coverage_complete: coverage?.complete,
      coverage_reason: coverage?.reason,
      coverage_end: coverage?.coverage_end,
      segments: relevantSegments.map(s => ({
        filename: s.filename,
        segment_start_time: s.segment_start_time,
        duration: s.duration
      }))
    });

    if (!relevantSegments.length) {
      return res.status(404).json({
        success: false,
        error: 'No buffered segments found for goal',
        goal_id,
        target_camera: targetCamera,
        clip_start: clipStart,
        clip_end: clipEnd
      });
    }

    if (!coverage || !coverage.complete) {
      return res.status(404).json({
        success: false,
        error: 'Buffered segments do not fully cover clip window',
        goal_id,
        target_camera: targetCamera,
        clip_start: clipStart,
        clip_end: clipEnd,
        coverage
      });
    }

    const tempWorkDir = path.join(os.tmpdir(), `goal-${goal_id}-${uuidv4()}`);
    await ensureDir(tempWorkDir);

    const outputPath = path.join(tempWorkDir, `goal_${goal_id}.webm`);
    const trimStart = Math.max(0, clipStart - Number(relevantSegments[0].segment_start_time || 0));
    const segmentPaths = relevantSegments.map((s) => s.path);

    console.log('[FFMPEG START]', {
      goal_id,
      target_camera: targetCamera,
      trim_start: trimStart,
      output_path: outputPath,
      segment_paths: segmentPaths
    });

    await concatAndTrimSegments({
      segmentPaths,
      trimStart,
      outputPath
    });

    console.log('[FFMPEG DONE]', {
      goal_id,
      output_path: outputPath
    });

    const uploadResult = await uploadProcessedClipToBase44({
      goalId: goal_id,
      filePath: outputPath
    });

    console.log('[PROCESS GOAL SUCCESS]', {
      goal_id,
      target_camera: targetCamera,
      upload_result: uploadResult
    });

    try {
      await fsp.rm(tempWorkDir, { recursive: true, force: true });
    } catch (_) {}

    return res.json({
      success: true,
      goal_id,
      target_camera: targetCamera,
      clip_start: clipStart,
      clip_end: clipEnd,
      coverage,
      segments_used: relevantSegments.map((s) => ({
        filename: s.filename,
        segment_start_time: s.segment_start_time,
        duration: s.duration
      })),
      upload_result: uploadResult
    });
  } catch (e) {
    console.error('[PROCESS GOAL]', e);
    return res.status(500).json({
      success: false,
      error: e.message
    });
  }
});

/* ───── upload-segment ───── */
app.post('/upload-segment', (req, res) => {
  upload.single('file')(req, res, async err => {
    if (err) {
      console.error('[MULTER]', err);
      return res.status(400).json({ success: false, error: err.message });
    }

    try {
      const { file } = req;
      const { match_id, segment_start_time_in_game = 0, duration = '00:00:20' } = req.body;

      const uploaded = await uploadToDrive({
        filePath: file.path,
        metadata: {
          custom_name: file.originalname || `segment_${uuidv4()}.webm`,
          match_id,
          duration,
          segment_start_time_in_game
        },
        isFullClip: true
      });

      fs.unlink(file.path, () => {});
      res.json({ success: true, clip: uploaded });
    } catch (e) {
      console.error('[UPLOAD]', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });
});

/* ───── auto-generate-clips ───── */
app.post('/auto-generate-clips', async (req, res) => {
  const { match_id, actions = [], segments = [] } = req.body;
  res.json({ success: true });

  const segs = [...segments].sort(
    (a, b) => Number(a.segment_start_time_in_game) - Number(b.segment_start_time_in_game)
  );

  for (const act of actions) {
    try {
      const seg = segs.find(s => {
        const start = Number(s.segment_start_time_in_game);
        const dur = toSeconds(s.duration) || 20;
        return act.timestamp_in_game >= start && act.timestamp_in_game < start + dur;
      });

      if (!seg) {
        console.warn('⚠️ no seg for', act.timestamp_in_game);
        continue;
      }

      const rel = act.timestamp_in_game - Number(seg.segment_start_time_in_game);
      let startSec = Math.max(0, rel - BACKWARD_OFFSET_SEC);
      let prev = null;

      if (rel < BACKWARD_OFFSET_SEC) {
        prev = segs
          .filter(s => Number(s.segment_start_time_in_game) < Number(seg.segment_start_time_in_game))
          .pop();

        if (prev) {
          startSec = (toSeconds(prev.duration) || 20) + rel - BACKWARD_OFFSET_SEC;
          if (startSec < 0) startSec = 0;
        }
      }

      await cutClipFromDriveFile({
        fileId: seg.file_id,
        previousFileId: prev ? prev.file_id : null,
        startTimeInSec: startSec,
        durationInSec: CLIP_DURATION_SEC,
        matchId: match_id,
        actionType: act.action_type,
        playerName: act.player_name,
        teamColor: act.team_color,
        assistPlayerName: act.assist_player_name,
        segmentStartTimeInGame: seg.segment_start_time_in_game
      });
    } catch (e) {
      console.error('[CLIP]', e);
    }
  }
});

/* ───── clips feed  (/clips?limit&before) ───── */
app.get('/clips', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    const before = req.query.before ? new Date(req.query.before).toISOString() : null;

    const q = [
      `'${SHORT_CLIPS_FOLDER_ID}' in parents`,
      'trashed = false'
    ];

    if (before) q.push(`createdTime < '${before}'`);

    const resp = await drive.files.list({
      q: q.join(' and '),
      pageSize: limit,
      fields: 'files(id,name,createdTime,properties)',
      orderBy: 'createdTime desc'
    });

    const clips = (resp.data.files || []).map(f => ({
      external_id: f.id,
      name: f.name,
      view_url: `https://drive.google.com/file/d/${f.id}/view`,
      download_url: `https://drive.google.com/uc?export=download&id=${f.id}`,
      created_date: f.createdTime,
      match_id: f.properties?.match_id || '',
      action_type: f.properties?.action_type || '',
      player_name: f.properties?.player_name || '',
      team_color: f.properties?.team_color || '',
      assist_player_name: f.properties?.assist_player_name || '',
      segment_start_time_in_game: f.properties?.segment_start_time_in_game || ''
    }));

    res.json(clips);
  } catch (e) {
    console.error('[CLIPS]', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ───── FULL-CLIP helper  (/full-clip) ───── */
app.get('/full-clip', async (req, res) => {
  try {
    const { match_id, start } = req.query;

    if (!match_id || start === undefined) {
      return res.status(400).json({ error: 'Missing params' });
    }

    const list = await drive.files.list({
      q: [
        `'${FULL_CLIPS_FOLDER_ID}' in parents`,
        'trashed = false',
        `properties has { key='match_id' and value='${match_id}' }`
      ].join(' and '),
      pageSize: 1000,
      fields: 'files(id,name,properties)'
    });

    const files = (list.data.files || [])
      .filter(f => f.properties?.segment_start_time_in_game !== undefined)
      .sort((a, b) => Number(a.properties.segment_start_time_in_game) - Number(b.properties.segment_start_time_in_game));

    if (!files.length) {
      return res.status(404).json({ error: 'no suitable full clips' });
    }

    const sNum = Number(start);
    let prev = null;
    let next = null;

    for (const f of files) {
      const st = Number(f.properties.segment_start_time_in_game);
      if (st <= sNum) prev = f;
      if (st > sNum) {
        next = f;
        break;
      }
    }

    const cand = [prev, next].filter(Boolean).map(f => ({
      external_id: f.id,
      name: f.name,
      match_id: f.properties.match_id,
      segment_start_time_in_game: f.properties.segment_start_time_in_game,
      view_url: `https://drive.google.com/file/d/${f.id}/view`,
      download_url: `https://drive.google.com/uc?export=download&id=${f.id}`
    }));

    if (!cand.length) {
      return res.status(404).json({ error: 'no suitable full clips' });
    }

    res.json(cand);
  } catch (e) {
    console.error('[FULL-CLIP]', e);
    res.status(500).json({ error: e.message });
  }
});

/* ───── fallback JSON error ───── */
app.use((err, req, res, next) => {
  console.error('[EXPRESS]', err);
  res.status(err.status || 500).json({ success: false, error: err.message || 'server' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`📡 server on ${PORT}`));
