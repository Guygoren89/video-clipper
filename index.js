// index.js

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const { uploadToDrive, downloadFileFromDrive } = require('./driveUploader');
const { cutClip } = require('./clipTester');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage() });

const CLIPS_FOLDER_ID = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'; // Short_clips
const FULL_FOLDER_ID = '1pp2pexCa8q2wmdMBa8LLybF_WoX_pdwc'; // Full_clips

const CUT_BACK_SECONDS = 8;
const CLIP_DURATION_SECONDS = 8;

// ✅ Endpoint להעלאת מקטע (20 שניות) לתיקיית Full_clips
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  const segmentId = uuidv4();
  const inputPath = `/tmp/input_${segmentId}.mp4`;
  const clipPath = `/tmp/segment_${segmentId}.mp4`;

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { match_id, start_time, duration } = req.body;
    fs.writeFileSync(inputPath, req.file.buffer);

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

    console.log("✅ Uploading to Google Drive...");
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
      folderId: FULL_FOLDER_ID,
    });
    console.log("✅ Upload success:", driveRes.view_url);

    fs.unlinkSync(inputPath);
    fs.unlinkSync(clipPath);

    res.status(200).json({ success: true, clip: driveRes });
  } catch (error) {
    console.error('🔥 Error in /upload-segment:', error.message);
    try {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
    } catch (cleanupError) {
      console.warn('⚠️ Failed to clean temp files:', cleanupError.message);
    }

    res.status(500).json({ success: false, error: 'Upload failed', details: error.message });
  }
});

// ✅ Endpoint לחיתוך קליפים לפי פעולות
app.post('/auto-generate-from-segments', async (req, res) => {
  try {
    const { clips } = req.body;
    if (!Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({ success: false, error: 'Missing clips array' });
    }

    const results = [];
    for (const clip of clips) {
      const { file_id, start_time, action_type, player_name, match_id } = clip;
      if (!file_id || !start_time || !action_type || !player_name || !match_id) {
        continue;
      }

      const adjustedStartTime = subtractSeconds(start_time, CUT_BACK_SECONDS);
      const result = await cutClip(file_id, adjustedStartTime, CLIP_DURATION_SECONDS, {
        action_type,
        player_name,
        match_id
      });

      results.push(result);
    }

    res.status(200).json({ success: true, clips: results });
  } catch (error) {
    console.error('🔥 Error in /auto-generate-from-segments:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// ✅ חיתוך בדיקה ידני
app.post('/cut-test-clip', async (req, res) => {
  try {
    const { file_id, start_time, duration, action_type = 'manual_cut', player_name = 'unknown_player', match_id = 'manual_test' } = req.body;
    if (!file_id || !start_time || !duration) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    const clip = await cutClip(file_id, start_time, duration, { action_type, player_name, match_id });
    res.status(200).json({ success: true, clip });
  } catch (error) {
    console.error('🔥 Error in /cut-test-clip:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// ✅ שליפת קליפים לפי match_id
app.get('/clips', async (req, res) => {
  try {
    const { match_id } = req.query;
    if (!match_id) {
      return res.status(400).json({ success: false, error: 'Missing match_id parameter' });
    }

    const response = await drive.files.list({
      q: `'${CLIPS_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name, createdTime, webViewLink, webContentLink)',
      orderBy: 'createdTime desc',
      pageSize: 1000,
    });

    const files = response.data.files || [];

    const filteredClips = files
      .filter(file => file.name.includes(match_id))
      .map(file => {
        const parts = file.name.split('_');
        const actionType = parts[0] || 'unknown';
        const playerName = parts[1] || 'unknown';
        const clipId = file.id;

        return {
          external_id: clipId,
          name: file.name,
          view_url: file.webViewLink,
          download_url: file.webContentLink,
          thumbnail_url: '',
          duration: 8,
          created_date: file.createdTime,
          player_id: 'manual',
          player_name: playerName,
          action_type: actionType,
          match_id: match_id,
        };
      });

    res.status(200).json({ success: true, clips: filteredClips });
  } catch (error) {
    console.error('🔥 Error in GET /clips:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// עזר
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
