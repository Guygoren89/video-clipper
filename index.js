const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const { uploadFileToDrive } = require('./driveUploader'); // 👈 חדש

const app = express();
app.use(cors());
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
      .setStartTime(Math.max(0, timestamp - 5)) // 👈 פחות 5 שניות
      .setDuration(6) // 👈 אורך קליפ 6 שניות
      .output(outputPath)
      .on('end', async () => {
        try {
          const folderId = '1onJ7niZb1PE1UBvDu2yBuiW1ZCzADv2C'; // 👈 קליפים
          const driveLink = await uploadFileToDrive(outputPath, `clip_${videoId}.mp4`, folderId);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Video Clipper running on port ${PORT}`);
});
