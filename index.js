const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { uploadToDrive, listClipsFromDrive } = require('./driveUploader');
const { cutClip } = require('./clipTester');

const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage() });

// שלב 1: העלאת סרטון מלא
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  console.log("📅 התחיל תהליך /upload-segment");
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'לא התקבל קובץ' });
  }

  const segmentId = uuidv4();
  const inputPath = `/tmp/input_${segmentId}.webm`;
  const outputPath = `/tmp/segment_${segmentId}.webm`;
  fs.writeFileSync(inputPath, req.file.buffer);

  const { match_id = 'test_upload', start_time = '00:00:00', duration = '00:00:20' } = req.body;
  const ffmpegCmd = `ffmpeg -ss ${start_time} -i ${inputPath} -t ${duration} -c copy -y ${outputPath}`;
  console.log("🎞️ FFmpeg command:", ffmpegCmd);

  exec(ffmpegCmd, async (error) => {
    if (error) {
      console.error("❌ FFmpeg נכשל:", error.message);
      return res.status(500).json({ success: false, error: 'FFmpeg failed' });
    }

    try {
      const driveRes = await uploadToDrive({
        filePath: outputPath,
        metadata: {
          clip_id: segmentId,
          match_id,
          created_date: new Date().toISOString(),
          duration,
          action_type: "segment_upload"
        }
      });

      console.log("✅ הועלה בהצלחה:", driveRes.view_url);
      return res.status(200).json({ success: true, clip: driveRes });
    } catch (err) {
      console.error("🚨 שגיאה בהעלאה ל-Drive:", err.message);
      return res.status(500).json({ success: false, error: 'Upload failed' });
    }
  });
});

// שלב 2: חיתוך אוטומטי (עובד גם בלי שחקן/קבוצה)
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { file_id, actions, match_id } = req.body;
    if (!file_id || !Array.isArray(actions) || actions.length === 0 || !match_id) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    const results = [];
    for (const action of actions) {
      const { start_time, action_type = 'unknown_action', player_name = 'לא ידוע' } = action;
      if (!start_time) continue;

      const adjustedStartTime = subtractSeconds(start_time, 8);
      const clip = await cutClip(file_id, adjustedStartTime, '00:00:08', {
        action_type,
        player_name,
        match_id
      });
      results.push(clip);
    }

    return res.status(200).json({ success: true, clips: results });
  } catch (error) {
    console.error("🔥 Error in /auto-generate-clips:", error.message);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// שלב 3: שליפת קליפים לפי match_id
app.get('/clips', async (req, res) => {
  const { match_id } = req.query;
  if (!match_id) return res.status(400).json({ success: false, error: 'Missing match_id' });
  const all = await listClipsFromDrive('short');
  const filtered = all.filter(c => c.name.includes(match_id));
  return res.status(200).json({ success: true, clips: filtered });
});

// שלב 4: חיתוך ידני לפי פרמטרים
app.post('/manual-cut', async (req, res) => {
  try {
    const { file_id, start_time, duration, action_type = 'unknown_action', player_name = 'לא ידוע', match_id } = req.body;
    if (!file_id || !start_time || !duration || !match_id) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    const clip = await cutClip(file_id, start_time, duration, {
      action_type,
      player_name,
      match_id
    });

    return res.status(200).json({ success: true, clip });
  } catch (error) {
    console.error("🔥 Error in /manual-cut:", error.message);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

function subtractSeconds(timeStr, seconds) {
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  let totalSeconds = hh * 3600 + mm * 60 + ss - seconds;
  if (totalSeconds < 0) totalSeconds = 0;
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
