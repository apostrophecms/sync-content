const moment = require('moment');
const mkdirp = require('mkdirp');
const stream = require('stream');
const tar = require('tar-stream');
const BsonStream = require('bson-stream');
const pipeline = require('util').promisify(stream.pipeline);
const zlib = require('zlib');
const BsonSerializeTransform = require('./lib/bson-serialize-transform');
const fs = require('fs');

module.exports = {
  construct: (self, options) => {
    // options.output is required (the stream to write the tarball to)
    self.backup = async (req, options) => {
      const db = self.apos.db;
      const pack = tar.pack();
      const collections = await db.collections();
      const name = moment().format('YYYY-MM-DD-HH-i-s');
      const dir = `${self.apos.rootDir}/data/temp/${name}`;
      mkdirp.sync(dir);
      const promise = pipeline(pack, options.output);
      for (const collection of collections) {
        if (collection.collectionName.match(/^system\./)) {
          continue;
        }
        await self.backupCollection(pack, dir, collection);
      }
      const attachmentsStatus = await self.backupAttachments(pack, dir);
      if (attachmentsStatus.failed) {
        notify(req, `
No attachments were backed up successfully, even though some are listed in
the database. You may be backing up a server from which all media have
already been deleted.`);
      } else if (attachmentsStatus.regularFailed) {
        notify(req, `
${attachmentsStatus.regularFailed} ordinary files failed to copy from uploadfs.

This may mean network errors occurred, the disk is full, or this server is
missing some of the file attachments claimed to exist in its database.`, { type: 'error' });
      } else if (attachmentsStatus.trashFailed) {
        notify(req, `
${attachmentsStatus.trashFailed} files considered part of the "trash" failed to copy from uploadfs.
        
This usually means you are using local uploadfs file storage without
disabledFileKey, which is not best practice. Files in the "trash" will be
missing from the backup. See the Apostrophe documentation for more
information about migrating to disabledFileKey correctly.`);
      }
      await self.emit('backupExtras', {
        req,
        options,
        pack,
        dir
      });
      pack.finalize();
      await promise;
      fs.rmdirSync(dir);
      function notify(req, msg, options) {
        if (req.user && req.user._id) {
          apos.notify(req, msg, options);
        } else {
          if (msg.type === 'error') {
            console.error(msg);
          } else {
            console.log(msg);
          }
        }
      }
    };
    // options.input is required (the stream to read the tarball from).
    // Awaitable (returns a promise)
    self.restore = (req, options) => {
      // don't forget to first remove old attachments and then the db
      const db = self.apos.db;
      const extract = tar.extract();
      const promise = new Promise(reject, resolve);
      extract.on('entry', async (header, stream, next) => {
        const dbMatches = header.name.match(/^\/db\/(.*?)\.bson\.gz/);
        if (dbMatches) {
          try {
            await self.extractCollection(req, matches[1], stream);
            return next();
          } catch (e) {
            return reject(e);
          }
        }
        const uploadfsMatches = header.name.match(/^\/uploadfs(.*)$/);
        if (uploadfsMatches) {
                  
        }
        if (header.name.match()
        stream.on('end', function() {
          next() // ready for next entry
        })
       
        stream.resume() // just auto drain the stream
      })      
      const collections = await db.collections();
      const name = moment().format('YYYY-MM-DD-HH-i-s');
      const dir = `${self.apos.rootDir}/data/temp/${name}`;
      mkdirp.sync(dir);
      const promise = pipeline(pack, options.output);
      for (const collection of collections) {
        if (collection.collectionName.match(/^system\./)) {
          continue;
        }
        await self.backupCollection(pack, dir, collection);
      }
      const attachmentsStatus = await self.backupAttachments(pack, dir);
      if (attachmentsStatus.failed) {
        notify(req, `
No attachments were backed up successfully, even though some are listed in
the database. You may be backing up a server from which all media have
already been deleted.`);
      } else if (attachmentsStatus.regularFailed) {
        notify(req, `
${attachmentsStatus.regularFailed} ordinary files failed to copy from uploadfs.

This may mean network errors occurred, the disk is full, or this server is
missing some of the file attachments claimed to exist in its database.`, { type: 'error' });
      } else if (attachmentsStatus.trashFailed) {
        notify(req, `
${attachmentsStatus.trashFailed} files considered part of the "trash" failed to copy from uploadfs.
        
This usually means you are using local uploadfs file storage without
disabledFileKey, which is not best practice. Files in the "trash" will be
missing from the backup. See the Apostrophe documentation for more
information about migrating to disabledFileKey correctly.`);
      }
      await self.emit('backupExtras', {
        req,
        options,
        pack,
        dir
      });
      pack.finalize();
      await promise;
      fs.rmdirSync(dir);
      function notify(req, msg, options) {
        if (req.user && req.user._id) {
          apos.notify(req, msg, options);
        } else {
          if (msg.type === 'error') {
            console.error(msg);
          } else {
            console.log(msg);
          }
        }
      }
    };
    self.backupCollection = async (pack, dir, collection) => {
      const read = collection.find();
      const transform = new BsonSerializeTransform({});
      const path = `${dir}/${collection.collectionName}.bson.gz`;
      const write = fs.createWriteStream(path);
      await pipeline(read, transform, zlib.createGzip(), write);
      const entry = pack.entry({
        name: `/db/${collection.collectionName}.bson.gz`,
        size: fs.statSync(path).size
      });
      const read2 = fs.createReadStream(path);
      await pipeline(read2, entry);
      fs.unlinkSync(path);
    };
    self.restoreCollection = async (dir, collection) => {
      const transform = new BsonStream({});
      const read = fs.createReadStream(`${dir}/${collection.collectionName}.bson.gz`);
      await pipeline(read, zlib.createGunzip(), transform, write);
    };
    // TODO trash doesn't work with disabledFileKey either because I'm not using the
    // hash mechanism to derive the right thing to copyOut.
    self.backupAttachments = async (pack, dir) => {
      const copyOut = require('util').promisify(self.apos.attachments.uploadfs.copyOut);
      const status = {
        succeeded: 0,
        trashFailed: 0,
        regularFailed: 0
      };
      await self.apos.migrations.each(self.apos.attachments.db, {}, 1, async attachment => {
        try {
          if (attachment.group === 'image') {
            // Remember: all the sizes of all the crops plus regular, except when svg
            for (const size of self.apos.attachments.imageSizes) {
              const path = self.apos.attachments.url(attachment, {
                uploadfsPath: true,
                size
              });
              await copyOutOne(path);
            }
            for (const crop of attachment.crops) {
              for (const size of self.apos.attachments.imageSizes) {
                const path = self.apos.attachments.url(attachment, {
                  uploadfsPath: true,
                  size,
                  crop
                });
                await copyOutOne(path);
              }
              // cropped "original"
              const path = self.apos.attachments.url(attachment, {
                uploadfsPath: true,
                crop
              });
              await copyOutOne(path);
            }
          }
          // Always get the true original
          const path = self.apos.attachments.url(attachment, {
            uploadfsPath: true
          });
          await copyOutOne(path);
          status.succeeded++;
        } catch (e) {
          if (attachment.trash) {
            status.trashFailed++;
          } else {
            status.regularFailed++;
          }
        }
      });
      if ((!status.succeeded) && (status.regularFailed)) {
        status.failed = true;
      }
      return status;
      async function copyOutOne(path) {
        const tmp = `${dir}/tmp`;
        await copyOut(path, tmp);
        const entry = pack.entry({
          name: `/uploadfs/attachments/${require('path').basename(path)}`,
          size: fs.statSync(tmp).size
        });
        const read2 = fs.createReadStream(tmp);
        await pipeline(read2, entry);
        fs.unlinkSync(tmp);
      }
    };
    self.addTask('backup', 'Back up the site', async function(apos, argv) {
      if (!argv.output) {
        throw 'You must specify --output=some-filename.tar';
      }
      const req = self.apos.tasks.getReq();
      const output = fs.createWriteStream(argv.output);
      await self.backup(req, {
        output
      });
    });
  }
};
