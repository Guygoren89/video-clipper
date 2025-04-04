const fs = require('fs');
const { google } = require('googleapis');
const mime = require('mime-types');  // להוסיף אם רוצים קביעת mimeType אוטומטית

async function uploadToDrive(filePath, fileName, folderId) {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  // הגדרת המידע על הקובץ
  const fileMetadata = {
    name: fileName,
    parents: [folderId],  // מזהה התיקיה ב-Google Drive
  };

  // קביעת mimeType אוטומטית
  const mimeType = mime.lookup(filePath) || 'application/octet-stream';  // אם לא נמצא mimeType, ישתמש ב-default

  const media = {
    mimeType: mimeType,  // כאן מותאם mimeType דינאמית
    body: fs.createReadStream(filePath),
  };

  // העלאת הקובץ ל-Google Drive
  const response = await drive.files.create({
    requestBody: fileMetadata,
    media: media,
    fields: 'id, webViewLink, webContentLink',  // החזרת המידע החשוב: מזהה הקובץ, לינק לצפייה בלייב, לינק להורדה
  });

  // מחזירים את התשובה, כולל את הלינק לצפייה וללינק להורדה
  return response.data;
}

module.exports = uploadToDrive;
