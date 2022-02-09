const fs = require('fs');
const { EJSON } = require('bson');
const util = require('util');
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
    require('./lib/findJoins')(self, options);
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
      if (argv.type) {
        argv.related = self.apos.launder.boolean(argv.related, true);
        argv.keep = self.apos.launder.boolean(argv.keep);
        argv.query = qs.parse(self.apos.launder.string(argv.query));
      } else {
        if (argv.related) {
          throw '--related not available without --type';
        }
        if (argv.keep) {
          throw '--keep not available without --type';
        }
        if (argv.query) {
          throw '--query not available without --type';
        }
      }
      if (argv.from) {
        const env = self.getEnv(argv.from, argv);
        await self.syncFrom(env, argv);
      } else if (argv.to) {
        throw '--to is not yet implemented';
      } else {
        throw '--from is required';
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
        const type = self.apos.launder.string(req.query.type);
        const related = self.apos.launder.boolean(req.query.related);
        // Naming it req.query.workflowLocale causes it to be stolen by
        // the workflow module, so we don't do that
        const workflowLocale = self.apos.launder.string(req.query.locale);
        const query = (typeof req.query.query === 'object') ? req.query.query : null;
        if (!type) {
          if (related) {
            throw 'related is only permitted with type';
          }
          if (query) {
            throw 'query is only permitted with type';
          }
        }
        // Ask nginx not to buffer this large response, better that it
        // flow continuously to the other end
        res.setHeader('X-Accel-Buffering', 'no');
        res.write(JSON.stringify({
          '@apostrophecms/sync-content': true,
          version: 1
        }));
        const never = self.neverCollections;
        const docs = self.getCollection('aposDocs');
        const collections = type ? [ docs ] : (await self.apos.db.collections()).filter(collection => {
          if (collection.collectionName.match(/^system\./)) {
            return false;
          }
          if (never.includes(collection.collectionName)) {
            return false;
          }
          return true;
        });
        let attachmentIds = [];
        for (const collection of collections) {
          await handleCollection(collection);
        }
        if (attachmentIds.length) {
          await handleCollection(self.getCollection('aposAttachments'), attachmentIds);
        }
        async function handleCollection(collection, ids) {
          const seen = new Set();
          if (query && (collection.collectionName === 'aposDocs') && !ids) {
            const manager = self.apos.docs.getManager(type);
            const reqParams = {};
            if (workflowLocale) {
              reqParams.locale = workflowLocale;
            }
            const criteria = {};
            ids = (await manager.find(self.apos.tasks.getReq(reqParams), {}, { _id: 1 })
              .queryToFilters(query, 'manage')
              .toArray())
              .map(doc => doc._id);
          }
          const criteria = ids ? {
            _id: {
              $in: ids
            }
          } : ((collection.collectionName === 'aposDocs') && type) ? {
            type
          } : (collection.collectionName === 'aposDocs') ? {
            type: {
              $nin: self.neverTypes
            }
          } : {};
          if ((collection.collectionName === 'aposDocs') && workflowLocale) {
            criteria.workflowLocale = {
              $in: [ null, workflowLocale ]
            };
          }
          await self.apos.migrations.each(collection, criteria, async (doc) => {
            // "sent" keeps track of whether we have started to buffer
            // output in RAM, if we have then after this batch we'll
            // wait for the output to drain
            await write(doc);
            if (type && (collection.collectionName === 'aposDocs')) {
              attachmentIds = attachmentIds.concat(self.apos.attachments.all(doc).map(attachment => attachment._id));
            }
            if (related && (collection.collectionName === 'aposDocs')) {
              const joins = self.findJoinsInDoc(doc);
              let ids = [];
              for (const join of joins) {
                const id = join.field.idField && join.doc[join.field.idField];
                if (id) {
                  ids.push(id);
                }
                const joinIds = join.field.idsField && join.doc[join.field.idsField];
                if (joinIds) {
                  ids = ids.concat(joinIds);
                }
              }
              const relatedDocs = await collection.find({
                _id: {
                  $in: ids
                },
                type: {
                  $nin: self.neverTypes
                },
                // Pages are never considered related for this purpose
                // because it leads to data integrity issues
                slug: /^[^\/]/
              }).toArray();
              for (const relatedDoc of relatedDocs) {
                if (type) {
                  attachmentIds = attachmentIds.concat(self.apos.attachments.all(relatedDoc).map(attachment => attachment._id));
                }
                await write(relatedDoc);
              }
            }
          });
          async function write(doc) {
            if (seen.has(doc._id)) {
              // Don't send a related doc twice
              return;
            }
            seen.add(doc._id);
            return new Promise((resolve, reject) => {
              try {
                const result = res.write(EJSON.stringify({
                  collection: collection.collectionName,
                  doc
                }));
                if (!result) {
                  // Node streams backpressure is fussy, you don't get a
                  // drain event for the second of two consecutive false returns,
                  // we must wait every time we do get one
                  res.once('drain', () => {
                    return resolve();
                  });
                } else {
                  return resolve();
                }
              } catch (e) {
                return reject(e);
              }
            });
          }
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
          throw self.apos.utils.error('invalid');
        }
        if (!disabled) {
          let url = self.apos.attachments.uploadfs.getUrl() + path;
          if (url.startsWith('/') && !url.startsWith('//') && req.baseUrl) {
            url = req.baseUrl + url;
          }
          return res.redirect(url);
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

    self.syncFrom = async (env, options) => {
      if (env.url.endsWith('/')) {
        throw 'URL for environment must not end with /, should be a base URL for the site';
      }
      const updatePermissions = util.promisify(self.apos.attachments.updatePermissions);
      let ended = false;
      if (!options.type) {
        if (options.keep) {
          throw 'keep option not available without type option';
        }
        if (options.related) {
          throw 'related option not available without type option';
        }
      }
      const query = qs.stringify({
        type: options.type,
        keep: !!options.keep,
        related: !!options.related,
        // We have to rename this one in the query string to work around
        // the fact that the workflow module steals it otherwise
        locale: options.workflowLocale,
        query: options.query
      });
      const response = await fetch(`${env.url}/modules/@apostrophecms/sync-content/content?${query}`, {
        headers: {
          'Authorization': `ApiKey ${env.apiKey}`
        }
      });
      if (response.status >= 400) {
        throw await response.text();
      }
      let version = null;
      const collections = {};
      let docIds = [];
      
      // This solution with a custom writable stream appears to handle backpressure properly,
      // several others appeared prettier but did not do that, so they would exhaust RAM
      // on a large site

      const sink = new Stream.Writable({
        objectMode: true
      });
      let attachmentIds = [];
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

      await self.syncUploadfsFrom(env, { attachmentIds });
      // Fix attachment permissions once all the facts are in
      await updatePermissions();

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
          if (!options.type) {
            const collections = (await self.apos.db.collections()).filter(collection => !collection.collectionName.match(/^system\./) && !never.includes(collection.collectionName));
            for (const collection of collections) {
              const criteria = (collection.collectionName === 'aposDocs') ? {
                type: {
                  $nin: self.neverTypes
                }
              } : {};
              await collection.removeMany(criteria);
            }
          } else if (!options.keep) {
            // TODO attachments need to update their references when this happens
            await self.apos.docs.db.removeMany({
              type: options.type
            });
          }
        } else if (value.collection) {
          if (!collections[value.collection]) {
            collections[value.collection] = self.getCollection(value.collection);
          }
          const collection = collections[value.collection];
          try {
            value.doc = EJSON.parse(JSON.stringify(value.doc));
            if (value.collection === 'aposDocs') {
              docIds.push(value.doc._id);
            }
            if ((value.collection === 'aposAttachments') && options.type) {
              await self.mergeAttachment(value.doc, docIds);
              attachmentIds.push(value.doc._id);
            } else {
              for (let attempt = 0; (attempt < 10); attempt++) {
                try {
                  if (options.keep) {
                    await collection.replaceOne(
                      {
                        _id: value.doc._id
                      },
                      value.doc,
                      {
                        upsert: true
                      }
                    );
                  } else {
                    await collection.insertOne(value.doc);
                  }
                  // This is A2, so when only one locale is synced
                  // we must always match draft with live or vice versa
                  if (query.locale && value.doc.workflowGuid) {
                    const isDraft = query.locale.includes('-draft');
                    const peerLocale = query.locale.includes('-draft') ? query.locale.replace('-draft', '') : (query.locale + '-draft');
                    const existing = await collections.findOne({
                      workflowGuid: value.doc.workflowGuid,
                      workflowLocale: peerLocale
                    });
                    if (existing) {
                      await collections.replaceOne({
                        workflowGuid: value.doc.workflowGuid,
                        workflowLocale: peerLocale
                      }, {
                        ...value.doc,
                        workflowLocale: value.doc.workflowLocale,
                        _id: existing._id
                      });
                    } else {
                      await collections.insertOne({
                        ...value.doc,
                        workflowLocale: value.doc.workflowLocale,
                        _id: self.apos.utils.generateId()
                      });
                    }
                  }
                } catch (e) {
                  if ((collection.collectionName === 'aposDocs') && self.apos.docs.isUniqueError(e)) {
                    value.doc.slug += Math.floor(Math.random() * 10);
                    continue;
                  } else {
                    throw e;
                  }
                }
                break;
              }
            }
          } catch (e) {
            console.error(JSON.stringify(value, null, '  '));
            throw e;
          }
        } else if (value.end) {
          ended = true;
        } else {
          console.error(value);
          throw 'Unexpected object in JSON stream';
        }
        return true;
      }
    };

    self.mergeAttachment = async (attachment, docIds) => {
      // Merge what the sending and receiving sites know about docIds and trashDocIds to
      // ensure updatePermissions does the right thing for this attachment
      const existing = await self.apos.attachments.db.findOne({
        _id: attachment._id
      });
      const newDocIds = attachment.docIds.filter(id => docIds.includes(id));
      const newTrashDocIds = attachment.trashDocIds.filter(id => docIds.includes(id));
      if (!existing) {
        attachment.docIds = newDocIds;
        attachment.trashDocIds = newTrashDocIds;
        return self.apos.attachments.db.insertOne(attachment);
      }
      const oldDocIds = existing.docIds.filter(id => !docIds.includes(id));
      const oldTrashDocIds = attachment.trashDocIds.filter(id => !docIds.includes(id));
      attachment.docIds = newDocIds.concat(oldDocIds);
      attachment.trashDocIds = newTrashDocIds.concat(oldTrashDocIds);
      await self.apos.attachments.db.replaceOne({
        _id: attachment._id
      }, attachment);
    };

    self.syncUploadfsFrom = async (env, { attachmentIds }) => {

      const disable = util.promisify(self.apos.attachments.uploadfs.disable);
      const remove = util.promisify(self.apos.attachments.uploadfs.remove);
      const copyIn = util.promisify(self.apos.attachments.uploadfs.copyIn);
      const criteria = (options.type && attachmentIds) ? {
        _id: {
          $in: attachmentIds
        }
      } : {};
      await self.apos.migrations.each(self.apos.attachments.db, criteria, 5, async (attachment) => {
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

    self.getEnv = (envName, argv) => {
      if (envName.match(/^https?:/)) {
        if (!argv['api-key']) {
          throw '--api-key is required if --from specifies a URL';
        }
        return {
          label: envName,
          url: envName,
          apiKey: argv['api-key']
        };
      }

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
    self.getCollection = (name) => {
      const collection = self.apos.db.collection(name);
      // Should not be necessary according to the mongodb docs, but when
      // this method is used to obtain a collection object we don't get
      // a collectionName property
      collection.collectionName = name;
      return collection;
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
