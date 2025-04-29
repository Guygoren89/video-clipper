const express = require('express');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const { uploadToDrive, generateThumbnail, listClipsFromDrive } = require('./driveUploader');
const { addSegment, getSegments, clearSegments } = require('./segmentsManager');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const upload = multer({ dest: '/tmp' });

app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { path: filePath, originalname } = req.file;
    const { match_id, start_time, duration } = req.body;

    if (!match_id || !start_time || !duration) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    addSegment(match_id, {
      filePath,
      originalName: originalname,
      startTime: parseFloat(start_time),
      duration: parseFloat(duration),
    });

    console.log(`✅ Segment received for match ${match_id}: ${originalname}, start ${start_time}s, duration ${duration}s`);

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('🔥 Failed to upload segment:', error.message);
    res.status(500).json({ success: false, error: 'Failed to upload segment' });
  }
});

app.post('/generate-clips', async (req, res) => {
  const { actions, match_id } = req.body;
  console.log('🎬 Received /generate-clips request:', JSON.stringify(req.body, null, 2));

  try {
    const segments = getSegments(match_id);
    if (segments.length === 0) {
      return res.status(400).json({ success: false, error: 'No segments found for this match' });
    }

    for (const action of actions) {
      const { timestamp, duration, player_id, player_name, action_type, match_id } = action;
      const clipId = uuidv4();
      const clipPath = `/tmp/clip_${clipId}.mp4`;

      const start = Math.max(0, timestamp - 6); // מתחילים 6 שניות אחורה מהפעולה

      // מוצאים אילו מקטעים רלוונטיים
      const relevantSegments = segments.filter(seg =>
        seg.startTime <= start + duration && (seg.startTime + seg.duration) >= start
      );

      if (relevantSegments.length === 0) {
        console.error(`⚠️ No relevant segments found for action at ${start}s`);
        continue;
      }

      console.log(`🎞️ Creating clip for player ${player_name}, using ${relevantSegments.length} segment(s)`);

      // בונים את פקודת ה-ffmpeg בהתאם
      const inputListPath = `/tmp/input_list_${clipId}.txt`;
      const fileList = relevantSegments.map(seg => `file '${seg.filePath}'`).join('\n');
      fs.writeFileSync(inputListPath, fileList);

      const concatOutput = `/tmp/concat_${clipId}.mp4`;
      await new Promise((resolve, reject) => {
        exec(`ffmpeg -f concat -safe 0 -i ${inputListPath} -c copy ${concatOutput}`, (error) => {
          if (error) {
            return reject(error);
          }
          resolve();
        });
      });

      const ffmpegCmd = `ffmpeg -ss ${start} -i ${concatOutput} -y -t ${duration} ${clipPath}`;
      console.log(`🔧 FFmpeg cutting clip: ${ffmpegCmd}`);

      await new Promise((resolve, reject) => {
        exec(ffmpegCmd, (error) => {
          if (error) {
            return reject(error);
          }
          resolve();
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

      console.log(`✅ Clip uploaded: ${clipDriveData.view_url}`);
    }

    clearSegments(match_id);
    console.log('🧹 Cleaned up segments after clip generation');

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
