const Transform = require('stream').Transform;
const bson = require('bson');

module.exports = class BSONSerializeTransform extends Transform {
  constructor(options) {
    options.writableObjectMode = true;
    options.readableObjectMode = false;
    super(options);
  }
  _transform(obj, encoding, callback) {
    try {
      this.push(bson.serialize(obj));
    } catch (e) {
      return callback(e);
    }
    return callback(null);
  }
};
