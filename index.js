const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const { uploadToDrive, downloadFileFromDrive } = require('./driveUploader');

const app = express();
const port = 10000;
app.use(cors());
app.use(bodyParser.json());
const upload = multer({ dest: '/tmp' });

function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

function parseTime(time) {
  if (typeof time === 'number') return time;
  const parts = time.split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

// 🔁 Segment Upload – קליפ מלא של 20 שניות
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  console.log('📅 התחיל תהליך /upload-segment');
  const inputPath = req.file.path;
  const segmentId = uuidv4();
  const segmentPath = `/tmp/segment_${segmentId}.webm`;

  const ffmpegCommand = `ffmpeg -ss 00:00:00 -i ${inputPath} -t 00:00:20 -c copy -y ${segmentPath}`;
  console.log('🎞️ FFmpeg command:', ffmpegCommand);

  exec(ffmpegCommand, async (error) => {
    if (error) {
      console.error('FFmpeg error:', error);
      return res.status(500).json({ error: 'FFmpeg failed' });
    }

    try {
      const fileName = `segment_${segmentId}.webm`;
      const result = await uploadToDrive({
        filePath: segmentPath,
        metadata: {
          clip_id: segmentId,
          match_id: req.body.match_id || 'default_match',
          created_date: new Date().toISOString(),
          duration: '00:00:20',
          action_type: 'segment_upload',
        },
        custom_name: fileName,
      });

      console.log('✅ הועלה בהצלחה:', result.view_url);
      res.json({ success: true, clip: result });
    } catch (err) {
      console.error('❌ Upload error:', err.message);
      res.status(500).json({ error: 'Upload failed' });
    } finally {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(segmentPath);
    }
  });
});

// ✂️ generate-clips – חיתוך קליפ אחד
app.post('/generate-clips', async (req, res) => {
  console.log('📅 התחיל תהליך /generate-clips');
  const { file_id, start_time, duration, match_id, action_type } = req.body;

  if (!file_id || start_time === undefined) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const start = parseTime(start_time);
  const length = duration !== undefined ? parseTime(duration) : 8;

  const inputPath = `/tmp/input_${Date.now()}.webm`;
  const clipId = uuidv4();
  const clipPath = `/tmp/clip_${clipId}.webm`;

  try {
    await downloadFileFromDrive(file_id, inputPath);

    const ffmpegCommand = `ffmpeg -ss ${formatTime(start)} -i ${inputPath} -t ${formatTime(length)} -c copy -y ${clipPath}`;
    console.log('🎞️ FFmpeg command:', ffmpegCommand);

    await new Promise((resolve, reject) => {
      exec(ffmpegCommand, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const result = await uploadToDrive({
      filePath: clipPath,
      metadata: {
        clip_id: clipId,
        match_id: match_id || 'manual_match',
        created_date: new Date().toISOString(),
        duration: length.toString(),
        action_type: action_type || 'manual',
      },
      custom_name: `clip_${match_id || 'manual'}_${clipId}.webm`,
    });

    res.json(result);
  } catch (err) {
    console.error('🔥 שגיאה ב- /generate-clips:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
  }
});

// ✅ auto-generate-clips – חותך קליפים מרובים
app.post('/auto-generate-clips', async (req, res) => {
  console.log('📅 התחיל תהליך /auto-generate-clips');
  const { file_id, match_id, actions } = req.body;

  if (!file_id || !Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: 'Missing file_id or actions' });
  }

  const inputPath = `/tmp/input_${Date.now()}.webm`;
  try {
    await downloadFileFromDrive(file_id, inputPath);

    const clipResults = [];

    for (const action of actions) {
      const start = parseTime(action.start_time);
      const length = action.duration !== undefined ? parseTime(action.duration) : 8;
      const clipId = uuidv4();
      const outputPath = `/tmp/clip_${clipId}.webm`;

      const ffmpegCommand = `ffmpeg -ss ${formatTime(start)} -i ${inputPath} -t ${formatTime(length)} -c copy -y ${outputPath}`;
      console.log('🎞️ FFmpeg command:', ffmpegCommand);

      await new Promise((resolve, reject) => {
        exec(ffmpegCommand, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });

      const uploaded = await uploadToDrive({
        filePath: outputPath,
        metadata: {
          clip_id: clipId,
          match_id: match_id,
          created_date: new Date().toISOString(),
          duration: length.toString(),
          action_type: action.action_type,
        },
        custom_name: `clip_${match_id}_${clipId}.webm`,
      });

      clipResults.push(uploaded);
      fs.unlinkSync(outputPath);
    }

    res.json({ clips: clipResults });
  } catch (err) {
    console.error('🔥 שגיאה ב- /auto-generate-clips:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
  }
});

app.listen(port, () => {
  console.log(`🚀 Video Clipper running on port ${port}`);
});
