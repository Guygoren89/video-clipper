const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const multer = require('multer');
const cors = require('cors');
const path = require('path');

const { uploadToDrive } = require('./driveUploader');

const app = express();
const port = 10000;
app.use(cors());
app.use(bodyParser.json());
const upload = multer({ dest: '/tmp' });

// Utilities
function formatTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}
function pad(n) {
  return n.toString().padStart(2, '0');
}

// 🔁 Segment Upload (20 sec full clips)
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

// ✂️ Manual clip generation for testing
app.post('/generate-clips', async (req, res) => {
  console.log('📅 התחיל תהליך /generate-clips');

  const { file_id, start_time, duration } = req.body;
  if (!file_id || typeof start_time !== 'number' || typeof duration !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  const inputPath = `/tmp/input_${Date.now()}.webm`;
  const clipId = `manual_clip_${Date.now()}`;
  const clipPath = `/tmp/${clipId}.webm`;

  try {
    const dest = fs.createWriteStream(inputPath);
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });

    await drive.files.get(
      { fileId: file_id, alt: 'media' },
      { responseType: 'stream' },
      (err, res2) => {
        if (err) throw err;
        res2.data.pipe(dest);
      }
    );
    await new Promise((resolve) => dest.on('finish', resolve));

    const startTimeFormatted = formatTime(start_time);
    const ffmpegCommand = `ffmpeg -ss ${startTimeFormatted} -i ${inputPath} -t ${duration} -c:v libvpx -crf 10 -b:v 1M -an -y ${clipPath}`;
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
        match_id: 'manual_match',
        created_date: new Date().toISOString(),
        duration: duration,
        action_type: 'manual',
      },
      custom_name: `${clipId}.webm`
    });

    res.json({ clip_url: result.view_url });
  } catch (err) {
    console.error('🔥 שגיאה ב- /generate-clips:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
  }
});

// ✅ auto-generate-clips לפי מערך פעולות
app.post('/auto-generate-clips', async (req, res) => {
  console.log('📅 התחיל תהליך /auto-generate-clips');

  const { file_id, match_id, actions } = req.body;
  if (!file_id || !Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: 'Missing file_id or actions' });
  }

  const inputPath = `/tmp/input_${Date.now()}.webm`;
  try {
    // הורדת הקובץ מהדרייב
    const dest = fs.createWriteStream(inputPath);
    const { google } = require('googleapis');
    const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/drive'] });
    const drive = google.drive({ version: 'v3', auth });

    await drive.files.get(
      { fileId: file_id, alt: 'media' },
      { responseType: 'stream' },
      (err, res2) => {
        if (err) throw err;
        res2.data.pipe(dest);
      }
    );
    await new Promise((resolve) => dest.on('finish', resolve));

    const clipResults = [];

    for (const action of actions) {
      const clipId = `auto_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const outputPath = `/tmp/${clipId}.webm`;

      const startTime = action.start_time;
      const duration = action.duration || '00:00:08';

      const ffmpegCommand = `ffmpeg -ss ${startTime} -i ${inputPath} -t ${duration} -c:v libvpx -crf 10 -b:v 1M -an -y ${outputPath}`;
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
          duration: duration,
          action_type: action.action_type,
        },
        custom_name: `${clipId}.webm`
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
