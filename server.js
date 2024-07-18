const { google } = require('googleapis');
const fs = require('fs');
const express = require('express');
const cors = require("cors");
const path = require('path');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const pipeline = promisify(require('stream').pipeline);
require('dotenv').config();
const multer = require("multer");
const { json } = require('body-parser');

const app = express();
app.use(express.json());
app.use(cors());
const upload = multer({ dest: "uploads/" });

const oauth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
);

oauth2Client.setCredentials({ refresh_token: process.env.REFRESH_TOKEN });

const drive = google.drive({
    version: 'v3',
    auth: oauth2Client,
});

app.post("/selected", searchfile);
app.post("/downloadall", getFolderId, bulkdownload);
app.post("/createFolder", createFolder);
app.post("/downloadfile", downloadfilefun);
app.post("/getallfolders", getallfolders, createFolder);

app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'test', filename);

    res.download(filePath, (err) => {
        if (err) {
            console.error('Error downloading file:', err);
            res.status(500).send('Error downloading file');
        } else {
            console.log('File downloaded successfully');
        }
    });
});

async function getFolderId(req, res, next) {
    const { folderName } = req.body;
    console.log(folderName);
    try {
        const response = await drive.files.list({
            q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`,
            fields: 'files(id, name)',
            spaces: 'drive',
        });
        const folders = response.data.files;
        if (folders.length) {
            console.log(`Folder ID for "${folderName}": ${folders[0].id}`);
            req.folderId = folders[0].id;
            next();
        } else {
            console.log(`No folder found with the name "${folderName}".`);
            res.status(404).send('Folder not found');
        }
    } catch (error) {
        console.error("Error finding folder:", error.message);
        res.status(500).send('Error finding folder');
    }
}

async function getallfolders(req, res, next) {
    try {
        const { foldername } = req.body;
        const response = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.folder'",
            fields: 'files(name)',
            spaces: 'drive',
        });
        const files = response.data.files;
        for (const file of files) {
            if (file.name === foldername) {
                return res.status(500).send("Folder already present");
            }
        }
        next();
    } catch (error) {
        console.error("Error searching files:", error.message);
        res.status(500).send('Error searching files');
    }
}

async function searchfile(req, res) {
    const { selectedFiles } = req.body;
    console.log(selectedFiles, "SELECTEDFILES ..");
    
    if (!selectedFiles || selectedFiles.length === 0) {
        return res.status(400).send('No files selected');
    }

    const files = [];
    try {
        for (let file of selectedFiles) {
            console.log(file.split("/")[0])
            const folderID = await getOrCreateFolder(file.split("/")[0]);
            console.log(folderID)
            const response = await drive.files.list({
                q: `'${folderID}' in parents and name='${file.split("/")[1]}'`,
                fields: 'files(id, name)',
                spaces: 'drive',
            });
            files.push(...response.data.files);
            console.log(files)
        }

        const zipFileName = `${uuidv4()}.zip`;
        const zipPath = `./test/${zipFileName}`;
        const zip = new AdmZip();
        for (const file of files) {
            // await download(file.id, file.name);
            const fileStream = await drive.files.get({
                fileId: file.id,
                alt: 'media',
            }, { responseType: 'stream' });

            const tempFilePath = path.join(__dirname, 'test', file.name);
            const tempFile = fs.createWriteStream(tempFilePath);
            await pipeline(fileStream.data, tempFile);

            zip.addLocalFile(tempFilePath);
            fs.unlinkSync(tempFilePath);
        }
        zip.writeZip(zipPath);

        console.log('Archive has been finalized.');
        const downloadLink = `${req.protocol}://${req.get('host')}/download/${zipFileName}`;
        res.status(200).json({ message: 'Bulk download complete', link: downloadLink });
        // res.status(200).send(files);
    } catch (error) {
        console.error("Error searching files:", error.message);
        res.status(500).send('Error searching files');
    }
}

async function download(fileId, fileName) {
    try {
        const file = await drive.files.get({
            fileId: fileId,
            alt: 'media',
        }, { responseType: 'stream' });
        const destPath = `./test/${fileName}`;
        const dest = fs.createWriteStream(destPath);
        await pipeline(file.data, dest);
        console.log('Download complete');
    } catch (error) {
        console.error("Error downloading file:", error.message);
    }
}

async function bulkdownload(req, res) {
    try {
        const folderID = req.folderId;
        const filesResponse = await drive.files.list({
            q: `'${folderID}' in parents`,
            fields: 'files(id, name)',
        });
        const files = filesResponse.data.files;
        const zipFileName = `${uuidv4()}.zip`;
        const zipPath = `./test/${zipFileName}`;
        const zip = new AdmZip();

        for (const file of files) {
            const fileStream = await drive.files.get({
                fileId: file.id,
                alt: 'media',
            }, { responseType: 'stream' });

            const tempFilePath = path.join(__dirname, 'test', file.name);
            const tempFile = fs.createWriteStream(tempFilePath);
            await pipeline(fileStream.data, tempFile);

            zip.addLocalFile(tempFilePath);
            fs.unlinkSync(tempFilePath);  // Remove the temporary file after adding to zip
        }

        zip.writeZip(zipPath);

        console.log('Archive has been finalized.');
        const downloadLink = `${req.protocol}://${req.get('host')}/download/${zipFileName}`;
        res.status(200).json({ message: 'Bulk download complete', downloadLink });

    } catch (error) {
        console.error("Error in bulk download:", error.message);
        res.status(500).send('Error in bulk download');
    }
}

async function createFolder(req, res) {
    const { folderName } = req.body;
    const fileMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
    };
    try {
        const file = await drive.files.create({
            requestBody: fileMetadata,
            fields: 'id',
        });
        console.log('Folder Id:', file.data.id);
        res.status(200).send('Folder creation success');
    } catch (err) {
        console.error('Error creating folder:', err.message);
        res.status(500).send('Error creating folder');
    }
}

async function getOrCreateFolder(folderName) {
    try {
      // Check if the folder already exists
      const response = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });
  
      const folders = response.data.files;
      if (folders.length > 0) {
        return folders[0].id;
      } else {
        // Create the folder if it does not exist
        const folderMetadata = {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
        };
        const folder = await drive.files.create({
          requestBody: folderMetadata,
          fields: 'id',
        });
        return folder.data.id;
      }
    } catch (error) {
      console.error('Error getting or creating folder:', error);
      throw error;
    }
}

