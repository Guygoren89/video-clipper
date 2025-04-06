const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
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

// ✅ CORS הגדרה שמאפשרת גישה חיצונית
app.use(cors({
  origin: '*', // אפשר לשנות לכתובת ספציפית בעתיד
}));

app.use(express.json());

app.post('/generate-clip', async (req, res) => {
  const { videoUrl, timestamp, duration } = req.body;
  if (!videoUrl || timestamp == null || !duration) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const videoId = uuidv4();
  const inputPath = `/tmp/input_${videoId}.mp4`;
  const outputPath = `/tmp/clip_${videoId}.mp4`;

  try {
    const response = await fetch(videoUrl);
    const buffer = await response.buffer();
    fs.writeFileSync(inputPath, buffer);

    ffmpeg(inputPath)
      .setStartTime(Math.max(0, timestamp - 5))
      .setDuration(6)
      .output(outputPath)
      .on('end', async () => {
        try {
          const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C';
          const driveLink = await uploadToDrive(outputPath, `clip_${videoId}.mp4`, folderId);

          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);

          res.json({ message: 'Clip uploaded to Google Drive', driveLink });
        } catch (uploadErr) {
          console.error('Upload failed:', uploadErr);
          res.status(500).send('Upload to Google Drive failed');
        }
      })
      .on('error', (err) => {
        console.error(err);
        res.status(500).send('FFmpeg failed');
      })
      .run();
  } catch (e) {
    console.error(e);
    res.status(500).send('Video download or processing failed');
  }
});

app.get('/clips', async (req, res) => {
  try {
    const { google } = require('googleapis');
    const { GoogleAuth } = require('google-auth-library');

    const auth = new GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    const authClient = await auth.getClient();
    const drive = google.drive({ version: 'v3', auth: authClient });

    const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C';
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
    });

    const clips = response.data.files.map(file => ({
      external_id: file.id,
      name: file.name,
      view_url: `https://drive.google.com/file/d/${file.id}/view?usp=sharing`,
      download_url: `https://drive.google.com/uc?id=${file.id}&export=download`,
      thumbnail_url: `https://drive.google.com/thumbnail?id=${file.id}`,
      duration: 6,
      created_date: file.createdTime,
    }));

    res.json({ clips });
  } catch (err) {
    console.error('❌ Failed to fetch clips:', err);
    res.status(500).send('Failed to fetch clips');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video Clipper running on port ${PORT}`);
});
