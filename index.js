/* =======================================================================
 *  index.js – Football Clips Server  (Render)
 *  27-May-2025   |   שינוי: limit + before  (pagination)  +  cache
 * ======================================================================= */
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const { google } = require('googleapis');
const {
  uploadToDrive, formatTime, cutClipFromDriveFile
} = require('./segmentsManager');

/* ---------- Google Drive ---------- */
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const auth   = new google.auth.GoogleAuth({ scopes: SCOPES });
const drive  = google.drive({ version: 'v3', auth });

/* ---------- constants ---------- */
const SHORT_CLIPS_FOLDER_ID = '1Lb0MSD-CKIsy1XCqb4b4ROvvGidqtmzU';
const CACHE_TTL_MS          = 60_000;

/* ---------- cache ---------- */
let clipsCache = { ts: 0, firstPage: [] };

/* ---------- helpers ---------- */
function mapFile(f){
  return {
    external_id : f.id,
    name        : f.name,
    view_url    : `https://drive.google.com/file/d/${f.id}/view`,
    download_url: `https://drive.google.com/uc?export=download&id=${f.id}`,
    created_date: f.createdTime,
    ...f.properties
  };
}

/* ---------- express ---------- */
const app = express();
const upload = multer({ dest: 'uploads/' });
app.use(cors({ origin:true }));
app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true}));

app.get('/health', (_,res)=>res.send('OK'));

/* =====================  GET /clips  ===================== *
 * query params:
 *   limit   – default 25, max 100
 *   before  – ISO date or drive fileId time (RFC3339) → מחזיר קליפים שנוצרו לפני
 * ======================================================== */
app.get('/clips', async (req,res)=>{
  try{
    const limit  = Math.min(Number(req.query.limit)||25, 100);
    const before = req.query.before || null;

    /* ----- מאחז first page ----- */
    if(!before){
      const fresh = Date.now() - clipsCache.ts > CACHE_TTL_MS;
      if(fresh || clipsCache.firstPage.length === 0){
        console.log('🌐 /clips first page → Drive');
        const list = await drive.files.list({
          q      : `'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed = false`,
          orderBy: 'createdTime desc',
          pageSize: limit,
          fields : 'files(id,name,createdTime,properties)',
        });
        clipsCache = { ts:Date.now(), firstPage:list.data.files.map(mapFile) };
      } else {
        console.log('🗄️  /clips first page → cache hit');
      }
      return res.json(clipsCache.firstPage);
    }

    /* ----- עמודים נוספים (before) ----- */
    console.log('🌐 /clips page after "before":', before);
    const list = await drive.files.list({
      q      : `'${SHORT_CLIPS_FOLDER_ID}' in parents and trashed = false and createdTime < '${before}'`,
      orderBy: 'createdTime desc',
      pageSize: limit,
      fields : 'files(id,name,createdTime,properties)',
    });
    return res.json(list.data.files.map(mapFile));
  }catch(e){
    console.error('[ERROR] /clips', e.message);
    res.status(500).json({ error:'failed' });
  }
});

/* ----- (שאר המסלולים /upload-segment, /auto-generate-clips, /generate-clips) נשארים כמו בגרסה הקודמת ----- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('📡 server on', PORT));
