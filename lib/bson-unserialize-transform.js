const Transform = require('stream').Transform;
const bson = require('bson');

module.exports = class BSONUnserializeTransform {
  construct(options) {
    options.objectMode = true;
    this.super(options);
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
