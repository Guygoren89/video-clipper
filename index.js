const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const { uploadToDrive, generateThumbnail, listClipsFromDrive } = require('./driveUploader');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.post('/generate-clips', async (req, res) => {
  const { videoUrl, actions } = req.body;
  console.log('🎬 Received /generate-clips request:', JSON.stringify(req.body, null, 2));

  const tempInputPath = `/tmp/input_${uuidv4()}.mp4`;

  try {
    const video = await axios.get(videoUrl, { responseType: 'stream' });
    const writer = fs.createWriteStream(tempInputPath);

    await new Promise((resolve, reject) => {
      video.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const stats = fs.statSync(tempInputPath);
    console.log(`✅ Full video downloaded: ${tempInputPath}, size: ${stats.size} bytes`);

    for (const action of actions) {
      const { timestamp, duration, player_id, player_name, action_type, match_id } = action;
      const clipId = uuidv4();
      const clipPath = `/tmp/clip_${clipId}.mp4`;
      const start = Math.max(0, timestamp - 9); // 9 seconds before action

      console.log(`\n🎞️ Creating clip: start=${start}, duration=${duration}, player=${player_name}`);

      const ffmpegCmd = `ffmpeg -ss ${start} -i ${tempInputPath} -y -t ${duration} ${clipPath}`;
      console.log(`🔧 FFmpeg started: ${ffmpegCmd}`);

      try {
        await new Promise((resolve, reject) => {
          exec(ffmpegCmd, (error, stdout, stderr) => {
            if (error) {
              console.error(`❌ FFmpeg error for ${player_name}:`, error.message);
              reject(error);
            } else {
              resolve();
            }
          });
        });

        const thumbnailPath = await generateThumbnail(clipPath);
        const clipDriveData = await uploadToDrive({
          filePath: clipPath,
          thumbnailPath,
          metadata: {
            clip_id: clipId,
            player_id,
            player_name,
            action_type,
            match_id,
            created_date: new Date().toISOString(),
            duration,
          },
        });

        console.log(`✅ Clip uploaded: ${clipDriveData.view_url}\n`);
      } catch (clipError) {
        console.error(`⚠️ Failed to process clip for ${player_name}:`, clipError.message);
      }
    }

    fs.unlinkSync(tempInputPath);
    console.log('🧹 Cleaned up input video');

    res.status(200).json({ success: true, message: 'All clips processed.' });
  } catch (error) {
    console.error('🔥 Fatal error:', error.message);
    res.status(500).json({ success: false, error: 'Failed to process clips' });
  }
});

app.get('/clips', async (req, res) => {
  try {
    const clips = await listClipsFromDrive();
    res.status(200).json({ success: true, clips });
  } catch (error) {
    console.error('🔥 Failed to fetch clips:', error.message);
    res.status(500).json({ success: false, error: 'Failed to fetch clips' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Video Clipper running on port ${PORT}`);
});
