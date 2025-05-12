function formatTime(seconds) {
  const mins = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secs = String(seconds % 60).padStart(2, '0');
  return `00:${mins}:${secs}`;
}

// פונקציית דמה – לא השתמשנו אז ב-cutClip
async function cutClipFromDriveFile() {
  return null;
}

module.exports = {
  formatTime,
  cutClipFromDriveFile
};
