const fs = require('fs');
const { EJSON } = require('bson');
const util = require('util');
const archiver = require('archiver');
const unzipper = require('unzipper');
const unlink = util.promisify(fs.unlink);

console.log('LOADING');

module.exports = {
  construct(self, options) {
    console.log('IN CONSTRUCT');
    self.addTask('backup', 'Backs up to a .zip file', async (apos, argv) => {
      if (!argv._[1]) {
        throw 'Usage: node app backup filename.zip';
      }
      const out = fs.createWriteStream(argv._[1]);
      await self.backup(out);
      await util.promisify(end)();

      function end(callback) {
        out.end(callback);
      }
    });
    // Returns promise (awaitable)
    self.backup = (output) => {
      return new Promise(async (resolve, reject) => {

        try {
          let error = false;

          output.on('close', function() {
            if (!error) {
              resolve();
            }
          });

          const archive = archiver('zip', {});

          archive.on('error', function(err) {
            error = true;
            return reject(err);
          });

          // pipe archive data to the file
          archive.pipe(output);

          const never = [ 'aposUsersSafe' ];

          const collections = (await self.apos.db.collections()).filter(collection => {
            if (collection.collectionName.match(/^system\./)) {
              return false;
            }
            if (never.includes(collection.collectionName)) {
              return false;
            }
            return true;
          });
          for (const collection of collections) {
            console.log(`** ${collection.collectionName}`);
            const criteria = (collection.collectionName === 'aposDocs') ? {
              type: {
                $nin: [ 'apostrophe-users', 'apostrophe-groups' ]
              }
            } : {};
            await self.apos.migrations.each(collection, criteria, doc => {
              archive.append(EJSON.stringify(doc), {
                name: `db/${collection.collectionName}/${doc._id}.json`
              });
            });
          }

          const copyOut = util.promisify(self.apos.attachments.uploadfs.copyOut);
          await self.apos.migrations.each(self.apos.attachments.db, {}, 5, async (attachment) => {
            if (error) {
              // Ignore the rest once we hit an error
              return;
            }
            const files = [];
            files.push(self.apos.attachments.url(attachment, {
              size: 'original',
              uploadfsPath: true
            }));
            for (const size of self.apos.attachments.imageSizes) {
              files.push(self.apos.attachments.url(attachment, {
                size: size.name,
                uploadfsPath: true
              }));
            }
            for (const crop of (attachment.crops || [])) {
              files.push(self.apos.attachments.url(attachment, {
                crop: crop,
                size: 'original',
                uploadfsPath: true
              }));
              for (const size of self.apos.attachments.imageSizes) {
                files.push(self.apos.attachments.url(attachment, {
                  crop: crop,
                  size: size.name,
                  uploadfsPath: true
                }));
              }
            }
            for (const file of files) {
              if (error) {
                break;
              }
              const tempPath = self.getTempPath(file);
              try {
                await copyOut(file, tempPath);
                await add(tempPath);
                function add() {
                  console.log(`** ${file}`);
                  return new Promise((resolve, reject) => {
                    if (fs.existsSync(tempPath)) {
                      const fileIn = fs.createReadStream(tempPath);
                      let closed = false;
                      fileIn.on('close', async () => {
                        if (!closed) {
                          closed = true;
                          try {
                            await unlink(tempPath);
                          } catch (e) {
                            return reject(e);
                          }
                          return resolve();
                        }
                      });
                      // TODO is there a way to avoid inefficient double zip encoding
                      // of compressed file types like GIF/JPG/PNG?
                      archive.append(fileIn, {
                        name: `uploads/${file}`
                      });
                    } else {
                      self.apos.util.error(`Unable to copy ${file} out to ${tempPath}, probably does not exist, continuing`);
                    }
                  });
                }
              } finally {
                if (fs.existsSync(tempPath)) {
                  await unlink(tempPath);
                }
              }
            }
          });
          console.log('** finalizing');
          archive.finalize();
        } catch (e) {
          reject(e);
        }
      });
    };
    // Returns promise (awaitable)
    self.restore = (input, { drop }) => {
      return new Promise(async (resolve, reject) => {
        if (drop) {
          const never = [ 'aposUsersSafe' ];
          const collections = (await self.apos.db.collections()).filter(collection => !collection.collectionName.match(/^system\./) && !never.includes(collection.collectionName));
          for (const collection of collections) {
            console.log(`** ${collection.collectionName}`);
            const criteria = (collection.collectionName === 'aposDocs') ? {
              type: {
                $nin: [ 'apostrophe-users', 'apostrophe-groups' ]
              }
            } : {};
            await collection.removeMany(criteria);
          }          
        }
        const copyIn = util.promisify(self.apos.attachments.uploadfs.copyIn);
        const collections = {};
        let error = false;
        input.pipe(unzipper.Parse())
        .on('entry', async (entry) => {
          const filename = entry.path;
          console.log(`** ${entry.path}`);
          if (entry.type !== 'File') {
            return;
          }
          if (filename.startsWith('db/')) {
            const collectionName = filename.substring(3);
            if (!collectionName.match(/\w/)) {
              throw new Error('Collection names must contain only letters, digits and underscores');
            }
            if (!collection[collectionName]) {
              collection[collectionName] = self.apos.db.collection(collectionName);
            }
            const parsed = EJSON.parse(await entry.buffer());
            await collection.replaceOne({
              _id: parsed._id
            }, parsed, {
              upsert: true
            });
          } else if (filename.startsWith('uploads/')) {
            const uploadfsPath = filename.substring('uploads/'.length);
            const tempPath = self.getTempPath(uploadfsPath);
            const output = fs.createWriteStream(tempPath);
            await pipe(entry, output);
            await copyIn(tempPath, uploadfsPath);          
          } else {
            self.apos.util.warn(`Warning: unexpected file path: ${filename}`);
            entry.autodrain();
          }
        })
        .on('close', () => {
          if (!error) {
            resolve();
          }
        })
        .on('error', (e) => {
          error = true;
          return reject(e);
        });
      });
    };

    self.getTempPath = (file) => {
      return self.apos.attachments.uploadfs.getTempPath() + '/' + self.apos.utils.generateId() + require('path').extname(file);
    };
  }
};
