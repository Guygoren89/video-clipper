// ============================================================================
// index.js  – FULL FILE (Full_clips upload + auto-generate clips)
// ============================================================================

const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');

const {
  uploadToDrive,
  formatTime,
  cutClipFromDriveFile
} = require('./segmentsManager');

// ────────────────────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));     // handle JSON payloads
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────
// 0. HEALTH CHECK
// ──────────────────────────────────
app.get('/health', (_, res) => res.send('OK'));

// ──────────────────────────────────
// 1. 20-second SEGMENT UPLOAD  → Full_clips
// ──────────────────────────────────
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id, start_time, end_time, segment_start_time_in_game } = req.body;
    const file = req.file;

    console.log('📤 Uploading segment:', {
      name  : file.originalname,
      sizeMB: (file.size / 1024 / 1024).toFixed(2),
      match_id,
      start_time,
      end_time,
      segment_start_time_in_game
    });

    const uploaded = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name              : file.originalname,
        match_id,
        duration                 : end_time || '00:00:20',
        segment_start_time_in_game
      },
      isFullClip: true                           // ⬅️ sends to Full_clips
    });

    return res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────
// 2. AUTO-GENERATE CLIPS  (8-s) → Short_clips
// ──────────────────────────────────
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id, actions = [], segments = [] } = req.body;

    console.log('✂️ Auto clip request received:', {
      match_id,
      actionsCount  : actions.length,
      segmentsCount : segments.length
    });

    // immediate response to client
    res.json({ success: true, message: 'Clip generation started in background' });

    // background processing
    for (const action of actions) {
      const { timestamp_in_game, action_type, player_name } = action;

      const seg = segments.find(s => {
        const segStart = parseInt(s.segment_start_time_in_game);
        const segEnd   = segStart + parseInt(s.duration || 20);
        return timestamp_in_game >= segStart && timestamp_in_game < segEnd;
      });

      if (!seg) {
        console.warn(`⚠️ No segment for action at ${timestamp_in_game}s`);
        continue;
      }

      const relative  = timestamp_in_game - parseInt(seg.segment_start_time_in_game);
      const startSec  = Math.max(0, relative - 8);
      const durSec    = Math.min(8, relative);

      console.log(`✂️ Cutting clip ${seg.file_id} @${startSec}s for ${durSec}s`);

      try {
        await cutClipFromDriveFile({
          fileId        : seg.file_id,
          matchId       : match_id,
          startTimeInSec: formatTime(startSec),
          durationInSec : durSec,
          actionType    : action_type,
          playerName    : player_name || ''
        });
      } catch (err) {
        console.error(`[ERROR] Clip cut failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[CLIP ERROR]', err);
    // cannot reply twice; log only
  }
});

// ──────────────────────────────────
// 3. MANUAL CLIP (debug endpoint)
// ──────────────────────────────────
app.post('/generate-clips', async (req, res) => {
  try {
    const { file_id, match_id, start_time, duration, action_type, player_name } = req.body;

    console.log('✂️ Manual clip request:', {
      file_id,
      match_id,
      start_time,
      duration,
      action_type,
      player_name
    });

    const clip = await cutClipFromDriveFile({
      fileId        : file_id,
      matchId       : match_id,
      startTimeInSec: formatTime(start_time),
      durationInSec : duration,
      actionType    : action_type,
      playerName    : player_name || ''
    });

    return res.json({ success: true, clip });
  } catch (err) {
    console.error('[MANUAL CLIP ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────
// START SERVER
// ──────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Server listening on port ${PORT}`);
});
