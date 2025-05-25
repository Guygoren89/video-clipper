async function cutClipFromDriveFile({
  fileId,
  previousFileId = null,
  startTimeInSec,
  durationInSec,
  matchId,
  actionType,
  playerName,
  teamColor,
  assistPlayerName
}) {
  const clipId = uuidv4();
  const outputPath = `/tmp/clip_${clipId}.webm`;

  // מיזוג אם יש previousFileId
  let finalInputPath;

  if (previousFileId) {
    const input1 = `/tmp/input_${previousFileId}.webm`;
    const input2 = `/tmp/input_${fileId}.webm`;
    const mergedPath = `/tmp/merged_${clipId}.webm`;

    await downloadFileFromDrive(previousFileId, input1);
    await downloadFileFromDrive(fileId, input2);

    const mergeCommand = `ffmpeg -i ${input1} -i ${input2} -filter_complex "[0:v:0][1:v:0]concat=n=2:v=1[outv]" -map "[outv]" -y ${mergedPath}`;
    console.log('🎬 FFmpeg Merge:', mergeCommand);

    await new Promise((resolve, reject) => {
      exec(mergeCommand, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    finalInputPath = mergedPath;

    if (fs.existsSync(input1)) fs.unlinkSync(input1);
    if (fs.existsSync(input2)) fs.unlinkSync(input2);
  } else {
    finalInputPath = `/tmp/input_${fileId}.webm`;
    await downloadFileFromDrive(fileId, finalInputPath);
  }

  const cutCommand = `ffmpeg -ss ${startTimeInSec} -i ${finalInputPath} -t ${durationInSec} -c copy -y ${outputPath}`;
  console.log('✂️ FFmpeg Cut:', cutCommand);

  await new Promise((resolve, reject) => {
    exec(cutCommand, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const uploaded = await uploadToDriveUnified({
    filePath: outputPath,
    metadata: {
      match_id: matchId,
      action_type: actionType,
      player_name: playerName,
      team_color: teamColor,
      assist_player_name: assistPlayerName,
      duration: durationInSec,
      created_date: new Date().toISOString(),
      custom_name: `clip_${matchId}_${clipId}.webm`,
    },
    isFullClip: false
  });

  // ניקוי קבצים זמניים
  if (fs.existsSync(finalInputPath)) fs.unlinkSync(finalInputPath);
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

  return uploaded;
}
