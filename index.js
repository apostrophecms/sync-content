const fs = require('fs');
const { EJSON } = require('bson');
const util = require('util');
const archiver = require('archiver');
const unzipper = require('unzipper');
const unlink = util.promisify(fs.unlink);
const fetch = require('node-fetch');
const compression = require('compression');

const { chain }  = require('stream-chain');
const { parser } = require('stream-json');
const { streamValues } = require('stream-json/streamers/StreamValues');

module.exports = {
  construct(self, options) {
    console.log(self.action);
    self.apos.on('csrfExceptions', function(list) {
      list.push(`${self.action}/content`);
    });
    self.addTask('sync', 'Syncs content to or from another server environment', async (apos, argv) => {
      const peer = argv.from || argv.to;
      if (!peer) {
        throw 'You must specify either --from or --to.';
      }
      console.log(argv);
      if (argv.from && argv.to) {
        throw 'You must not specify both --from and --to (one end is always local).';
      }
      if (argv.from) {
        await self.syncFrom(argv.from);
      } else {
        await self.syncTo(argv.to);
      }
    });
    self.route('get', 'content', compression({
      filter: (req) => true
    }), async (req, res) => {
      if (!self.options.apiKey) {
        throw 'API key not configured';
      }
      const apiKey = getAuthorizationApiKey(req);
      if (apiKey !== self.options.apiKey) {
        throw 'Invalid API key';
      }
      // Ask nginx not to buffer this large response, better that it
      // flow continuously to the other end
      res.setHeader('X-Accel-Buffering', 'no');
      res.write(JSON.stringify({
        '@apostrophecms/sync-content': true,
        version: 1
      }));
      const never = [ 'aposUsersSafe', 'sessions', 'aposCache', 'aposDocVersions' ];
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
          return new Promise((resolve, reject) => {
            const sent = res.write(EJSON.stringify({
              collection: collection.collectionName,
              doc
            }));
            if (sent) {
              resolve();
            } else {
              console.log('draining');
              // Keep draining when the buffer is full to avoid using too much RAM
              res.once('drain', () => {
                console.log('drained');
                resolve();
              });
            }
          });
        });
      }
      console.log('after last collection');
      res.end();
    });
    // Returns promise (awaitable)
    self.syncFrom = (envName) => {
      console.log(`** ${envName}`);
      return new Promise(async (resolve, reject) => {
        const env = self.options.environments && self.options.environments[envName];
        if (!env) {
          throw new Error(`${envName} does not appear as a subproperty of the environments option`);
        }
        const response = await fetch(`${env.url}/modules/@apostrophecms/sync-content/content`, {
          headers: {
            'Authorization': `ApiKey ${env.apiKey}`
          }
        });
        if (response.status >= 400) {
          throw await response.text();
        }
        let version = null;
        const collections = {};
        const pipeline = chain([
          response.body,
          parser({
            jsonStreaming: true
          }),
          streamValues(),
          async (data) => {
            console.log('datum');
            const value = data.value;
            if (!version) {
              console.log('checking');
              if (!(value && (value['@apostrophecms/sync-content'] === true))) {
                throw 'This response does not contain an @apostrophecms/sync-content stream';
              }
              if (value.version !== 1) {
                throw `This site does not support stream version ${value.version}`;
              }
              console.log('hmm');
              version = value.version;
              const never = [ 'aposUsersSafe', 'sessions', 'aposCache', 'aposLocks', 'aposNotifications', 'aposBlessings', 'aposDocVersions' ];
              // Purge
              const collections = (await self.apos.db.collections()).filter(collection => !collection.collectionName.match(/^system\./) && !never.includes(collection.collectionName));
              console.log('purging');
              for (const collection of collections) {
                console.log(`** ${collection.collectionName}`);
                const criteria = (collection.collectionName === 'aposDocs') ? {
                  type: {
                    $nin: [ 'apostrophe-users', 'apostrophe-groups' ]
                  }
                } : {};
                await collection.removeMany(criteria);
              }
              console.log('after purging');
              console.log('ready for docs');
            } else if (value.collection) {
              if (!collections[value.collection]) {
                collections[value.collection] = self.apos.db.collection(value.collection);
              }
              const collection = collections[value.collection];
              await collection.replaceOne({
                _id: value.doc._id
              }, EJSON.parse(JSON.stringify(value.doc)), {
                upsert: true
              });
            } else {
              throw 'Unexpected object in JSON stream';
            }
          }
        ]);
        pipeline.on('end', () => {
          console.log('end event');
          if (!version) {
            return reject('This response does not contain an @apostrophecms/sync-content stream');
          }
          console.log('resolving');
          return resolve();
        });
        pipeline.on('error', (e) => {
          return reject(e);
        });
      });
    };

      // return new Promise(async (resolve, reject) => {

      //   try {
      //     let error = false;

      //     output.on('close', function() {
      //       if (!error) {
      //         resolve();
      //       }
      //     });

      //     const archive = archiver('zip', {});

      //     archive.on('error', function(err) {
      //       error = true;
      //       return reject(err);
      //     });

      //     // pipe archive data to the file
      //     archive.pipe(output);



      //     const copyOut = util.promisify(self.apos.attachments.uploadfs.copyOut);
      //     await self.apos.migrations.each(self.apos.attachments.db, {}, 5, async (attachment) => {
      //       if (error) {
      //         // Ignore the rest once we hit an error
      //         return;
      //       }
      //       const files = [];
      //       files.push(self.apos.attachments.url(attachment, {
      //         size: 'original',
      //         uploadfsPath: true
      //       }));
      //       for (const size of self.apos.attachments.imageSizes) {
      //         files.push(self.apos.attachments.url(attachment, {
      //           size: size.name,
      //           uploadfsPath: true
      //         }));
      //       }
      //       for (const crop of (attachment.crops || [])) {
      //         files.push(self.apos.attachments.url(attachment, {
      //           crop: crop,
      //           size: 'original',
      //           uploadfsPath: true
      //         }));
      //         for (const size of self.apos.attachments.imageSizes) {
      //           files.push(self.apos.attachments.url(attachment, {
      //             crop: crop,
      //             size: size.name,
      //             uploadfsPath: true
      //           }));
      //         }
      //       }
      //       for (const file of files) {
      //         if (error) {
      //           break;
      //         }
      //         const tempPath = self.getTempPath(file);
      //         try {
      //           await copyOut(file, tempPath);
      //           await add(tempPath);
      //           function add() {
      //             console.log(`** ${file}`);
      //             return new Promise((resolve, reject) => {
      //               if (fs.existsSync(tempPath)) {
      //                 const fileIn = fs.createReadStream(tempPath);
      //                 let closed = false;
      //                 fileIn.on('close', async () => {
      //                   if (!closed) {
      //                     closed = true;
      //                     try {
      //                       await unlink(tempPath);
      //                     } catch (e) {
      //                       return reject(e);
      //                     }
      //                     return resolve();
      //                   }
      //                 });
      //                 // TODO is there a way to avoid inefficient double zip encoding
      //                 // of compressed file types like GIF/JPG/PNG?
      //                 archive.append(fileIn, {
      //                   name: `uploads/${file}`
      //                 });
      //               } else {
      //                 self.apos.util.error(`Unable to copy ${file} out to ${tempPath}, probably does not exist, continuing`);
      //               }
      //             });
      //           }
      //         } finally {
      //           if (fs.existsSync(tempPath)) {
      //             await unlink(tempPath);
      //           }
      //         }
      //       }
      //     });
      //     console.log('** finalizing');
      //     archive.finalize();
      //   } catch (e) {
      //     reject(e);
      //   }
      // });

      // Returns promise (awaitable)
    // self.restore = (input, { drop }) => {
    //   return new Promise(async (resolve, reject) => {
    //     if (drop) {
    //       const never = [ 'aposUsersSafe' ];
    //       const collections = (await self.apos.db.collections()).filter(collection => !collection.collectionName.match(/^system\./) && !never.includes(collection.collectionName));
    //       for (const collection of collections) {
    //         console.log(`** ${collection.collectionName}`);
    //         const criteria = (collection.collectionName === 'aposDocs') ? {
    //           type: {
    //             $nin: [ 'apostrophe-users', 'apostrophe-groups' ]
    //           }
    //         } : {};
    //         await collection.removeMany(criteria);
    //       }          
    //     }
    //     const copyIn = util.promisify(self.apos.attachments.uploadfs.copyIn);
    //     const collections = {};
    //     let error = false;
    //     input.pipe(unzipper.Parse())
    //     .on('entry', async (entry) => {
    //       const filename = entry.path;
    //       console.log(`** ${entry.path}`);
    //       if (entry.type !== 'File') {
    //         return;
    //       }
    //       if (filename.startsWith('db/')) {
    //         const collectionName = filename.substring(3);
    //         if (!collectionName.match(/\w/)) {
    //           throw new Error('Collection names must contain only letters, digits and underscores');
    //         }
    //         if (!collection[collectionName]) {
    //           collection[collectionName] = self.apos.db.collection(collectionName);
    //         }
    //         const parsed = EJSON.parse(await entry.buffer());
    //         await collection.replaceOne({
    //           _id: parsed._id
    //         }, parsed, {
    //           upsert: true
    //         });
    //       } else if (filename.startsWith('uploads/')) {
    //         const uploadfsPath = filename.substring('uploads/'.length);
    //         const tempPath = self.getTempPath(uploadfsPath);
    //         const output = fs.createWriteStream(tempPath);
    //         await pipe(entry, output);
    //         await copyIn(tempPath, uploadfsPath);          
    //       } else {
    //         self.apos.util.warn(`Warning: unexpected file path: ${filename}`);
    //         entry.autodrain();
    //       }
    //     })
    //     .on('close', () => {
    //       if (!error) {
    //         resolve();
    //       }
    //     })
    //     .on('error', (e) => {
    //       error = true;
    //       return reject(e);
    //     });
    //   });
    // };

    self.getTempPath = (file) => {
      return self.apos.attachments.uploadfs.getTempPath() + '/' + self.apos.utils.generateId() + require('path').extname(file);
    };
  }
};

function getAuthorizationApiKey(req) {
  const header = req.headers.authorization;
  if (!header) {
    return null;
  }
  const matches = header.match(/^ApiKey\s+(\S.*)$/i);
  if (!matches) {
    return null;
  }
  return matches[1];
}
