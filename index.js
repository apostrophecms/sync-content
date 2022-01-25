const fs = require('fs');
const { EJSON } = require('bson');
const util = require('util');
const archiver = require('archiver');
const unzipper = require('unzipper');
const unlink = util.promisify(fs.unlink);
const fetch = require('node-fetch');
const compression = require('compression');
const pipeline = require('util').promisify(require('stream').pipeline);
const Stream = require('stream');
const { parser } = require('stream-json');
const { streamValues } = require('stream-json/streamers/StreamValues');
const qs = require('qs');

module.exports = {
  construct(self, options) {
    self.neverCollections = [ 'aposUsersSafe', 'sessions', 'aposCache', 'aposLocks', 'aposNotifications', 'aposBlessings', 'aposDocVersions' ];
    self.neverTypes = [ 'apostrophe-user', 'apostrophe-group' ];
    self.apos.on('csrfExceptions', function(list) {
      // For syncTo and the POST routes
      list.push(`${self.action}/content`);
      list.push(`${self.action}/uploadfs`);
    });
    self.addTask('sync', 'Syncs content to or from another server environment', async (apos, argv) => {
      const peer = argv.from || argv.to;
      if (!peer) {
        throw 'You must specify either --from or --to.';
      }
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
      try {
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
        const never = self.neverCollections;
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
          const criteria = (collection.collectionName === 'aposDocs') ? {
            type: {
              $nin: self.neverTypes
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
                // Keep draining when the buffer is full to avoid using too much RAM
                res.once('drain', () => {
                  resolve();
                });
              }
            });
          });
        }
        res.write(JSON.stringify({
          'end': true
        }));
        res.end();
      } catch (e) {
        self.apos.utils.error(e);
        return res.status(400).send('invalid');
      }
    });

    self.route('get', 'uploadfs', async (req, res) => {
      const disable = util.promisify(self.apos.attachments.uploadfs.disable);
      const enable = util.promisify(self.apos.attachments.uploadfs.enable);
      const copyOut = util.promisify(self.apos.attachments.uploadfs.copyOut);
      try {
        self.checkAuthorizationApiKey(req);
        const path = self.apos.launder.string(req.query.path);
        const disabled = self.apos.launder.boolean(req.query.disabled);
        if (!path.length) {
          throw self.apos.error('invalid');
        }
        if (!disabled) {
          return res.redirect(self.apos.attachments.uploadfs.getUrl(path));
        } else {
          const tempPath = self.getTempPath(path);
          // This workaround is not ideal, in future uploadfs will provide
          // better guarantees that copyOut works when direct URL access does not
          await enable(path);
          await copyOut(path, tempPath);
          await disable(path);
          res.on('finish', async () => {
            await unlink(tempPath);
          });
          return res.download(tempPath);
        }
      } catch (e) {
        self.apos.utils.error(e);
        return res.status(400).send('invalid');
      }
    });

    // Returns promise (awaitable)
    self.syncFrom = async (envName) => {
      let ended = false;
      const env = self.getEnv(envName);
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
      
      // This solution with a custom writable stream appears to handle backpressure properly,
      // several others appeared prettier but did not do that, so they would exhaust RAM
      // on a large site

      const sink = new Stream.Writable({
        objectMode: true
      });
      sink._write = async (value, encoding, callback) => {
        try {
          await handleObject(value);
          return callback(null);
        } catch (e) {
          return callback(e);
        }
      };

      await pipeline(
        response.body,
        parser({
          jsonStreaming: true
        }),
        streamValues(),
        sink
      );

      if (!ended) {
        throw 'Incomplete stream';
      }

      await self.syncUploadfsFrom(envName);

      async function handleObject(value) {
        value = value.value;
        if (!version) {
          if (!(value && (value['@apostrophecms/sync-content'] === true))) {
            throw 'This response does not contain an @apostrophecms/sync-content stream';
          }
          if (value.version !== 1) {
            throw `This site does not support stream version ${value.version}`;
          }
          version = value.version;
          const never = self.neverCollections;
          // Purge
          const collections = (await self.apos.db.collections()).filter(collection => !collection.collectionName.match(/^system\./) && !never.includes(collection.collectionName));
          for (const collection of collections) {
            const criteria = (collection.collectionName === 'aposDocs') ? {
              type: {
                $nin: self.neverTypes
              }
            } : {};
            await collection.removeMany(criteria);
          }
        } else if (value.collection) {
          if (!collections[value.collection]) {
            collections[value.collection] = self.apos.db.collection(value.collection);
          }
          const collection = collections[value.collection];
          try {
            value.doc = EJSON.parse(JSON.stringify(value.doc));
            await collection.insertOne(
              value.doc
            );
          } catch (e) {
            console.error(JSON.stringify(value, null, '  '));
            throw e;
          }
        } else if (value.end) {
          ended = true;
        } else {
          throw 'Unexpected object in JSON stream';
        }
        return true;
      }
    };

    self.syncUploadfsFrom = async (envName) => {

      const env = self.getEnv(envName);

      const disable = util.promisify(self.apos.attachments.uploadfs.disable);
      const remove = util.promisify(self.apos.attachments.uploadfs.remove);
      const copyIn = util.promisify(self.apos.attachments.uploadfs.copyIn);
      await self.apos.migrations.each(self.apos.attachments.db, {}, 5, async (attachment) => {
        const files = [];
        push(attachment, 'original', null);
        for (const size of self.apos.attachments.imageSizes) {
          push(attachment, size.name, null);
        }
        for (const crop of (attachment.crops || [])) {
          push(attachment, 'original', crop);
          for (const size of self.apos.attachments.imageSizes) {
            push(attachment, size.name, crop);
          }
        }
        for (const file of files) {
          const tempPath = self.getTempPath(file.path);
          await attempt(false);
          async function attempt(retryingDisabled) {
            try {
              const params = qs.stringify({
                ...file,
                disabled: retryingDisabled ? !file.disabled : file.disabled
              });
              const response = await fetch(`${env.url}/modules/@apostrophecms/sync-content/uploadfs?${params}`, {
                headers: {
                  'Authorization': `ApiKey ${env.apiKey}`
                }
              });
              if (response.status !== 200) {
                throw response.status;
              }
              await pipeline(
                response.body,
                fs.createWriteStream(tempPath)
              );
              try {
                await remove(file.path);
              } catch (e) {
                // Nonfatal, we are just making sure we don't get into conflict
                // with previous permissions settings if the receiving site
                // did have this file
              }
              await copyIn(tempPath, file.path);
              if (file.disabled) {
                await disable(file.path);
              }
            } catch (e) {
              if (!retryingDisabled) {
                // Work around the fact that the disabled state of the file
                // sometimes does not match what is expected on the sending end,
                // possibly due to an A2 bug. This way the receiving end gets
                // to the right outcome either way
                return await attempt(true);
              }
              // Missing attachments are not unusual and should not flunk the entire process
              self.apos.utils.error(`Error fetching uploadfs path ${file.path}, continuing:`);
              self.apos.utils.error(e);    
            } finally {
              if (fs.existsSync(tempPath)) {
                await unlink(tempPath);
              }
            }
          }
        }
        function push(attachment, size, crop) {
          files.push({
            path: self.apos.attachments.url(attachment, {
              size,
              uploadfsPath: true,
              crop
            }),
            disabled: attachment.trash && (size !== self.apos.attachments.sizeAvailableInTrash)
          });
        }
      });
    };

    self.getTempPath = (file) => {
      return self.apos.attachments.uploadfs.getTempPath() + '/' + self.apos.utils.generateId() + require('path').extname(file);
    };

    self.getEnv = (envName) => {
      const env = self.options.environments && self.options.environments[envName];
      if (!env) {
        throw new Error(`${envName} does not appear as a subproperty of the environments option`);
      }
      return env;
    };
    self.checkAuthorizationApiKey = (req) => {
      if (!self.options.apiKey) {
        throw 'API key not configured';
      }
      const apiKey = getAuthorizationApiKey(req);
      if (apiKey !== self.options.apiKey) {
        throw 'Invalid API key';
      }
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
