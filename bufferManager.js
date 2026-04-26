const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const BUFFER_ROOT = process.env.BUFFER_ROOT || path.join(os.tmpdir(), 'video-buffer');
const BUFFER_WINDOW_SECONDS = Number(process.env.BUFFER_WINDOW_SECONDS || 300); // 5 דקות

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

function sanitize(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getCameraDir(matchId, cameraId) {
  return path.join(BUFFER_ROOT, sanitize(matchId), sanitize(cameraId));
}

function buildSegmentFilename({ segmentStartTime, duration, originalName }) {
  const ext = path.extname(originalName || '') || '.webm';
  return `seg_${segmentStartTime}_${duration}_${uuidv4()}${ext}`;
}

function parseSegmentFilename(filename) {
  const match = filename.match(/^seg_(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)_.+\.(\w+)$/);
  if (!match) return null;

  return {
    segment_start_time: Number(match[1]),
    duration: Number(match[2]),
    extension: match[3]
  };
}

async function saveIncomingSegment({
  tempFilePath,
  originalName,
  matchId,
  cameraId,
  segmentStartTime,
  duration
}) {
  if (!tempFilePath) throw new Error('tempFilePath is required');
  if (!matchId) throw new Error('matchId is required');
  if (!cameraId) throw new Error('cameraId is required');

  const cameraDir = getCameraDir(matchId, cameraId);
  await ensureDir(cameraDir);

  const filename = buildSegmentFilename({
    segmentStartTime,
    duration,
    originalName
  });

  const finalPath = path.join(cameraDir, filename);

  await fsp.copyFile(tempFilePath, finalPath);

  return {
    path: finalPath,
    filename,
    match_id: matchId,
    camera_id: cameraId,
    segment_start_time: Number(segmentStartTime),
    duration: Number(duration)
  };
}

async function listSegments(matchId, cameraId) {
  const cameraDir = getCameraDir(matchId, cameraId);

  try {
    const files = await fsp.readdir(cameraDir);

    return files
      .map((filename) => {
        const parsed = parseSegmentFilename(filename);
        if (!parsed) return null;

        return {
          path: path.join(cameraDir, filename),
          filename,
          segment_start_time: parsed.segment_start_time,
          duration: parsed.duration
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.segment_start_time - b.segment_start_time);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function pruneOldSegments(matchId, cameraId, currentSegmentStartTime) {
  const segments = await listSegments(matchId, cameraId);
  const cutoff = Number(currentSegmentStartTime) - BUFFER_WINDOW_SECONDS;

  const toDelete = segments.filter((segment) => {
    const segmentEnd = segment.segment_start_time + segment.duration;
    return segmentEnd < cutoff;
  });

  for (const segment of toDelete) {
    try {
      await fsp.unlink(segment.path);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.error('Failed deleting old segment:', segment.path, error.message);
      }
    }
  }

  return {
    deleted_count: toDelete.length
  };
}

async function getSegmentsForClip({
  matchId,
  cameraId,
  clipStart,
  clipEnd
}) {
  const segments = await listSegments(matchId, cameraId);

  return segments.filter((segment) => {
    const segmentEnd = segment.segment_start_time + segment.duration;
    return segment.segment_start_time < clipEnd && segmentEnd > clipStart;
  });
}

async function deleteAllMatchSegments(matchId) {
  const matchDir = path.join(BUFFER_ROOT, sanitize(matchId));

  try {
    await fsp.rm(matchDir, { recursive: true, force: true });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  BUFFER_ROOT,
  BUFFER_WINDOW_SECONDS,
  saveIncomingSegment,
  listSegments,
  pruneOldSegments,
  getSegmentsForClip,
  deleteAllMatchSegments
};
