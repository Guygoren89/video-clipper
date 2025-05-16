const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const {
  uploadToDrive,
  formatTime,
  cutClipFromDriveFile
} = require('./segmentsManager');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ העלאת מקטעים (20 שניות)
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

    const uploaded = await uploadToDrive({
      filePath: file.path,
      metadata: {
        match_id,
        action_type: 'segment_upload',
        duration: '20',
        created_date: new Date().toISOString(),
        segment_start_time_in_game,
        custom_name: file.originalname
      }
    });

    res.json({ success: true, clip: uploaded });
  } catch (err) {
    console.error('[UPLOAD ERROR]', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ חיתוך אוטומטי ברקע (8 שניות)
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { match_id, actions, segments } = req.body;

    console.log('✂️ Auto clip request received:', {
      match_id,
      actionsCount: actions.length,
      segmentsCount: segments.length,
      actions
    });

    res.json({ success: true, message: 'Clip generation started in background' });

    for (const action of actions) {
      const { timestamp_in_game, action_type } = action;

      const matchingSegment = segments.find(segment => {
        const start = parseInt(segment.segment_start_time_in_game);
        const end = start + parseInt(segment.duration || 20);
        return timestamp_in_game >= start && timestamp_in_game < end;
      });

      if (!matchingSegment) {
        console.warn(`⚠️ לא נמצא מקטע עבור פעולה בזמן ${timestamp_in_game}`);
        continue;
      }

      const relativeTime = timestamp_in_game - parseInt(matchingSegment.segment_start_time_in_game);
      const clipStartTime = Math.max(0, relativeTime - 8);
      const actualDuration = Math.min(8, relativeTime);

      console.log(`✂️ חותך קליפ מ־${clipStartTime}s למשך ${actualDuration}s מתוך קובץ ${matchingSegment.file_id}`);

      try {
        await cutClipFromDriveFile({
          fileId: matchingSegment.file_id,
          matchId: match_id,
          startTimeInSec: formatTime(clipStartTime),
          durationInSec: actualDuration,
          actionType: action_type
        });
      } catch (err) {
        console.error(`[ERROR] חיתוך קליפ נכשל: ${err.message}`);
      }
    }

  } catch (err) {
    console.error('[CLIP ERROR]', err);
  }
});

// ✅ חיתוך ידני לבדיקה
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

// ✅ הרצת שרת
app.listen(3000, () => {
  console.log('📡 Server listening on port 3000');
});
