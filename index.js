const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const multer = require('multer');
const cors = require('cors');

const app = express();
const port = 10000;
app.use(cors());
app.use(bodyParser.json());

const upload = multer({ dest: '/tmp' });

// Google Drive Auth
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

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
function uploadToDrive(filePath, fileName, folderId) {
  return drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: 'video/webm',
      body: fs.createReadStream(filePath),
    },
  });
}

// 🔁 Segment Upload (20 sec full clips)
app.post('/upload-segment', upload.single('file'), async (req, res) => {
  console.log('📅 התחיל תהליך /upload-segment');

  const inputPath = req.file.path;
  const segmentId = uuidv4();

  const matchId = req.body.match_id || 'unknown_match';
  const segmentPath = `/tmp/segment_${segmentId}.webm`;
  const fileName = `segment_${matchId}_${segmentId}.webm`;

  const ffmpegCommand = `ffmpeg -ss 00:00:00 -i ${inputPath} -t 00:00:20 -c copy -y ${segmentPath}`;
  console.log('🎞️ FFmpeg command:', ffmpegCommand);

  exec(ffmpegCommand, async (error) => {
    if (error) {
      console.error('FFmpeg error:', error);
      return res.status(500).json({ error: 'FFmpeg failed' });
    }

    const folderId = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC'; // Full_clips
    console.log('📂 Uploading to folder: Full_clips');

    try {
      const response = await uploadToDrive(segmentPath, fileName, folderId);
      const fileId = response.data.id;
      const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
      console.log('✅ הועלה בהצלחה:', fileUrl);

      res.json({
        success: true,
        clip: {
          google_file_id: fileId,
        },
      });
    } catch (err) {
      console.error('❌ Upload error:', err.message);
      res.status(500).json({ error: 'Upload failed' });
    } finally {
      fs.unlinkSync(inputPath);
      fs.unlinkSync(segmentPath);
    }
  });
});

// ✂️ Auto-generate clips from action
app.post('/auto-generate-clips', async (req, res) => {
  console.log('📅 התחיל תהליך /auto-generate-clips');

  const { file_id, start_time } = req.body;
  if (!file_id || typeof start_time !== 'number') {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  const inputPath = `/tmp/input_${Date.now()}.webm`;
  const clipId = `clip_${Date.now()}`;
  const clipPath = `/tmp/${clipId}.webm`;

  try {
    const dest = fs.createWriteStream(inputPath);
    await drive.files.get(
      { fileId: file_id, alt: 'media' },
      { responseType: 'stream' },
      (err, res2) => {
        if (err) throw err;
        res2.data.pipe(dest);
      }
    );
    await new Promise((resolve) => dest.on('finish', resolve));

    const startTime = formatTime(start_time);
    const clipCommand = `ffmpeg -ss ${startTime} -i ${inputPath} -t 8 -c:v libvpx -crf 10 -b:v 1M -an -y ${clipPath}`;
    console.log('🎞️ FFmpeg command:', clipCommand);

    await new Promise((resolve, reject) => {
      exec(clipCommand, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'; // Short_clips
    const response = await uploadToDrive(clipPath, `${clipId}.webm`, folderId);
    const fileUrl = `https://drive.google.com/file/d/${response.data.id}/view`;

    console.log('✅ קליפ קצר הועלה:', fileUrl);
    res.json({ fileUrl });
  } catch (err) {
    console.error('🔥 Error in /auto-generate-clips:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
  }
});

// ✂️ Manual clip generation (used by TestClipCutter)
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

    const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'; // Short_clips
    const response = await uploadToDrive(clipPath, `${clipId}.webm`, folderId);
    const fileUrl = `https://drive.google.com/file/d/${response.data.id}/view`;

    console.log('✅ קליפ ידני הועלה:', fileUrl);
    res.json({ clip_url: fileUrl });
  } catch (err) {
    console.error('🔥 שגיאה ב- /generate-clips:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath);
  }
});

app.listen(port, () => {
  console.log(`🚀 Video Clipper running on port ${port}`);
});
