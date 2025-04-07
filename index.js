const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const mime = require('mime-types');
const uploadToDrive = require('./driveUploader');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

try {
  const raw = fs.readFileSync(credentialsPath, 'utf8');
  const parsed = JSON.parse(raw);
  console.log("✅ JSON credentials loaded. client_email:", parsed.client_email);
} catch (err) {
  console.error("❌ Failed to load credentials:", err);
}

const app = express();
const upload = multer({ dest: '/tmp' });

app.use(cors({ origin: '*' }));
app.use(express.json());

// ✅ API להעלאת משחקים מלאים
app.post('/upload-full-game', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    const match_id = req.body.match_id || uuidv4();
    if (!file) return res.status(400).send('No file uploaded');

    const extension = mime.extension(mime.lookup(file.path)) || 'mp4';
    const fileName = `full_game_${match_id}.${extension}`;
    const folderId = '1vu6elArxj6YKLZePXjoqp_UFrDiI5ZOC';

    const driveResponse = await uploadToDrive(file.path, fileName, folderId);

    try { fs.unlinkSync(file.path); } catch (e) { console.warn('⚠️ Failed to delete temp file:', e.message); }

    res.json({
      message: 'Full game uploaded',
      file_id: driveResponse.id,
      view_url: driveResponse.webViewLink,
      download_url: driveResponse.webContentLink
    });
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).send('Upload failed');
  }
});

// ✅ API ליצירת קליפ מתוך משחק
app.post('/generate-clip', async (req, res) => {
  const { videoUrl, timestamp, duration, player_id, player_name, action_type, match_id } = req.body;

  if (!videoUrl || timestamp == null || !duration) {
    return res.status(400).json({ error: 'Missing parameters' });
  }

  const videoId = uuidv4();
  const inputPath = `/tmp/input_${videoId}.mp4`;
  const outputPath = `/tmp/clip_${videoId}.mp4`;
  const metadataPath = `/tmp/clip_${videoId}.meta.json`;

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
          const clipFileName = `clip_${videoId}.mp4`;

          const driveLink = await uploadToDrive(outputPath, clipFileName, folderId);

          const metadata = { player_id, player_name, action_type, match_id };
          fs.writeFileSync(metadataPath, JSON.stringify(metadata));
          await uploadToDrive(metadataPath, `clip_${videoId}.meta.json`, folderId);

          try { fs.unlinkSync(inputPath); } catch (e) { console.warn('⚠️ Failed to delete input:', e.message); }
          try { fs.unlinkSync(outputPath); } catch (e) { console.warn('⚠️ Failed to delete output:', e.message); }
          try { fs.unlinkSync(metadataPath); } catch (e) { console.warn('⚠️ Failed to delete metadata:', e.message); }

          res.json({ message: 'Clip and metadata uploaded to Google Drive', driveLink });
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

// ✅ API לשליפת קליפים
app.get('/clips', async (req, res) => {
  try {
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

    const files = response.data.files;

    const clips = await Promise.all(
      files.filter(f => f.name.endsWith('.mp4')).map(async (file) => {
        const baseName = path.basename(file.name, '.mp4');
        const metadataFileName = `${baseName}.meta.json`;
        const metadataFile = files.find(f => f.name === metadataFileName);

        let metadata = {};

        if (metadataFile) {
          try {
            const metadataResponse = await drive.files.get({ fileId: metadataFile.id, alt: 'media' }, { responseType: 'stream' });
            const chunks = [];
            for await (const chunk of metadataResponse.data) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);
            metadata = JSON.parse(buffer.toString());
          } catch (err) {
            console.error(`Failed to read metadata for ${file.name}:`, err);
          }
        }

        return {
          external_id: file.id,
          name: file.name,
          view_url: `https://drive.google.com/file/d/${file.id}/view?usp=sharing`,
          download_url: `https://drive.google.com/uc?id=${file.id}&export=download`,
          thumbnail_url: `https://drive.google.com/thumbnail?id=${file.id}`,
          duration: 6,
          created_date: file.createdTime,
          ...metadata
        };
      })
    );

    res.json({ clips });
  } catch (err) {
    console.error('❌ Failed to fetch clips:', err);
    res.status(500).send('Failed to fetch clips');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
