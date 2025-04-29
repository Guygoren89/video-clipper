// index.js

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const { uploadToDrive, downloadFileFromDrive } = require('./driveUploader');
const { cutClip } = require('./clipTester'); // ✅ ייבוא פונקציה חדשה
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage() });

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

// ✅ Endpoint להעלאת מקטע
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { match_id, start_time, duration } = req.body;
    const segmentId = uuidv4();

    const inputPath = `/tmp/input_${segmentId}.mp4`;
    fs.writeFileSync(inputPath, req.file.buffer);

    const clipPath = `/tmp/segment_${segmentId}.mp4`;
    const ffmpegCmd = `ffmpeg -ss ${start_time} -i ${inputPath} -t ${duration} -y ${clipPath}`;
    console.log(`🎞️ FFmpeg cutting segment: ${ffmpegCmd}`);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => {
        if (error) {
          console.error('❌ FFmpeg failed:', error.message);
          return reject(error);
        }
        resolve();
      });
    });

    const driveRes = await uploadToDrive({
      filePath: clipPath,
      metadata: {
        clip_id: segmentId,
        match_id,
        created_date: new Date().toISOString(),
        duration,
        player_id: 'segment_mode',
        player_name: 'מקטע בדיקה',
        action_type: 'segment_upload',
      },
    });

    fs.unlinkSync(inputPath);
    fs.unlinkSync(clipPath);

    res.status(200).json({ success: true, clip: driveRes });
  } catch (error) {
    console.error('🔥 Error in /upload-segment:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// ✅ Endpoint לחיבור מקטעים
app.post('/merge-segments', async (req, res) => {
  try {
    const { match_id } = req.body;
    if (!match_id) {
      return res.status(400).json({ success: false, error: 'Missing match_id' });
    }

    console.log(`🧩 Starting merge for match_id: ${match_id}`);

    const response = await drive.files.list({
      q: `'1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C' in parents and trashed = false and name contains '${match_id}'`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime asc',
    });

    const files = response.data.files;
    if (!files.length) {
      return res.status(404).json({ success: false, error: 'No segments found' });
    }

    console.log(`📂 Found ${files.length} segments`);

    const inputPaths = [];
    for (const file of files) {
      const filePath = `/tmp/${file.name}`;
      await downloadFileFromDrive(file.id, filePath);
      inputPaths.push(filePath);
    }

    const listPath = '/tmp/segments.txt';
    fs.writeFileSync(listPath, inputPaths.map(p => `file '${p}'`).join('\n'));

    const mergedPath = `/tmp/merged_${uuidv4()}.mp4`;
    const ffmpegCmd = `ffmpeg -f concat -safe 0 -i ${listPath} -c copy -y ${mergedPath}`;
    console.log(`🔧 Running FFmpeg merge: ${ffmpegCmd}`);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => {
        if (error) {
          console.error('❌ FFmpeg merge failed:', error.message);
          return reject(error);
        }
        resolve();
      });
    });

    const driveRes = await uploadToDrive({
      filePath: mergedPath,
      metadata: {
        clip_id: uuidv4(),
        match_id,
        player_id: 'merged_game',
        player_name: 'משחק מחובר',
        action_type: 'merged_video',
        created_date: new Date().toISOString(),
        duration: '',
      },
    });

    res.status(200).json({ success: true, merged_video: driveRes });
  } catch (error) {
    console.error('🔥 Error in /merge-segments:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// ✅ Endpoint חדש: חיתוך מתוך סרטון קיים בדרייב (בודד)
app.post('/cut-test-clip', async (req, res) => {
  try {
    const { file_id, start_time, duration, action_type = 'manual_cut', player_name = 'unknown_player' } = req.body;
    if (!file_id || !start_time || !duration) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    const clip = await cutClip(file_id, start_time, duration, { action_type, player_name });
    res.status(200).json({ success: true, clip });
  } catch (error) {
    console.error('🔥 Error in /cut-test-clip:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// ✅ Endpoint חדש: חיתוך אוטומטי מרשימת פעולות
const CUT_BACK_SECONDS = 8;
const CLIP_DURATION_SECONDS = 8;

app.post('/auto-generate-clips', async (req, res) => {
  try {
    const { file_id, actions } = req.body;
    if (!file_id || !Array.isArray(actions) || actions.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    const results = [];

    for (const action of actions) {
      const { action_type, player_name, start_time } = action;
      if (!action_type || !player_name || !start_time) {
        continue;
      }

      const adjustedStartTime = subtractSeconds(start_time, CUT_BACK_SECONDS);

      const clip = await cutClip(file_id, adjustedStartTime, CLIP_DURATION_SECONDS, {
        action_type,
        player_name
      });

      results.push(clip);
    }

    res.status(200).json({ success: true, clips: results });
  } catch (error) {
    console.error('🔥 Error in /auto-generate-clips:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// עזר: פונקציה להוריד שניות
function subtractSeconds(timeStr, seconds) {
  const [hh, mm, ss] = timeStr.split(':').map(Number);
  let totalSeconds = hh * 3600 + mm * 60 + ss;
  totalSeconds = Math.max(0, totalSeconds - seconds);

  const newH = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const newM = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const newS = String(totalSeconds % 60).padStart(2, '0');

  return `${newH}:${newM}:${newS}`;
}

app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
