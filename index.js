// index.js (updated with detailed logging - Phase 1)
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

// המשך השלבים יגיע בהמשך - זה שלב 1

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
