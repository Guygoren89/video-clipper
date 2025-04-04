const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors'); // שימוש ב־CORS

const app = express();
app.use(cors()); // הפעלת CORS
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
      .setStartTime(timestamp)
      .setDuration(duration)
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('FFmpeg command:', commandLine);
      })
      .on('end', () => {
        res.download(outputPath, `clip_${videoId}.mp4`, () => {
          fs.unlinkSync(inputPath);
          fs.unlinkSync(outputPath);
        });
      })
      .on('error', (err, stdout, stderr) => {
        console.error('FFmpeg error:', err.message);
        console.error('FFmpeg stderr:', stderr);
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
