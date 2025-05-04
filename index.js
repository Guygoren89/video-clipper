// index.js

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

// שלב 1: העלאת סרטון מלא לתיקיית Full_clips
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  console.log("📅 התחיל תהליך /upload-segment");

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'לא התקבל קובץ' });
  }

  const debugPath = `/tmp/debug_${Date.now()}.webm`;
  fs.writeFileSync(debugPath, req.file.buffer);

  const { match_id = 'test_upload', start_time = '00:00:00', duration = '00:00:20' } = req.body;
  const segmentId = uuidv4();

  const inputPath = `/tmp/input_${segmentId}.webm`;
  const outputPath = `/tmp/segment_${segmentId}.webm`;

  fs.writeFileSync(inputPath, req.file.buffer);

  const ffmpegCmd = `ffmpeg -ss ${start_time} -i ${inputPath} -t ${duration} -c copy -y ${outputPath}`;
  console.log("🎞️ FFmpeg command:", ffmpegCmd);

  res.status(200).json({ success: true, clip: { external_id: segmentId } });

  exec(ffmpegCmd, async (error) => {
    if (error) {
      console.error("❌ FFmpeg נכשל:", error.message);
      return;
    }

    try {
      const driveRes = await uploadToDrive({
        filePath: outputPath,
        metadata: {
          clip_id: segmentId,
          match_id,
          created_date: new Date().toISOString(),
          duration,
          player_id: "manual",
          player_name: "Test Upload",
          action_type: "segment_upload"
        }
      });

      console.log("✅ הועלה בהצלחה:", driveRes.view_url);
    } catch (err) {
      console.error("🚨 שגיאה בהעלאה ל-Drive:", err.message);
    }
  });
});

// שלב 2: חיתוך קליפים אוטומטי לפי פעולות למשחק
app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { file_id, actions, match_id } = req.body;
    if (!file_id || !Array.isArray(actions) || actions.length === 0 || !match_id) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    const results = [];
    for (const action of actions) {
      const { action_type, player_name, start_time } = action;
      if (!action_type || !player_name || !start_time) continue;

      const adjustedStartTime = subtractSeconds(start_time, 8);
      const clip = await cutClip(file_id, adjustedStartTime, 8, {
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

// שלב 2.5: חיתוך קליפ ידני לפי file_id ופרטים מהמשתמש
app.post('/manual-cut', async (req, res) => {
  try {
    const { file_id, start_time, duration, action_type, player_name, match_id } = req.body;

    if (!file_id || !start_time || !duration) {
      return res.status(400).json({ success: false, error: 'Missing required parameters' });
    }

    const clip = await cutClip(file_id, start_time, duration, {
      action_type: action_type || 'manual',
      player_name: player_name || 'לא ידוע',
      match_id: match_id || 'manual_cut'
    });

    return res.status(200).json({ success: true, clip });
  } catch (error) {
    console.error("🔥 Error in /manual-cut:", error.message);
    return res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// שלב 3: שליפה לפי match_id
app.get('/clips', async (req, res) => {
  const { match_id } = req.query;
  if (!match_id) {
    return res.status(400).json({ success: false, error: 'Missing match_id' });
  }

  const all = await listClipsFromDrive('short');
  const filtered = all.filter(c => c.name.includes(match_id));
  return res.status(200).json({ success: true, clips: filtered });
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
