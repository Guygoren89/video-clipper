// ============================================================================
// index.js  – FULL FILE  (Full_clips upload  +  auto-generate clips)
// ✓   יוצר מזהה-משחק ייחודי לכל סשן
// ✓   שומר מפת-מיפוי  original → unique  בזיכרון  
// ✓   משתמש במזהה הייחודי בכל נקודות השרת
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
// in-memory map:  { originalMatchId : uniqueMatchId }
const matchIdMap = Object.create(null);
function resolveMatchId(origId, segStart) {
  // "ראשון" הוא הסגמנט שמתחיל בזמן-משחק 0
  const isFirstSegment = Number(segStart) === 0;

  if (!matchIdMap[origId] && isFirstSegment) {
    matchIdMap[origId] = `${origId}_${Date.now()}`;   // יוצר מזהה חד-פעמי
    console.log(`🆕  New matchId created → ${matchIdMap[origId]}`);
  }
  return matchIdMap[origId] || origId;                // fallback ל-origId
}
// ────────────────────────────────────────────────────────────────────────────

const app    = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────
// 0.  HEALTH CHECK
// ──────────────────────────────────
app.get('/health', (_, res) => res.send('OK'));

// ──────────────────────────────────
// 1.  20-second SEGMENT UPLOAD  → Full_clips
// ──────────────────────────────────
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id: origMatchId,
            start_time,
            end_time,
            segment_start_time_in_game } = req.body;
    const file = req.file;

    const matchId = resolveMatchId(origMatchId, segment_start_time_in_game);

    console.log('📤 Uploading segment:', {
      name  : file.originalname,
      sizeMB: (file.size / 1024 / 1024).toFixed(2),
      matchId,
      start_time,
      end_time,
      segment_start_time_in_game
    });

    const uploaded = await uploadToDrive({
      filePath : file.path,
      metadata : {
        custom_name              : file.originalname,
        match_id                 : matchId,
        duration                 : end_time || '00:00:20',
        segment_start_time_in_game
      },
      isFullClip: true
    });

    return res.json({ success: true, clip: uploaded, match_id: matchId });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────
// 2.  AUTO-GENERATE CLIPS  (8-s) → Short_clips
// ──────────────────────────────────
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id: origMatchId, actions = [], segments = [] } = req.body;
    const matchId = matchIdMap[origMatchId] || origMatchId;

    console.log('✂️ Auto clip request received:', {
      matchId,
      actionsCount  : actions.length,
      segmentsCount : segments.length
    });

    // מיד שולח תשובה כדי לא לחסום את הקליינט
    res.json({ success: true, message: 'Clip generation started in background', match_id: matchId });

    // עיבוד ברקע
    for (const action of actions) {
      const { timestamp_in_game, action_type, player_name } = action;

      const seg = segments.find(s => {
        const segStart = Number(s.segment_start_time_in_game);
        const segEnd   = segStart + Number(s.duration || 20);
        return timestamp_in_game >= segStart && timestamp_in_game < segEnd;
      });

      if (!seg) {
        console.warn(`⚠️  No segment for action at ${timestamp_in_game}s`);
        continue;
      }

      const relative  = timestamp_in_game - Number(seg.segment_start_time_in_game);
      const startSec  = Math.max(0, relative - 8);
      const durSec    = Math.min(8, relative);

      console.log(`✂️  Cutting clip ${seg.file_id} @${startSec}s for ${durSec}s`);

      try {
        await cutClipFromDriveFile({
          fileId        : seg.file_id,
          matchId,
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
    /* אי-אפשר לענות פעמיים; רק לוג */
  }
});

// ──────────────────────────────────
// 3.  MANUAL CLIP (debug endpoint)
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
      startTimeInSec: formatTime(Number(start_time)),
      durationInSec : Number(duration),
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
