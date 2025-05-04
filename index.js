const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const multer = require('multer');
const cors = require('cors');

const app = express();
const port = 10000;
app.use(cors());
app.use(bodyParser.json());

// Multer for file upload
const upload = multer({ dest: '/tmp' });

// Google Drive Auth
const auth = new google.auth.GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// Utils
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

// 🌕 FULL SEGMENT UPLOAD
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

    const folderId = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC'; // Full_clips
    const fileName = `segment_${segmentId}.webm`;
    console.log('📂 Uploading to folder:', 'Full_clips');
    console.log('📄 File name:', fileName);

    try {
      const response = await uploadToDrive(segmentPath, fileName, folderId);
      const fileId = response.data.id;
      const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;
      console.log('✅ הועלה בהצלחה:', fileUrl);

      res.json({
        success: true,
        clip: {
          google_file_id: fileId
        }
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

// ✂️ AUTO GENERATE SHORT CLIP
app.post('/auto-generate-clips', async (req, res) => {
  console.log('📅 התחיל תהליך /auto-generate-clips');

  const { file_id, start_time } = req.body;

  if (!file_id) {
    console.error('❌ חסר file_id');
    return res.status(400).json({ error: 'Missing file_id' });
  }

  if (typeof start_time !== 'number' || isNaN(start_time)) {
    console.error('❌ start_time is missing or invalid:', start_time);
    return res.status(400).json({ error: 'Invalid start_time' });
  }

  const inputPath = `/tmp/input_${Date.now()}.webm`;
  const clipId = `clip_${Date.now()}`;
  const clipPath = `/tmp/${clipId}.webm`;

  try {
    // Download full clip from Google Drive
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

    // Calculate start timestamp
    const startTime = formatTime(start_time);
    const clipCommand = `ffmpeg -ss ${startTime} -i ${inputPath} -t 00:00:08 -c copy -y ${clipPath}`;
    console.log('🎞️ FFmpeg command:', clipCommand);

    // Run FFmpeg to generate clip
    await new Promise((resolve, reject) => {
      exec(clipCommand, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // Upload short clip
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

app.listen(port, () => {
  console.log(`🚀 Video Clipper running on port ${port}`);
});
