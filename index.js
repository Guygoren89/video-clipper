// index.js (Phase 3 - support batch clip generation)
const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const multer = require('multer');
const uploadToDrive = require('./driveUploader');

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

// ✅ API חדש ליצירת מספר קליפים
app.post('/generate-clips', async (req, res) => {
  const { videoUrl, actions } = req.body;

  if (!videoUrl || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'Missing or invalid videoUrl/actions' });
  }

  console.log("🎬 Received /generate-clips request:", req.body);

  const videoId = uuidv4();
  const inputPath = `/tmp/input_${videoId}.mp4`;

  try {
    const response = await fetch(videoUrl);
    const buffer = await response.buffer();

    if (!buffer || buffer.length < 10000) {
      console.error(`❌ File too small: ${buffer.length}`);
      return res.status(400).send('Downloaded file too small or invalid');
    }

    fs.writeFileSync(inputPath, buffer);
    console.log(`✅ Full video downloaded: ${inputPath}, size: ${buffer.length} bytes`);

    const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C';
    const results = [];

    for (const action of actions) {
      const {
        timestamp,
        duration,
        player_id,
        player_name,
        action_type,
        match_id
      } = action;

      const clipId = uuidv4();
      const clipPath = `/tmp/clip_${clipId}.mp4`;
      const metadataPath = `/tmp/clip_${clipId}.meta.json`;
      const startTime = Math.max(0, timestamp - 9);

      console.log(`🎞️ Creating clip: start=${startTime}, duration=${duration}`);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(startTime)
          .setDuration(duration)
          .output(clipPath)
          .on('start', cmd => console.log("🔧 FFmpeg started:", cmd))
          .on('end', resolve)
          .on('error', err => {
            console.error('❌ FFmpeg failed:', err.message);
            reject(err);
          })
          .run();
      });

      const clipName = `clip_${clipId}.mp4`;
      const driveClip = await uploadToDrive(clipPath, clipName, folderId);

      const metadata = { player_id, player_name, action_type, match_id };
      fs.writeFileSync(metadataPath, JSON.stringify(metadata));
      await uploadToDrive(metadataPath, `clip_${clipId}.meta.json`, folderId);

      results.push({
        external_id: driveClip.id,
        name: clipName,
        view_url: driveClip.webViewLink,
        download_url: driveClip.webContentLink,
        thumbnail_url: `https://drive.google.com/thumbnail?id=${driveClip.id}`,
        duration,
        created_date: new Date().toISOString(),
        player_id,
        player_name,
        action_type,
        match_id
      });

      fs.unlinkSync(clipPath);
      fs.unlinkSync(metadataPath);
    }

    fs.unlinkSync(inputPath);
    console.log("✅ All clips created and uploaded");
    res.json({ message: 'All clips uploaded', clips: results });
  } catch (e) {
    console.error('❌ Batch clip processing failed:', e.message);
    res.status(500).send('Batch processing failed');
  }
});

// ✅ פורט קבוע ל־Render
const PORT = 10000;
app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
