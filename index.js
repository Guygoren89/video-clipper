const express = require('express');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { uploadToDrive } = require('./driveUploader');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const upload = multer({ storage: multer.memoryStorage() });

app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      console.error("❌ No file uploaded");
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { match_id = 'test_upload', start_time = '00:00:00', duration = '00:00:12' } = req.body;
    const segmentId = uuidv4();

    const inputPath = `/tmp/input_${segmentId}.mp4`;
    const outputPath = `/tmp/segment_${segmentId}.mp4`;

    fs.writeFileSync(inputPath, req.file.buffer);
    console.log(`✅ File received. Starting FFmpeg cut...`);

    const ffmpegCmd = `ffmpeg -ss ${start_time} -i ${inputPath} -t ${duration} -y ${outputPath}`;
    console.log("🎞️ FFmpeg command:", ffmpegCmd);

    exec(ffmpegCmd, async (error) => {
      if (error) {
        console.error("❌ FFmpeg failed:", error.message);
        return res.status(500).json({ success: false, error: 'FFmpeg failed' });
      }

      if (!fs.existsSync(outputPath)) {
        console.error("❌ FFmpeg output file not found");
        return res.status(500).json({ success: false, error: 'Output file missing' });
      }

      console.log("📦 FFmpeg finished. File ready:", outputPath);

      try {
        console.log("🚀 Uploading to Google Drive...");
        const driveRes = await uploadToDrive({
          filePath: outputPath,
          metadata: {
            clip_id: segmentId,
            match_id,
            created_date: new Date().toISOString(),
            duration,
            player_id: "manual",
            player_name: "Test Upload",
            action_type: "manual_clip",
          }
        });

        console.log("✅ Upload success:", driveRes.view_url);
        return res.status(200).json({ success: true, clip: driveRes });
      } catch (uploadError) {
        console.error("❌ Upload failed:", uploadError.message);
        return res.status(500).json({ success: false, error: 'Upload to Drive failed' });
      }
    });

  } catch (err) {
    console.error("🔥 Unexpected error:", err.message);
    return res.status(500).json({ success: false, error: 'Unexpected Server Error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
