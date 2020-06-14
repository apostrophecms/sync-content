const moment = require('moment');
const mkdirp = require('mkdirp');
const bson = require('bson');
const stream = require('stream');
const BsonStream = require('bson-stream');
const pipeline = require('util').promisify(stream.pipeline);
const zlib = require('zlib');
const BsonSerializeTransform = require('./lib/bson-serialize-transform');
const fs = require('fs');

module.exports = {
  construct: (self, options) => {
    self.backup = async (req, options) => {
      const db = self.apos.db;
      const collections = await db.collections();
      const name = moment().format('YYYY-MM-DD-HH-i-s');
      const dir = `${self.apos.rootDir}/data/temp/${name}`;
      console.log(dir);
      mkdirp.sync(dir);
      for (const collection of collections) {
        if (collection.collectionName.match(/^system\./)) {
          continue;
        }
        await self.backupCollection(dir, collection);
      }
    };
    self.backupCollection = async (dir, collection) => {
      const read = collection.find();
      const transform = new BsonSerializeTransform({});
      const write = fs.createWriteStream(`${dir}/${collection.collectionName}.bson`);
      await pipeline(read, transform, zlib.createGzip(), write);
    };
    self.restoreCollection = async (dir, collection) => {
      const transform = new BsonStream({});
      const read = fs.createReadStream(`${dir}/${collection.collectionName}.bson`);
      await pipeline(read, zlib.createGunzip(), transform, write);
    };
    self.addTask('backup', 'Back up the site', async function() {
      const req = self.apos.tasks.getReq();
      await self.backup(req);
    });
  }
};
