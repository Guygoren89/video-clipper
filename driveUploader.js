const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive = google.drive({ version: 'v3', auth });

// קיימת פונקציה uploadToDrive - נשאיר אותה

// פונקציה חדשה: הורדת קובץ לפי fileId
async function downloadFileFromDrive(fileId, destinationPath) {
  const dest = fs.createWriteStream(destinationPath);
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );
  await new Promise((resolve, reject) => {
    res.data
      .pipe(dest)
      .on('finish', () => {
        console.log(`✅ Downloaded file ${fileId}`);
        resolve();
      })
      .on('error', reject);
  });
}

module.exports = {
  uploadToDrive,
  downloadFileFromDrive, // <-- אל תשכח להוסיף ל-exports
};
