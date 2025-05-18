// ============================================================================
// index.js  – FULL FILE (ready to copy-paste)
// ============================================================================

// core
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const fs       = require('fs');

// local utils
const {
  uploadToDrive,
  formatTime,
  cutClipFromDriveFile
} = require('./segmentsManager');

// ────────────────────────────────────────────────────────────────────────────
// App setup
// ────────────────────────────────────────────────────────────────────────────
const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ────────────────────────────────────────────────────────────────────────────
// 0. HEALTH-CHECK  ➜ keeps Render “awake” & lets you ping /health
// ────────────────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.send('OK'));

// ────────────────────────────────────────────────────────────────────────────
// 1. 20-second SEGMENT UPLOAD
// ────────────────────────────────────────────────────────────────────────────
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
      filePath: file.path,
      metadata: {
        custom_name              : file.originalname,
        match_id,
        duration                 : end_time || '00:00:20',
        segment_start_time_in_game
      }
    });

    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 2. AUTO-GENERATE CLIPS  (asynchronous – returns immediately)
// ────────────────────────────────────────────────────────────────────────────
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id, actions, segments } = req.body;

    console.log('✂️ Auto clip request received:', {
      match_id,
      actionsCount  : actions.length,
      segmentsCount : segments.length,
      actions
    });

    //  immediate response to client
    res.json({ success: true, message: 'Clip generation started in background' });

    //  process each action in the background
    for (const action of actions) {
      const { timestamp_in_game, action_type, player_name } = action;

      const matchingSegment = segments.find(segment => {
        const start = parseInt(segment.segment_start_time_in_game);
        const end   = start + parseInt(segment.duration || 20);
        return timestamp_in_game >= start && timestamp_in_game < end;
      });

      if (!matchingSegment) {
        console.warn(`⚠️ No segment for action at ${timestamp_in_game}s`);
        continue;
      }

      const relativeTime  = timestamp_in_game - parseInt(matchingSegment.segment_start_time_in_game);
      const clipStartTime = Math.max(0, relativeTime - 8);
      const actualDuration = Math.min(8, relativeTime);

      console.log(`✂️ Cutting clip from ${clipStartTime}s (dur ${actualDuration}s) file ${matchingSegment.file_id}`);

      try {
        await cutClipFromDriveFile({
          fileId        : matchingSegment.file_id,
          matchId       : match_id,
          startTimeInSec: formatTime(clipStartTime),
          durationInSec : actualDuration,
          actionType    : action_type,
          playerName    : player_name || ''
        });
      } catch (err) {
        console.error(`[ERROR] Clip cut failed: ${err.message}`);
      }
    }

  } catch (err) {
    console.error('[CLIP ERROR]', err);
    // we already sent response above; just log
  }
});

// ────────────────────────────────────────────────────────────────────────────
// 3. MANUAL CLIP (debug endpoint)
// ────────────────────────────────────────────────────────────────────────────
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

    res.json({ success: true, clip });
  } catch (err) {
    console.error('[MANUAL CLIP ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// START SERVER  – Render detects port 3000 automatically
// ────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`📡 Server listening on port ${PORT}`);
});
