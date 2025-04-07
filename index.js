// index.js (Phase 3 - multiple clip generation support)
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

// ✅ API ליצירת מספר קליפים בבת אחת
app.post('/generate-clips', async (req, res) => {
  const { videoUrl, actions } = req.body;
  if (!videoUrl || !Array.isArray(actions) || actions.length === 0) {
    return res.status(400).json({ error: 'Missing videoUrl or actions[]' });
  }

  console.log("🎬 Received /generate-clips request with", actions.length, "clips");

  const results = [];
  for (const action of actions) {
    const {
      timestamp,
      duration = 7,
      player_id,
      player_name,
      action_type,
      match_id
    } = action;

    const clipId = uuidv4();
    const inputPath = `/tmp/input_${clipId}.mp4`;
    const outputPath = `/tmp/clip_${clipId}.mp4`;
    const metadataPath = `/tmp/clip_${clipId}.meta.json`;
    try {
      const response = await fetch(videoUrl);
      const buffer = await response.buffer();

      if (!buffer || buffer.length < 10000) {
        console.error(`❌ Clip ${clipId} skipped: File too small (${buffer.length})`);
        continue;
      }

      fs.writeFileSync(inputPath, buffer);
      console.log(`📥 Clip ${clipId}: Video saved to ${inputPath}`);

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .setStartTime(Math.max(0, timestamp - 9))
          .setDuration(duration)
          .output(outputPath)
          .on('start', cmd => console.log(`🔧 Clip ${clipId}: FFmpeg started`))
          .on('end', async () => {
            try {
              const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C';
              const fileName = `clip_${clipId}.mp4`;
              const driveLink = await uploadToDrive(outputPath, fileName, folderId);
              const metadata = { player_id, player_name, action_type, match_id };
              fs.writeFileSync(metadataPath, JSON.stringify(metadata));
              await uploadToDrive(metadataPath, `clip_${clipId}.meta.json`, folderId);
              results.push({ clip_id: clipId, driveLink });
              fs.unlinkSync(inputPath);
              fs.unlinkSync(outputPath);
              fs.unlinkSync(metadataPath);
              console.log(`✅ Clip ${clipId} uploaded`);
              resolve();
            } catch (err) {
              console.error(`❌ Clip ${clipId} failed to upload`, err);
              reject(err);
            }
          })
          .on('error', err => {
            console.error(`❌ FFmpeg error (clip ${clipId}):`, err.message);
            reject(err);
          })
          .run();
      });
    } catch (e) {
      console.error(`❌ Error in clip ${clipId}:`, e.message);
    }
  }

  res.json({ message: 'Finished processing clips', results });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
