app.post('/upload-segment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    const { match_id, start_time, duration } = req.body;

    const segmentId = uuidv4();
    const inputPath = req.file.path;
    const clipPath = `/tmp/segment_${segmentId}.mp4`;

    const ffmpegCmd = `ffmpeg -ss ${start_time} -i ${inputPath} -t ${duration} -y ${clipPath}`;
    console.log(`🎞️ FFmpeg cutting segment: ${ffmpegCmd}`);

    await new Promise((resolve, reject) => {
      exec(ffmpegCmd, (error) => {
        if (error) {
          console.error('❌ FFmpeg failed:', error.message);
          return reject(error);
        }
        resolve();
      });
    });

    const driveRes = await uploadToDrive({
      filePath: clipPath,
      metadata: {
        clip_id: segmentId,
        match_id,
        created_date: new Date().toISOString(),
        duration,
        player_id: 'segment_mode',
        player_name: 'מקטע בדיקה',
        action_type: 'segment_upload'
      },
    });

    // Clean up
    fs.unlinkSync(inputPath);
    fs.unlinkSync(clipPath);

    res.status(200).json({ success: true, clip: driveRes });
  } catch (error) {
    console.error('🔥 Error in /upload-segment:', error.message);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});
