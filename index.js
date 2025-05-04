// ... כל הייבואים כמו בקוד שלך

app.post('/upload-segment', upload.single('file'), async (req, res) => {
  console.log("📅 התחיל תהליך /upload-segment");

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'לא התקבל קובץ' });
  }

  const debugPath = `/tmp/debug_${Date.now()}.webm`;
  fs.writeFileSync(debugPath, req.file.buffer);

  const { match_id = 'test_upload', start_time = '00:00:00', duration = '00:00:20' } = req.body;
  const segmentId = uuidv4();

  const inputPath = `/tmp/input_${segmentId}.webm`;
  const outputPath = `/tmp/segment_${segmentId}.webm`;

  fs.writeFileSync(inputPath, req.file.buffer);

  const ffmpegCmd = `ffmpeg -ss ${start_time} -i ${inputPath} -t ${duration} -c copy -y ${outputPath}`;
  console.log("🎞️ FFmpeg command:", ffmpegCmd);

  // עונים מיד ללקוח כדי לא לחסום המשך הקלטה
  res.status(200).json({ success: true, clip: { external_id: segmentId } });

  // מעבדים ומעלים ברקע
  exec(ffmpegCmd, async (error) => {
    if (error) {
      console.error("❌ FFmpeg נכשל:", error.message);
      return;
    }

    try {
      const driveRes = await uploadToDrive({
        filePath: outputPath,
        metadata: {
          clip_id: segmentId,
          match_id,
          created_date: new Date().toISOString(),
          duration,
          player_id: "manual",
          player_name: "Test Upload",
          action_type: "segment_upload"
        }
      });

      console.log("✅ הועלה בהצלחה:", driveRes.view_url);
    } catch (err) {
      console.error("🚨 שגיאה בהעלאה ל-Drive:", err.message);
    }
  });
});
