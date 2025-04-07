// index.js (Phase 2 - updated clip timing logic)
const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const uploadToDrive = require('./driveUploader');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

try {
  const raw = fs.readFileSync(credentialsPath, 'utf8');
  console.log("✅ JSON credentials file found and readable");
  const parsed = JSON.parse(raw);
  console.log("✅ Parsed successfully. client_email:", parsed.client_email);
} catch (err) {
  console.error("❌ Failed to read or parse credentials JSON file:", err);
}

const app = express();
const upload = multer({ dest: '/tmp' });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ API להעלאת משחקים מלאים
app.post('/upload-full-game', upload.single('file'), async (req, res) => {
  try {
    console.log("📥 Received /upload-full-game request");
    const file = req.file;
    const match_id = req.body.match_id || uuidv4();
    if (!file) return res.status(400).send('No file uploaded');

    console.log(`📄 File received: ${file.originalname}, size: ${file.size} bytes`);

    const fileName = `full_game_${match_id}.mp4`;
    const folderId = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';
    console.log(`🚀 Uploading ${fileName} to Google Drive...`);
    const driveResponse = await uploadToDrive(file.path, fileName, folderId);
    console.log(`✅ Upload successful: ${driveResponse.id}`);

    fs.unlinkSync(file.path);
    console.log("🧹 Temp file deleted");

    res.json({
      message: 'Full game uploaded',
      file_id: driveResponse.id,
      view_url: driveResponse.webViewLink,
      download_url: driveResponse.webContentLink
    });
  } catch (err) {
    console.error('❌ Upload failed:', err);
    res.status(500).send('Upload failed');
  }
});

// ✅ API ליצירת קליפ
app.post('/generate-clip', async (req, res) => {
  const {
    videoUrl,
    timestamp,
    player_id,
    player_name,
    action_type,
    match_id
  } = req.body;

  console.log("🎬 Received /generate-clip request", req.body);

  if (!videoUrl || timestamp == null) {
    console.log("❌ Missing parameters");
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const videoId = uuidv4();
  const inputPath = `/tmp/input_${videoId}.mp4`;
  const outputPath = `/tmp/clip_${videoId}.mp4`;
  const metadataPath = `/tmp/clip_${videoId}.meta.json`;

  const directDownloadUrl = videoUrl.includes('drive.google.com/file/d/')
    ? videoUrl
        .replace('https://drive.google.com/file/d/', 'https://drive.google.com/uc?id=')
        .replace(/\/view\?.+$/, '&export=download')
    : videoUrl;

  try {
    console.log(`📥 Downloading video from ${directDownloadUrl}`);
    const response = await fetch(directDownloadUrl);
    const buffer = await response.buffer();

    if (!buffer || buffer.length < 10000) {
      console.error(`❌ File too small: ${buffer.length}`);
      return res.status(400).send('Downloaded file too small or invalid');
    }

    fs.writeFileSync(inputPath, buffer);
    console.log(`✅ Saved to ${inputPath}, size: ${buffer.length} bytes`);

    const startTime = Math.max(0, timestamp - 9);
    const clipDuration = 7;

    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(clipDuration)
      .output(outputPath)
      .on('start', commandLine => console.log("🔧 FFmpeg started:", commandLine))
      .on('end', async () => {
        try {
          console.log("✅ FFmpeg finished, uploading clip and metadata");

          const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C';
          const clipFileName = `clip_${videoId}.mp4`;
          const driveLink = await uploadToDrive(outputPath, clipFileName, folderId);

          const metadata = { player_id, player_name, action_type, match_id };
          fs.writeFileSync(metadataPath, JSON.stringify(metadata));
          await uploadToDrive(metadataPath, `clip_${videoId}.meta.json`, folderId);

          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);
          fs.unlinkSync(metadataPath);

          console.log("✅ Clip and metadata uploaded");
          res.json({ message: 'Clip and metadata uploaded to Google Drive', driveLink });
        } catch (uploadErr) {
          console.error('❌ Upload to Google Drive failed:', uploadErr);
          res.status(500).send('Upload to Google Drive failed');
        }
      })
      .on('error', err => {
        console.error('❌ FFmpeg failed:', err.message);
        res.status(500).send('FFmpeg failed');
      })
      .run();
  } catch (e) {
    console.error('❌ Video download or processing failed:', e.message);
    res.status(500).send('Video download or processing failed');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
