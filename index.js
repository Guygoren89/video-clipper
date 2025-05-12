const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const { uploadToDrive } = require('./driveUploader');
const { formatTime, cutClipFromDriveFile } = require('./segmentsManager');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ העלאת מקטעים
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    const { match_id, start_time, end_time, segment_start_time_in_game } = req.body;
    const file = req.file;

    console.log('📤 Uploading segment:', {
      name: file.originalname,
      sizeMB: (file.size / 1024 / 1024).toFixed(2),
      match_id,
      start_time,
      end_time,
      segment_start_time_in_game
    });

    const uploaded = await uploadToDrive(
      file.path,
      file.originalname,
      match_id,
      start_time,
      end_time,
      segment_start_time_in_game
    );

    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ חיתוך אוטומטי לפי פעולות וטווחי זמן
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id, actions, segments } = req.body;

    console.log('✂️ Auto clip request received:', {
      match_id,
      actionsCount: actions.length,
      segmentsCount: segments.length
    });

    const clips = [];

    for (const action of actions) {
      const { action_time_in_game, action_type } = action;

      const matchingSegment = segments.find(segment => {
        const start = parseInt(segment.segment_start_time_in_game);
        const end = start + parseInt(segment.duration || 20);
        return action_time_in_game >= start && action_time_in_game < end;
      });

      if (!matchingSegment) {
        console.warn(`⚠️ לא נמצא מקטע עבור פעולה בזמן ${action_time_in_game}`);
        continue;
      }

      const relativeTime = action_time_in_game - parseInt(matchingSegment.segment_start_time_in_game);
      const clipStartTime = Math.max(0, relativeTime - 8);
      const actualDuration = relativeTime - clipStartTime;

      console.log(`✂️ חותך קליפ מ־${clipStartTime}s למשך ${actualDuration}s מתוך קובץ ${matchingSegment.file_id}`);

      const clip = await cutClipFromDriveFile({
        fileId: matchingSegment.file_id,
        matchId: match_id,
        startTimeInSec: formatTime(clipStartTime),
        durationInSec: actualDuration,
        actionType: action_type
      });

      clips.push(clip);
    }

    res.json({ success: true, clips });
  } catch (err) {
    console.error('[CLIP ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// (רשות) חיתוך לפי fileId ישיר
app.post('/generate-clips', async (req, res) => {
  try {
    const { file_id, match_id, start_time, duration, action_type } = req.body;

    console.log('✂️ Manual clip request:', {
      file_id,
      match_id,
      start_time,
      duration,
      action_type
    });

    const clip = await cutClipFromDriveFile({
      fileId: file_id,
      matchId: match_id,
      startTimeInSec: formatTime(start_time),
      durationInSec: duration,
      actionType: action_type
    });

    res.json({ success: true, clip });
  } catch (err) {
    console.error('[MANUAL CLIP ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(3000, () => {
  console.log('📡 Server listening on port 3000');
});