async function processBatch(files, folderId) {
    const uploadPromises = files.map(async (file) => {
      const fileMetadata = {
        name: file.originalname,
        parents: [folderId], // Specify the parent folder ID
      };
      const media = {
        mimeType: file.mimetype,
        body: fs.createReadStream(file.path),
      };
  
      try {
        const response = await drive.files.create({
          requestBody: fileMetadata,
          media: media,
          fields: "id",
        });
        fs.unlinkSync(file.path);
        return response.data;
      } catch (error) {
        console.error("Error uploading file:", error);
        throw error;
      }
    });
  
    return await Promise.all(uploadPromises);
}

const GetFolderId = async (folderName) => {
    try {
      const response = await drive.files.list({
        q: `mimeType='application/vnd.google-apps.folder' and name='${folderName}'`,
        fields: "files(id, name)",
        spaces: "drive",
      });
      const folders = response.data.files;
      if (folders.length > 0) {
        return folders[0].id;
      }
    } catch (error) {
      console.error("Error getting folder:", error);
      throw error;
    }
};

const getDownloadLinkFromName = async (fileName, folderId) => {
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and name='${fileName}' and trashed=false`,
        fields: "files(id, name, webContentLink)",
      });
      const files = res.data.files;
      if (files.length === 0) {
        throw new Error("No files found");
      }
      return files[0].webContentLink;
    } catch (error) {
      console.error("Error fetching download link:", error);
      throw error;
    }
};

async function downloadfilefun (req,res) {
    const { filename, folderName } = req.body
    console.log(filename,folderName)

    try {
          const folderId = await GetFolderId(folderName)
          console.log(folderId)
          const downloadLink = await getDownloadLinkFromName(filename, folderId);
          console.log(downloadLink)
          res.status(200).json({ message: 'download complete', link: downloadLink });
    } catch (error) {
        console.error("Error searching files:", error.message);
        res.status(500).send('Error searching files');
    }
}

app.post("/upload", upload.array("files"), async (req, res) => {

    const folderName = req.body.folderName || 'defaultFolder';
    console.log(folderName)
    try {
      const folderId = await getOrCreateFolder(folderName);
      console.log(folderId)
      const files = req.files;
      console.log(files,files.length)
      const batchSize = 10;
      let results = [];
      for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        const batchResults = await processBatch(batch, folderId);
        results = results.concat(batchResults);
        res.write(JSON.stringify(batchResults));
      }
    res.end();
    } catch (error) {
      res.status(500).send(error.message);
    }
});

const downloadDir = path.join(__dirname, 'test');
if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir);
}

app.listen(8080, () => {
    console.log('Server is running on port 8080');
});
